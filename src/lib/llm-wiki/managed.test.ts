import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { runSqlMigrations } from "../system/sql-migrations";
import { initializeWikiCabinet, setWikiEnabled } from "./config";
import { IngestionQueue } from "./queue";
import { SourceStore } from "./source-store";
import type { SourceVersionId } from "./types";
import { ManagedSourceWatcher } from "../../../server/ingestion/managed";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const pause = () => new Promise((resolve) => setTimeout(resolve, 35));
async function settle(watcher: ManagedSourceWatcher) {
  await watcher.refresh(); await pause(); await watcher.refresh();
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, captured = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-managed-"));
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: Managed test\n");
  await initializeWikiCabinet(root, { enabled: true });
  const file = path.join(root, "note.md");
  await fs.writeFile(file, "A");
  const store = new SourceStore(root);
  const entry = await store.register({ mode: "managed", title: "Note", classification: "notes", roomPath: null,
    managedLocation: { kind: "cabinet", path: "note.md" } });
  const manifest = path.join(root, entry.source.rawPath, "manifest.yaml");
  if (captured) {
    const id = randomUUID() as SourceVersionId;
    entry.source.currentVersionId = id;
    entry.versions = [{ id, sourceId: entry.source.id, cabinetId: entry.source.cabinetId, version: 1,
      contentHash: hash("A"), originalPath: `${entry.source.rawPath}/v1/original.md`,
      markdownPath: `${entry.source.rawPath}/v1/source.md`, originalFormat: "md", createdAt: new Date().toISOString() }];
    await fs.mkdir(path.join(root, entry.source.rawPath, "v1"));
    await fs.writeFile(path.join(root, entry.versions[0].originalPath), "A");
    await fs.writeFile(manifest, JSON.stringify(entry));
  }
  const db = new Database(path.join(root, ".cabinet.db"));
  runSqlMigrations(db, path.resolve("server/migrations"));
  const queue = await IngestionQueue.open(db, root);
  const watchers: ManagedSourceWatcher[] = [];
  const makeWatcher = () => {
    const watcher = new ManagedSourceWatcher(root, async () => queue, { pollMs: 25, stabilityMs: 20 });
    watchers.push(watcher); return watcher;
  };
  const watcher = makeWatcher();
  t.after(async () => { for (const item of watchers) await item.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, file, store, entry, manifest, queue, watcher, makeWatcher };
}

test("current evidence and duplicate saves are ignored; changed stable bytes enqueue updates", async (t) => {
  const f = await fixture(t);
  await settle(f.watcher);
  assert.equal(f.queue.list().length, 0);
  await fs.writeFile(f.file, "A"); await settle(f.watcher);
  assert.equal(f.queue.list().length, 0);
  await fs.writeFile(f.file, "B"); await f.watcher.refresh();
  await fs.appendFile(f.file, " final"); await f.watcher.refresh();
  assert.equal(f.queue.list().length, 0);
  await settle(f.watcher);
  assert.equal(f.queue.list()[0].operation, "update");
  assert.equal(f.queue.list()[0].contentHash, hash("B final"));
  assert.equal(f.queue.list()[0].sourceId, f.entry.source.id);
  await fs.writeFile(f.file, "B final"); await settle(f.watcher);
  assert.equal(f.queue.list().length, 1);
});

test("restart deduplicates pending changes and retains A → B → A → B transitions", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, "B"); await settle(f.watcher);
  await f.watcher.close();
  const next = f.makeWatcher(); await settle(next);
  assert.equal(f.queue.list().length, 1);
  await fs.writeFile(f.file, "A"); await settle(next);
  await fs.writeFile(f.file, "B"); await settle(next);
  assert.deepEqual(f.queue.list().map((job) => job.contentHash), [hash("B"), hash("A"), hash("B")]);
  assert.equal(new Set(f.queue.list().map((job) => job.generation)).size, 3);
});

test("deletion and restoration enqueue once per transition without changing Raw", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.manifest, "utf8");
  await fs.unlink(f.file); await settle(f.watcher); await settle(f.watcher);
  await f.watcher.close(); const next = f.makeWatcher(); await settle(next);
  assert.deepEqual(f.queue.list().map((job) => job.operation), ["delete"]);
  await fs.writeFile(f.file, "A"); await settle(next);
  await fs.unlink(f.file); await settle(next);
  assert.deepEqual(f.queue.list().map((job) => job.operation), ["delete", "update", "delete"]);
  assert.equal(await fs.readFile(f.manifest, "utf8"), before);
  assert.equal(await fs.readFile(path.join(f.root, f.entry.versions[0].originalPath), "utf8"), "A");
});

test("atomic replacement and explicit rebinding retain identity and cancel old-path deletion", async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.file); await f.watcher.refresh();
  await fs.writeFile(f.file, "A"); await settle(f.watcher);
  assert.equal(f.queue.list().length, 0);
  const moved = path.join(f.root, "moved.md");
  await fs.rename(f.file, moved); await f.watcher.refresh();
  await f.store.rebind(f.entry.source.id, { kind: "cabinet", path: "moved.md" });
  await settle(f.watcher);
  assert.equal(f.queue.list().length, 0);
  await fs.writeFile(path.join(f.root, "replacement.tmp"), "B");
  await fs.rename(path.join(f.root, "replacement.tmp"), moved); await settle(f.watcher);
  assert.equal(f.queue.list()[0].input?.path, "moved.md");
  assert.equal(f.queue.list()[0].sourceId, f.entry.source.id);
});

test("only registered managed files are observed; initial evidence queues create once", async (t) => {
  const f = await fixture(t, false);
  await fs.writeFile(path.join(f.root, "unregistered.md"), "ignore");
  await f.store.register({ mode: "snapshot", title: "Snapshot", classification: "notes", roomPath: null });
  await settle(f.watcher); await settle(f.watcher);
  assert.deepEqual(f.queue.list().map((job) => job.operation), ["create"]);
  await fs.writeFile(f.file, "B"); await settle(f.watcher);
  assert.deepEqual(f.queue.list().map((job) => job.operation), ["create", "update"]);
});

test("symlinks and directories surface errors, never deletion; recovery resumes", async (t) => {
  const f = await fixture(t);
  await fs.unlink(f.file); await fs.symlink(f.manifest, f.file);
  await settle(f.watcher);
  assert.match(f.watcher.status().errors[0].error, /Symlink/);
  assert.equal(f.queue.list().length, 0);
  await fs.unlink(f.file); await fs.mkdir(f.file); await settle(f.watcher);
  assert.match(f.watcher.status().errors[0].error, /regular file/);
  await fs.rmdir(f.file); await fs.writeFile(f.file, "B"); await settle(f.watcher);
  assert.equal(f.watcher.status().errors.length, 0);
  assert.equal(f.queue.list().length, 1);
});

test("feature disable, archived source and shutdown prevent submissions", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.file, "B"); await f.watcher.refresh();
  await setWikiEnabled(f.root, false); await settle(f.watcher);
  assert.equal(f.watcher.status().enabled, false);
  assert.equal(f.queue.list().length, 0);
  await setWikiEnabled(f.root, true);
  f.entry.source.status = "archived"; await fs.writeFile(f.manifest, JSON.stringify(f.entry));
  await settle(f.watcher); assert.equal(f.queue.list().length, 0);
  f.entry.source.status = "active"; await fs.writeFile(f.manifest, JSON.stringify(f.entry));
  await f.watcher.refresh(); await f.watcher.close(); await settle(f.watcher);
  assert.equal(f.queue.list().length, 0);
});

test("background polling discovers new registrations and drains on close", async (t) => {
  const f = await fixture(t);
  await f.watcher.start();
  await fs.writeFile(path.join(f.root, "new.md"), "new");
  await f.store.register({ mode: "managed", title: "New", classification: "notes", roomPath: null,
    managedLocation: { kind: "cabinet", path: "new.md" } });
  const deadline = Date.now() + 3000;
  while (f.queue.list().length === 0 && Date.now() < deadline) await pause();
  assert.equal(f.queue.list().length, 1);
  await f.watcher.close();
  await fs.writeFile(f.file, "B"); await pause(); await pause();
  assert.equal(f.queue.list().length, 1);
});

test("explicit user removal stays excluded from watcher updates until restored", async (t) => {
  const f = await fixture(t);
  const { SourceLifecycleStore } = await import("./source-lifecycle");
  const lifecycle = new SourceLifecycleStore(f.root);
  await lifecycle.remove(f.entry.source.id, 0);
  await fs.writeFile(f.file, "changed while removed");
  await settle(f.watcher);
  assert.equal(f.queue.list().length, 0);
  await lifecycle.restore(f.entry.source.id, 1);
  await settle(f.watcher);
  assert.equal(f.queue.list().at(-1)?.operation, "update");
});
