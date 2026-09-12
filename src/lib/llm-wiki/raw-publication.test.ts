import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { initializeWikiCabinet, readWikiCabinet, setWikiEnabled, WIKI_STATE_PATH } from "./config";
import { encodeSourceManifest } from "./manifest";
import { SourceStore } from "./source-store";
import { SourceNormalizationService } from "./normalizers";
import { RawPublicationStore } from "./raw-publication";
import { readEvidenceDocument } from "./provenance";
import { readClassificationTaxonomy } from "./classification";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, managed = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-publication-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: Publication\n");
  await initializeWikiCabinet(root, { enabled: true, paths: { raw: "evidence" } });
  const bytes = Buffer.from("---\nlanguage: en\n---\n# Hello\n![figure](../images/p.png)\n");
  await fs.writeFile(path.join(root, "working.md"), bytes);
  const input = { title: "Test source", classification: "research", roomPath: null };
  const source = await new SourceStore(root).register(managed
    ? { ...input, mode: "managed", managedLocation: { kind: "cabinet", path: "working.md" } }
    : { ...input, mode: "snapshot" });
  const normalized = await new SourceNormalizationService().normalize({ path: "notes/document.md", bytes,
    contentHash: createHash("sha256").update(bytes).digest("hex"), assets: [{ path: "images/p.png", bytes: Buffer.from("image") }] });
  const directory = path.join(root, source.source.rawPath);
  const transaction = path.join(root, WIKI_STATE_PATH, "publications", source.source.id, "v1");
  return { root, source, normalized, directory, transaction, bytes };
}

test("initial Raw publication preserves exact originals, dependencies and validated provenance", async (t) => {
  const f = await fixture(t);
  const store = new RawPublicationStore(f.root);
  const result = await store.publishInitial(f.source.source.id, f.normalized);
  assert.equal(result.versions.length, 1);
  assert.equal(result.source.currentVersionId, result.versions[0].id);
  assert.equal(result.source.lastCompiledVersionId, null);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "v1/original.md")), f.bytes);
  await assert.rejects(fs.access(path.join(f.directory, "v1/capture/notes/document.md")));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, "v1/capture.json"), "utf8")).original, "original.md");
  assert.equal(await fs.readFile(path.join(f.directory, "v1/capture/images/p.png"), "utf8"), "image");
  const document = readEvidenceDocument(await fs.readFile(path.join(f.directory, "v1/source.md"), "utf8"),
    { source: result.source, version: result.versions[0] });
  assert.equal(document.body, f.normalized.body);
  assert.equal(document.frontMatter.language, "en");
  assert.deepEqual(await new SourceStore(f.root).get(result.source.id), result);
  const stat = await fs.stat(path.join(f.directory, "v1/source.md"));
  assert.deepEqual(await store.publishInitial(result.source.id, f.normalized), result);
  assert.equal((await fs.stat(path.join(f.directory, "v1/source.md"))).mtimeMs, stat.mtimeMs);
});

for (const checkpoint of ["prepared", "staged", "published", "committed"] as const) {
  test(`publication recovers after ${checkpoint} without allocating another version`, async (t) => {
    const f = await fixture(t, true);
    const store = new RawPublicationStore(f.root, (point) => { if (point === checkpoint) throw new Error("interrupted"); });
    await assert.rejects(store.publishInitial(f.source.source.id, f.normalized), /interrupted/);
    const receipt = JSON.parse(await fs.readFile(path.join(f.transaction, "receipt.json"), "utf8"));
    const retry = new RawPublicationStore(f.root);
    if (checkpoint === "prepared") {
      await assert.rejects(retry.recoverInitial(f.source.source.id));
      await retry.publishInitial(f.source.source.id, f.normalized);
    }
    const recovered = await retry.recoverInitial(f.source.source.id);
    assert.equal(recovered.versions.length, 1);
    assert.ok(receipt.manifest.includes(recovered.versions[0].id));
    assert.deepEqual(await fs.readFile(path.join(f.root, "working.md")), f.bytes);
  });
}

test("publication refuses tampering, changed retries, symlinks and unjournaled output", async (t) => {
  const f = await fixture(t);
  const store = new RawPublicationStore(f.root);
  await store.publishInitial(f.source.source.id, f.normalized);
  await assert.rejects(store.publishInitial(f.source.source.id, { ...f.normalized, body: "different" }), /differs/);
  await fs.writeFile(path.join(f.directory, "v1/original.md"), "changed");
  await assert.rejects(store.recoverInitial(f.source.source.id), /integrity/);
  assert.equal(await fs.readFile(path.join(f.directory, "v1/original.md"), "utf8"), "changed");
  const g = await fixture(t);
  await fs.mkdir(path.join(g.directory, "v1"));
  await assert.rejects(new RawPublicationStore(g.root).publishInitial(g.source.source.id, g.normalized), /Unjournaled/);
  const h = await fixture(t);
  await fs.symlink(h.root, path.join(h.directory, "v1"));
  await assert.rejects(new RawPublicationStore(h.root).publishInitial(h.source.source.id, h.normalized), /Symlink/);
});

test("recovery refuses stale source metadata before manifest commit and preserves changes after it", async (t) => {
  for (const checkpoint of ["staged", "committed"] as const) {
    const f = await fixture(t);
    await assert.rejects(new RawPublicationStore(f.root, (point) => { if (point === checkpoint) throw new Error("stop"); })
      .publishInitial(f.source.source.id, f.normalized), /stop/);
    await new SourceStore(f.root).reclassify(f.source.source.id, "new-category", "research");
    const recovery = new RawPublicationStore(f.root).recoverInitial(f.source.source.id);
    if (checkpoint === "staged") await assert.rejects(recovery, /Manifest changed/);
    else assert.equal((await recovery).source.classification, "new-category");
  }
});

test("partial staging retries fill missing files but never overwrite damaged files", async (t) => {
  const f = await fixture(t);
  await assert.rejects(new RawPublicationStore(f.root, (point) => { if (point === "staged") throw new Error("stop"); })
    .publishInitial(f.source.source.id, f.normalized), /stop/);
  await fs.unlink(path.join(f.transaction, "staging/source.md"));
  const store = new RawPublicationStore(f.root);
  await assert.rejects(store.recoverInitial(f.source.source.id), /Incomplete/);
  await store.publishInitial(f.source.source.id, f.normalized);
  const g = await fixture(t);
  await assert.rejects(new RawPublicationStore(g.root, (point) => { if (point === "staged") throw new Error("stop"); })
    .publishInitial(g.source.source.id, g.normalized), /stop/);
  await fs.writeFile(path.join(g.transaction, "staging/source.md"), "partial");
  await assert.rejects(new RawPublicationStore(g.root).publishInitial(g.source.source.id, g.normalized), /integrity/);
  assert.equal((await new SourceStore(g.root).get(g.source.source.id))?.versions.length, 0);
});

test("disabled roots, unsafe asset paths and mismatching captured hashes do not publish", async (t) => {
  const f = await fixture(t);
  const store = new RawPublicationStore(f.root);
  await assert.rejects(store.publishInitial(f.source.source.id,
    { ...f.normalized, original: { ...f.normalized.original, bytes: Buffer.from("different") } }), /mismatch/);
  await assert.rejects(store.publishInitial(f.source.source.id,
    { ...f.normalized, assets: [{ ...f.normalized.assets[0], path: "../outside" }] }), /path/);
  await setWikiEnabled(f.root, false);
  await assert.rejects(store.publishInitial(f.source.source.id, f.normalized), /enabled/);
  assert.equal((await new SourceStore(f.root).get(f.source.source.id))?.versions.length, 0);
});

test("publication serializes writers and snapshots caller buffers before asynchronous work", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const prepared = new Promise<void>((resolve) => { entered = resolve; });
  const store = new RawPublicationStore(f.root, async (point) => {
    if (point === "prepared") { entered(); await gate; }
  });
  const publication = store.publishInitial(f.source.source.id, f.normalized);
  f.normalized.original.bytes.fill(0);
  await prepared;
  try {
    await assert.rejects(new RawPublicationStore(f.root).recoverInitial(f.source.source.id), /locked/);
  } finally { release(); }
  await publication;
  assert.deepEqual(await fs.readFile(path.join(f.directory, "v1/original.md")), f.bytes);
});

test("foreign receipts and symlinks in staged assets fail closed", async (t) => {
  const f = await fixture(t);
  await assert.rejects(new RawPublicationStore(f.root, (point) => { if (point === "staged") throw new Error("stop"); })
    .publishInitial(f.source.source.id, f.normalized), /stop/);
  const asset = path.join(f.transaction, "staging", f.normalized.assets[0].path);
  await fs.unlink(asset);
  await fs.symlink(path.join(f.root, "working.md"), asset);
  await assert.rejects(new RawPublicationStore(f.root).recoverInitial(f.source.source.id), /symlink/);
  const g = await fixture(t);
  await fs.mkdir(g.transaction, { recursive: true });
  await fs.copyFile(path.join(f.transaction, "receipt.json"), path.join(g.transaction, "receipt.json"));
  await assert.rejects(new RawPublicationStore(g.root).recoverInitial(g.source.source.id));
  assert.equal((await new SourceStore(g.root).get(g.source.source.id))?.versions.length, 0);
});

test("classification plans are checked under the registration lock before publishing", async (t) => {
  const f = await fixture(t);
  const taxonomy = await readClassificationTaxonomy(f.root, null);
  const input = { mode: "snapshot" as const, title: "Classified", classification: "research", roomPath: null };
  const sources = new SourceStore(f.root);
  await assert.rejects(sources.register(input, { taxonomy, decision: { kind: "review", reason: "Uncertain" } }), /review/);
  const plan = { taxonomy, decision: { kind: "existing" as const, category: "research", reason: "Existing subject" } };
  const registered = await sources.register(input, plan);
  await new RawPublicationStore(f.root).publishInitial(registered.source.id, f.normalized);
  await assert.rejects(sources.register(input, plan), /Taxonomy changed/);
});

async function updated(text = "# Hello\nChanged result: 42%.\n\n## New section\n[Reference](https://example.org/new)\n") {
  const bytes = Buffer.from(text);
  return new SourceNormalizationService().normalize({ path: "notes/document.md", bytes,
    contentHash: createHash("sha256").update(bytes).digest("hex") });
}

test("managed updates append v2/v3, retain history, and compare committed bodies", async (t) => {
  const f = await fixture(t, true);
  const store = new RawPublicationStore(f.root);
  const first = await store.publishInitial(f.source.source.id, f.normalized);
  const original = await fs.readFile(path.join(f.directory, "v1/source.md"));
  const second = await store.publishUpdate(first.source.id, first.versions[0].id, await updated());
  assert.deepEqual(second.versions[0], first.versions[0]);
  assert.equal(second.versions[1].version, 2);
  assert.equal(second.source.rawPath, first.source.rawPath);
  assert.equal(second.source.lastCompiledVersionId, null);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "v1/source.md")), original);
  const delta = await store.compareVersions(first.source.id, first.versions[0].id, second.versions[1].id);
  assert.ok(delta.sections.added.some((value) => value.includes("New section")));
  assert.deepEqual(delta.numbers.added, ["42%"]);
  assert.equal(delta.semantic.status, "not-run");
  const third = await store.publishUpdate(first.source.id, second.versions[1].id, f.normalized);
  assert.equal(third.versions[2].version, 3); // A return to old bytes is a new observation.
  assert.equal(third.versions[2].contentHash, first.versions[0].contentHash);
  assert.deepEqual(await store.publishUpdate(first.source.id, first.versions[0].id, await updated()), third);
  assert.deepEqual(await store.recoverInitial(first.source.id), third);
  await assert.rejects(store.compareVersions(first.source.id, first.versions[0].id, third.versions[2].id), /Adjacent/);
  assert.deepEqual(await fs.readFile(path.join(f.root, "working.md")), f.bytes);
});

for (const checkpoint of ["prepared", "staged", "published", "committed"] as const) {
  test(`managed update recovers after ${checkpoint} with its original version identity`, async (t) => {
    const f = await fixture(t, true);
    const first = await new RawPublicationStore(f.root).publishInitial(f.source.source.id, f.normalized);
    const normalized = await updated();
    await assert.rejects(new RawPublicationStore(f.root, (point) => { if (point === checkpoint) throw new Error("stop"); })
      .publishUpdate(first.source.id, first.versions[0].id, normalized), /stop/);
    const store = new RawPublicationStore(f.root);
    const receiptPath = path.join(path.dirname(f.transaction), "v2/receipt.json");
    const receipt = await fs.readFile(receiptPath, "utf8");
    const result = checkpoint === "prepared"
      ? await store.publishUpdate(first.source.id, first.versions[0].id, normalized)
      : await store.recoverVersion(first.source.id, 2);
    assert.equal(result.versions.length, 2);
    assert.ok(receipt.includes(result.versions[1].id));
    assert.deepEqual(result.versions[0], first.versions[0]);
    assert.deepEqual(await store.publishUpdate(first.source.id, first.versions[0].id, normalized), result);
  });
}

test("identical source bytes are a verified no-op and mismatching captures still fail", async (t) => {
  const f = await fixture(t, true);
  const store = new RawPublicationStore(f.root);
  const first = await store.publishInitial(f.source.source.id, f.normalized);
  const before = await fs.readFile(path.join(f.directory, "manifest.yaml"));
  assert.deepEqual(await store.publishUpdate(first.source.id, first.versions[0].id, f.normalized), first);
  assert.deepEqual(await fs.readFile(path.join(f.directory, "manifest.yaml")), before);
  await assert.rejects(fs.access(path.join(f.directory, "v2")));
  await assert.rejects(store.publishUpdate(first.source.id, first.versions[0].id,
    { ...f.normalized, original: { ...f.normalized.original, bytes: Buffer.from("forged") } }), /hash mismatch/);
  await fs.writeFile(path.join(f.directory, "v1/source.md"), "tampered");
  await assert.rejects(store.publishUpdate(first.source.id, first.versions[0].id, f.normalized), /integrity/);
});

test("updates reject snapshot sources, foreign predecessors and conflicting orphan versions", async (t) => {
  const snapshot = await fixture(t);
  const snapshots = new RawPublicationStore(snapshot.root);
  const s = await snapshots.publishInitial(snapshot.source.source.id, snapshot.normalized);
  await assert.rejects(snapshots.publishUpdate(s.source.id, s.versions[0].id, await updated()), /Managed/);
  const f = await fixture(t, true);
  const store = new RawPublicationStore(f.root);
  const first = await store.publishInitial(f.source.source.id, f.normalized);
  await assert.rejects(store.publishUpdate(first.source.id, s.versions[0].id, await updated()), /predecessor/);
  await fs.mkdir(path.join(f.directory, "v2"));
  await assert.rejects(store.publishUpdate(first.source.id, first.versions[0].id, f.normalized), /Unjournaled/);
});

test("pending update refuses changed retry content and preserves logical classification", async (t) => {
  const f = await fixture(t, true);
  const store = new RawPublicationStore(f.root);
  const first = await store.publishInitial(f.source.source.id, f.normalized);
  await new SourceStore(f.root).reclassify(first.source.id, "renamed", "research");
  await assert.rejects(new RawPublicationStore(f.root, (point) => { if (point === "published") throw new Error("stop"); })
    .publishUpdate(first.source.id, first.versions[0].id, await updated()), /stop/);
  await assert.rejects(store.publishUpdate(first.source.id, first.versions[0].id, await updated("# Different")), /mismatch|differs/);
  const second = await store.recoverVersion(first.source.id, 2);
  assert.equal(second.source.classification, "renamed");
  assert.equal(second.source.rawPath, first.source.rawPath);
});

test("publication retains compiled progress and semantic failure cannot roll back Raw", async (t) => {
  const f = await fixture(t, true);
  const store = new RawPublicationStore(f.root);
  const first = await store.publishInitial(f.source.source.id, f.normalized);
  const compiled = { ...first, source: { ...first.source, lastCompiledVersionId: first.versions[0].id } };
  await fs.writeFile(path.join(f.directory, "manifest.yaml"), encodeSourceManifest(compiled, (await readWikiCabinet(f.root))!));
  const second = await store.publishUpdate(first.source.id, first.versions[0].id, await updated());
  assert.equal(second.source.lastCompiledVersionId, first.versions[0].id);
  await assert.rejects(store.compareVersions(first.source.id, first.versions[0].id, second.versions[1].id,
    { async decide() { throw new Error("provider unavailable"); } }), /provider unavailable/);
  assert.deepEqual(await new SourceStore(f.root).get(first.source.id), second);
  assert.equal((await store.compareVersions(first.source.id, first.versions[0].id, second.versions[1].id)).toVersionId, second.versions[1].id);
  await fs.writeFile(path.join(f.directory, "v2/source.md"), "damaged");
  await assert.rejects(store.compareVersions(first.source.id, first.versions[0].id, second.versions[1].id), /integrity/);
  await assert.rejects(store.publishUpdate(first.source.id, second.versions[1].id, f.normalized), /integrity/);
});
