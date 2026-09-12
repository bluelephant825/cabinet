import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { initializeWikiCabinet, setWikiEnabled } from "./config";
import { SourceStore } from "./source-store";
import { SourceLifecycleStore, type LifecycleReconciler } from "./source-lifecycle";
import { SourceNormalizationService } from "./normalizers";
import { RawPublicationStore } from "./raw-publication";
import type { SourceId } from "./types";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, managed = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-lifecycle-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: Lifecycle\n");
  await initializeWikiCabinet(root, { enabled: true });
  const original = Buffer.from("# Retained evidence\n");
  const working = path.join(root, "working.md");
  await fs.writeFile(working, original);
  const store = new SourceStore(root), lifecycle = new SourceLifecycleStore(root);
  const base = { title: "Source", classification: "research", roomPath: null };
  const registered = await store.register(managed
    ? { ...base, mode: "managed", managedLocation: { kind: "cabinet", path: "working.md" } }
    : { ...base, mode: "snapshot" });
  const normalized = await new SourceNormalizationService().normalize({ path: "working.md", bytes: original,
    contentHash: createHash("sha256").update(original).digest("hex") });
  const entry = await new RawPublicationStore(root).publishInitial(registered.source.id, normalized);
  const evidence = path.join(root, entry.versions[0].markdownPath);
  return { root, working, store, lifecycle, entry, evidence, original };
}
const complete: LifecycleReconciler = { async reconcile(request) {
  return { sourceId: request.manifest.source.id, revision: request.manifest.source.lifecycle!.revision };
} };

test("missing-file removal retains Raw and pointers, excludes active projection and is retry-safe", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.evidence);
  await fs.unlink(f.working);
  const removed = await f.lifecycle.remove(f.entry.source.id, 0, "missing");
  assert.equal(removed.source.status, "deleted");
  assert.equal(removed.source.deletionReason, "missing");
  assert.ok(removed.source.deletedAt);
  assert.equal(removed.source.lifecycle?.reconciliation, "pending");
  assert.deepEqual(removed.versions, f.entry.versions);
  assert.equal(removed.source.currentVersionId, f.entry.source.currentVersionId);
  assert.deepEqual(await fs.readFile(f.evidence), before);
  assert.equal((await f.store.list()).length, 1);
  assert.equal((await f.store.listActive()).length, 0);
  assert.deepEqual(await f.lifecycle.remove(f.entry.source.id, 0, "missing"), removed);
});

test("missing-file removal rechecks existence and rejects unavailable/misbound inputs", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.lifecycle.remove(f.entry.source.id, 0, "missing"), /returned/);
  await fs.unlink(f.working);
  await fs.symlink(f.evidence, f.working);
  await assert.rejects(f.lifecycle.remove(f.entry.source.id, 0, "missing"), /Symlink/);
  assert.equal((await f.store.get(f.entry.source.id))?.source.status, "active");
  const g = await fixture(t, false);
  await assert.rejects(g.lifecycle.remove(g.entry.source.id, 0, "missing"), /managed/);
});

test("returned managed files restore the same identity without creating or changing versions", async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.working);
  await f.lifecycle.remove(f.entry.source.id, 0, "missing");
  await assert.rejects(f.lifecycle.restore(f.entry.source.id, 1, "returned"), /not returned/);
  await fs.writeFile(f.working, "Changed working content");
  const restored = await f.lifecycle.restore(f.entry.source.id, 1, "returned");
  assert.equal(restored.source.status, "active");
  assert.equal(restored.source.deletedAt, undefined);
  assert.equal(restored.source.deletionReason, undefined);
  assert.equal(restored.source.lifecycle?.revision, 2);
  assert.deepEqual(restored.versions, f.entry.versions);
  assert.equal((await f.store.listActive(null)).length, 1);
  await assert.rejects(f.lifecycle.remove(f.entry.source.id, 0), /Stale/);
});

test("user removal requires explicit restoration; snapshots may be restored without a working file", async (t) => {
  for (const managed of [true, false]) {
    const f = await fixture(t, managed);
    await f.lifecycle.remove(f.entry.source.id, 0);
    await assert.rejects(f.lifecycle.restore(f.entry.source.id, 1, "returned"), /explicit|managed/);
    const restored = await f.lifecycle.restore(f.entry.source.id, 1);
    assert.equal(restored.source.status, "active");
    assert.deepEqual(await fs.readFile(f.working), f.original);
  }
});

test("reconciliation failure remains pending and a matching retry completes without changing evidence", async (t) => {
  const f = await fixture(t);
  await f.lifecycle.remove(f.entry.source.id, 0);
  await assert.rejects(f.lifecycle.reconcile(f.entry.source.id, 1, { async reconcile() { throw new Error("offline"); } }), /offline/);
  assert.equal((await f.store.get(f.entry.source.id))?.source.lifecycle?.reconciliation, "pending");
  await assert.rejects(f.lifecycle.reconcile(f.entry.source.id, 1, { async reconcile() {
    return { sourceId: randomUUID() as SourceId, revision: 1 };
  } }), /identity/);
  const reconciled = await f.lifecycle.reconcile(f.entry.source.id, 1, complete);
  assert.equal(reconciled.source.lifecycle?.reconciliation, "complete");
  assert.deepEqual(await f.lifecycle.reconcile(f.entry.source.id, 1, complete), reconciled);
  await f.lifecycle.restore(f.entry.source.id, 1);
  await assert.rejects(f.lifecycle.reconcile(f.entry.source.id, 1, complete), /Stale/);
});

test("permanent deletion requires confirmation and successful reconciliation before erasure", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.lifecycle.permanentlyDelete(f.entry.source.id, 0, f.entry.source.id, complete), /Remove Source/);
  await f.lifecycle.remove(f.entry.source.id, 0);
  await assert.rejects(f.lifecycle.permanentlyDelete(f.entry.source.id, 1, randomUUID() as SourceId, complete), /confirmation/);
  await assert.rejects(f.lifecycle.permanentlyDelete(f.entry.source.id, 1, f.entry.source.id, { async reconcile() {
    await fs.access(f.evidence); throw new Error("Wiki unresolved");
  } }), /Wiki unresolved/);
  await fs.access(f.evidence);
  await assert.rejects(f.lifecycle.restore(f.entry.source.id, 2), /Permanent/);
  let calls = 0;
  const reconciler: LifecycleReconciler = { async reconcile(request) {
    calls++; assert.equal(request.action, "purge"); await fs.access(f.evidence);
    return complete.reconcile(request);
  } };
  assert.equal((await f.lifecycle.permanentlyDelete(f.entry.source.id, 1, f.entry.source.id, reconciler)).status, "purged");
  assert.equal(await f.store.get(f.entry.source.id), null);
  await assert.rejects(fs.access(f.evidence));
  assert.deepEqual(await fs.readFile(f.working), f.original);
  await f.lifecycle.permanentlyDelete(f.entry.source.id, 1, f.entry.source.id, reconciler);
  assert.equal(calls, 1);
});

test("disabled roots and stale lifecycle revisions cannot mutate manifests", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.lifecycle.remove(f.entry.source.id, -1), /revision/);
  await assert.rejects(f.lifecycle.remove(f.entry.source.id, 5), /Stale/);
  await setWikiEnabled(f.root, false);
  await assert.rejects(f.lifecycle.remove(f.entry.source.id, 0), /enabled/);
  assert.equal((await f.store.get(f.entry.source.id))?.source.status, "active");
});

for (const point of ["reconciled", "quarantined", "erased"] as const) {
  test(`permanent deletion resumes after ${point} without repeating completed reconciliation`, async (t) => {
    const f = await fixture(t);
    await f.lifecycle.remove(f.entry.source.id, 0);
    let calls = 0;
    const reconciler: LifecycleReconciler = { async reconcile(request) { calls++; return complete.reconcile(request); } };
    await assert.rejects(new SourceLifecycleStore(f.root, (checkpoint) => { if (checkpoint === point) throw new Error("stop"); })
      .permanentlyDelete(f.entry.source.id, 1, f.entry.source.id, reconciler), /stop/);
    await f.lifecycle.permanentlyDelete(f.entry.source.id, 1, f.entry.source.id, reconciler);
    assert.equal(calls, 1);
    assert.equal(await f.store.get(f.entry.source.id), null);
    assert.deepEqual(await fs.readFile(f.working), f.original);
  });
}

test("purge fails closed if source metadata changes after reconciliation", async (t) => {
  const f = await fixture(t);
  await f.lifecycle.remove(f.entry.source.id, 0);
  await assert.rejects(new SourceLifecycleStore(f.root, (point) => { if (point === "reconciled") throw new Error("stop"); })
    .permanentlyDelete(f.entry.source.id, 1, f.entry.source.id, complete), /stop/);
  const manifest = path.join(f.root, f.entry.source.rawPath, "manifest.yaml");
  await fs.appendFile(manifest, "custom_after_reconciliation: true\n");
  await assert.rejects(f.lifecycle.permanentlyDelete(f.entry.source.id, 1, f.entry.source.id, complete), /changed/);
  await fs.access(f.evidence);
});
