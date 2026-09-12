import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { XbergAdapter, createXbergNormalization, decodeXbergOutput } from "../../../server/ingestion/xberg";
import { XbergProcessWorker } from "../../../server/ingestion/xberg-worker";

const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const input = (text = "captured", filename = "notes/source.html") => {
  const data = bytes(text); return { path: filename, bytes: data, contentHash: hash(data) };
};
const output = (extra = {}) => JSON.stringify({ result: { content: "# Extracted", metadata: { output_format: "markdown" }, ...extra } });

async function executable(t: { after: (fn: () => Promise<void>) => void }, script: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-xberg-test-"));
  const file = path.join(root, "fake-xberg");
  await fs.writeFile(file, `#!${process.execPath}\n${script}`, { mode: 0o700 });
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { root, file };
}

test("adapter stages captured bytes, isolates configuration, records version and cleans temporary files", async (t) => {
  const fake = await executable(t, `
    const fs = require('node:fs');
    if (process.argv[2] === '--version') console.log('xberg 1.1.5');
    else console.log(JSON.stringify({result:{content:'---\\n\\n# Converted',metadata:{output_format:'markdown',
      test_stage:process.cwd(), original:fs.readFileSync(process.argv[3],'utf8'), args:process.argv.slice(4),
      credentials_present:!!process.env.CABINET_TEST_SECRET, additional:{source_uri:process.argv[3], final_uri:process.argv[3]}}}}));
  `);
  const composed = createXbergNormalization({ executable: fake.file });
  t.after(() => composed.close());
  const previous = process.env.CABINET_TEST_SECRET;
  process.env.CABINET_TEST_SECRET = "must not reach extraction";
  try {
    const result = await composed.normalizer.normalize(input());
    assert.equal(result.markdown, "---\n\n# Converted");
    assert.equal(result.metadata.original, "captured");
    assert.equal(result.metadata.credentials_present, false);
    assert.deepEqual(result.metadata.additional, {});
    assert.deepEqual(result.converter, { name: "xberg", version: "1.1.5" });
    assert.deepEqual(result.original.bytes, bytes("captured"));
    assert.ok((result.metadata.args as string[]).includes("--no-config-discovery"));
    assert.ok((result.metadata.args as string[]).includes("--no-cache"));
    await assert.rejects(fs.access(result.metadata.test_stage as string));
  } finally {
    if (previous === undefined) delete process.env.CABINET_TEST_SECRET;
    else process.env.CABINET_TEST_SECRET = previous;
  }
});

test("decoder retains image bytes and processing warnings and rejects invalid responses", () => {
  const result = decodeXbergOutput(output({ images: [{ data: [1, 2, 3], format: "png", source_path: "media/p.png" }],
    processing_warnings: [{ source: "test", message: "Partial extraction" }] }), "1.1.5");
  assert.deepEqual(result.assets, [{ path: "media/p.png", bytes: new Uint8Array([1, 2, 3]) }]);
  assert.equal(result.warnings[0], "Partial extraction");
  const repeated = { data: [1], format: "png", source_path: "media/logo.png" };
  assert.equal(decodeXbergOutput(output({ images: [repeated, repeated] }), "1.1.5").assets.length, 1);
  assert.throws(() => decodeXbergOutput(output({ images: [repeated, { ...repeated, data: [2] }] }), "1.1.5"), /Conflicting/);
  for (const value of ["bad JSON", "{}", output({ content: 12 }), output({ metadata: { output_format: "plain" } }),
    output({ images: [{ data: [256], format: "png" }] }), output({ images: [{ data: [1], format: "png", source_path: "../escape" }] }),
    output({ content: "", images: [] }), output({ processing_warnings: [{}] })]) {
    assert.throws(() => decodeXbergOutput(value, "1.1.5"));
  }
});

test("captured parent-relative dependencies remain resolvable after conversion", async (t) => {
  const fake = await executable(t, `if(process.argv[2]==='--version')console.log('xberg 1.1.5');else console.log(${JSON.stringify(output({ content: "![p](../images/p.png)" }))});`);
  const composed = createXbergNormalization({ executable: fake.file }); t.after(() => composed.close());
  const image = bytes("image");
  const result = await composed.normalizer.normalize({ ...input(), assets: [{ path: "images/p.png", bytes: image }] });
  assert.equal(result.markdown, `![p](assets/${hash(image)}.png)`);
  assert.equal(result.assets.length, 1);
});

test("bad version, missing executable, hash mismatch and original/asset collision fail without fallback", async (t) => {
  const fake = await executable(t, "console.log('xberg 9.0.0');");
  const adapter = new XbergAdapter({ executable: fake.file }); t.after(() => adapter.close());
  await assert.rejects(adapter.convert(input()), /requires verified xberg/);
  await assert.rejects(adapter.convert({ ...input(), contentHash: "0".repeat(64) }), /hash mismatch/);
  await assert.rejects(adapter.convert({ ...input(), assets: [{ path: "notes/source.html", bytes: bytes("collision") }] }), /collides/);
  const missing = new XbergAdapter({ executable: path.join(fake.root, "missing") }); t.after(() => missing.close());
  await assert.rejects(missing.convert(input()), /unavailable/);
});

test("process failures, timeouts and excessive output are bounded and the worker recovers", async (t) => {
  const fake = await executable(t, `
    if (process.argv[2] === 'hang') setInterval(()=>{},1000);
    else if (process.argv[2] === 'flood') process.stdout.write('x'.repeat(5000));
    else if (process.argv[2] === 'fail') process.exit(7);
    else console.log('ok');
  `);
  const worker = new XbergProcessWorker({ timeoutMs: 500, maxOutputBytes: 1024 }); t.after(() => worker.close());
  await assert.rejects(worker.run(fake.file, ["fail"], fake.root), /exit 7/);
  await assert.rejects(worker.run(fake.file, ["hang"], fake.root), /timed out/);
  await assert.rejects(worker.run(fake.file, ["flood"], fake.root), /size limit/);
  assert.equal((await worker.run(fake.file, [], fake.root)).stdout.trim(), "ok");
});

test("worker serializes requests, bounds its backlog and cancels active and pending work on close", async (t) => {
  const fake = await executable(t, "setInterval(()=>{},1000);");
  const worker = new XbergProcessWorker({ maxPending: 2 });
  const active = assert.rejects(worker.run(fake.file, [], fake.root), /cancelled|closed/);
  const queued = assert.rejects(worker.run(fake.file, [], fake.root), /closed/);
  await assert.rejects(worker.run(fake.file, [], fake.root), /busy/);
  await worker.close(); await active; await queued;
  await assert.rejects(worker.run(fake.file, [], fake.root), /closed/);
});

test("Markdown bypasses even an unavailable configured converter", async () => {
  const composed = createXbergNormalization({ executable: "/nonexistent/xberg" });
  try { assert.equal((await composed.normalizer.normalize(input("# Native", "note.md"))).markdown, "# Native"); }
  finally { await composed.close(); }
});

test("adapter cleans staging after conversion failure and rejects new work after shutdown", async (t) => {
  const fake = await executable(t, "");
  // Use a marker inside this fixture so the test can inspect the former staging path.
  const marker = path.join(fake.root, "stage");
  await fs.writeFile(fake.file, `#!${process.execPath}\nconst fs=require('node:fs');if(process.argv[2]==='--version')console.log('xberg 1.1.5');else {fs.writeFileSync(${JSON.stringify(marker)},process.cwd());process.exit(7);}`, { mode: 0o700 });
  const adapter = new XbergAdapter({ executable: fake.file });
  await assert.rejects(adapter.convert(input()), /exit 7/);
  await assert.rejects(fs.access(await fs.readFile(marker, "utf8")));
  await adapter.close();
  await assert.rejects(adapter.convert(input()), /closed/);
});
