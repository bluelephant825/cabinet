import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsm from "node:fs";
import path from "node:path";
import os from "node:os";
import JSZip from "jszip";

import { buildBlankDocx } from "../src/vendor/genoffice/packages/docx-engine/src/blank";
import { commitBytes, readWithRevision } from "../server/documents/persistence";
import { revisionOf } from "../src/lib/documents/revision";
import { DocumentError } from "../src/lib/documents/errors";

let dir: string;
test.beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cab-doc-persist-"));
});
test.afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const tmpFiles = () => fsm.readdirSync(dir).filter((f) => f.endsWith(".tmp") || f.endsWith(".docwork"));

async function realDocx(): Promise<Uint8Array> {
  const bytes = await buildBlankDocx();
  const zip = await JSZip.loadAsync(bytes);
  assert.ok(zip.file("[Content_Types].xml"), "fixture must be a real docx");
  return bytes;
}

test("assets-style utf-8 write corrupts docx; commitBytes is byte-identical", async () => {
  const bytes = await realDocx();
  const target = path.join(dir, "demo.docx");
  await fs.writeFile(target, bytes);

  // What /api/assets PUT does today: req.text() + writeFile utf-8.
  const corrupted = path.join(dir, "corrupted.docx");
  await fs.writeFile(corrupted, Buffer.from(bytes).toString(), "utf-8");
  const corruptedBytes = await fs.readFile(corrupted);
  assert.notDeepEqual(corruptedBytes, Buffer.from(bytes), "utf-8 write should corrupt the docx");

  const rev = revisionOf(bytes);
  const result = await commitBytes({ absPath: target, bytes, expectedRevision: rev });
  assert.equal(result.revision, rev);
  const onDisk = await fs.readFile(target);
  assert.deepEqual(onDisk, Buffer.from(bytes), "commitBytes must be byte-identical");
});

test("stale expectedRevision → conflict, target untouched, no temp leftovers", async () => {
  const bytes = await realDocx();
  const target = path.join(dir, "doc.docx");
  await fs.writeFile(target, bytes);
  await assert.rejects(
    commitBytes({ absPath: target, bytes, expectedRevision: "sha256:deadbeef" }),
    (e) => e instanceof DocumentError && e.code === "conflict" && Boolean(e.details?.currentRevision),
  );
  assert.deepEqual(await fs.readFile(target), Buffer.from(bytes));
  assert.deepEqual(tmpFiles(), []);
});

test("expectedRevision=null on existing file → conflict", async () => {
  const bytes = await realDocx();
  const target = path.join(dir, "doc.docx");
  await fs.writeFile(target, bytes);
  await assert.rejects(
    commitBytes({ absPath: target, bytes, expectedRevision: null }),
    (e) => e instanceof DocumentError && e.code === "conflict",
  );
  assert.deepEqual(tmpFiles(), []);
});

test("oversized input → too-large, no temp leftovers", async () => {
  const bytes = await realDocx();
  const target = path.join(dir, "big.docx");
  await assert.rejects(
    commitBytes({ absPath: target, bytes, expectedRevision: null, maxBytes: bytes.byteLength - 1 }),
    (e) => e instanceof DocumentError && e.code === "too-large",
  );
  assert.deepEqual(tmpFiles(), []);
});

test("bad signature: .pdf path with docx bytes → invalid", async () => {
  const bytes = await realDocx();
  const target = path.join(dir, "notreally.pdf");
  await assert.rejects(
    commitBytes({ absPath: target, bytes, expectedRevision: null }),
    (e) => e instanceof DocumentError && e.code === "invalid",
  );
  assert.deepEqual(tmpFiles(), []);
});

test("simulated rename crash: original intact, temp removed", async () => {
  const bytes = await realDocx();
  const target = path.join(dir, "doc.docx");
  await fs.writeFile(target, bytes);
  const rev = revisionOf(bytes);

  const patched = fsm.promises as unknown as { rename: typeof fsm.promises.rename };
  const restore = patched.rename;
  patched.rename = (async () => {
    throw new Error("simulated crash during rename");
  }) as typeof fsm.promises.rename;
  try {
    const updated = Buffer.concat([Buffer.from(bytes)]);
    await assert.rejects(
      commitBytes({ absPath: target, bytes: updated, expectedRevision: rev }),
      /simulated crash/,
    );
  } finally {
    patched.rename = restore;
  }
  assert.deepEqual(await fs.readFile(target), Buffer.from(bytes), "original must be intact");
  assert.deepEqual(tmpFiles(), []);
});

test("signatureCheck utf8: valid text commits; NUL bytes and bad UTF-8 → invalid", async () => {
  const target = path.join(dir, "note.md");
  const ok = await commitBytes({
    absPath: target,
    bytes: Buffer.from("# hi\n", "utf8"),
    expectedRevision: null,
    signatureCheck: "utf8",
  });
  assert.ok(ok.revision.startsWith("sha256:"));

  await assert.rejects(
    commitBytes({
      absPath: path.join(dir, "nul.md"),
      bytes: Buffer.from([0x23, 0x00, 0x0a]),
      expectedRevision: null,
      signatureCheck: "utf8",
    }),
    (e) => e instanceof DocumentError && e.code === "invalid",
  );
  await assert.rejects(
    commitBytes({
      absPath: path.join(dir, "bad.md"),
      bytes: new Uint8Array([0xff, 0xfe, 0xfd]),
      expectedRevision: null,
      signatureCheck: "utf8",
    }),
    (e) => e instanceof DocumentError && e.code === "invalid",
  );
  assert.deepEqual(tmpFiles(), []);
});

test("readWithRevision → not-found for missing file", async () => {
  await assert.rejects(readWithRevision(path.join(dir, "nope.docx")), (e) => {
    return e instanceof DocumentError && e.code === "not-found";
  });
});
