import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { SourceStore } from "./source-store";

let temp: string;
let root: string;
let external: string;
let store: SourceStore;
let previousDataDir: string | undefined;

before(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-wiki-mount-"));
  previousDataDir = process.env.CABINET_DATA_DIR;
  process.env.CABINET_DATA_DIR = temp;
  root = path.join(temp, "Cabinet");
  external = path.join(temp, "external");
  await fs.mkdir(path.join(root, "room/.agents/.config"), { recursive: true });
  await fs.mkdir(external);
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: Root\n");
  await fs.writeFile(path.join(root, "room/.cabinet"), "kind: room\nname: Room\n");
  await fs.writeFile(path.join(external, "note.md"), "original working file");
  await fs.writeFile(path.join(root, "room/.agents/.config/knowledge-sources.json"), JSON.stringify({
    version: 1,
    sources: [
      { id: "connected", provider: "local", absPath: external, enabled: true, policy: "read-only", surface: "browser", name: "Read only" },
      { id: "disabled", provider: "local", absPath: external, enabled: false, policy: "read-write", surface: "inline", name: "Disabled" },
      { id: "alias", provider: "local", absPath: path.join(root, "wiki"), enabled: true, policy: "read-only", surface: "browser", name: "Generated" },
    ],
  }));
  const { initializeWikiCabinet } = await import("./config");
  await initializeWikiCabinet(root, { enabled: true });
  const { SourceStore } = await import("./source-store");
  store = new SourceStore(root);
});

after(async () => {
  if (previousDataDir === undefined) delete process.env.CABINET_DATA_DIR;
  else process.env.CABINET_DATA_DIR = previousDataDir;
  if (temp) await fs.rm(temp, { recursive: true, force: true });
});

function input(mountId: string, file = "note.md") {
  return {
    mode: "managed" as const, title: "Mounted note", classification: "research", roomPath: "room",
    managedLocation: { kind: "knowledge-mount" as const, mountId, roomPath: "room", path: file },
  };
}

test("read-only connected files can be registered without modifying the mount", async () => {
  const entry = await store.register(input("connected"));
  assert.equal(entry.source.mode, "managed");
  assert.equal(await fs.readFile(path.join(external, "note.md"), "utf8"), "original working file");
  assert.deepEqual(await fs.readdir(external), ["note.md"]);
});

test("unknown, disabled and differently scoped mounts are rejected", async () => {
  for (const id of ["unknown", "disabled"]) await assert.rejects(store.register(input(id)), /mount/);
  await assert.rejects(store.register({ ...input("connected"), roomPath: null }), /room mismatch/);
});

test("mount symlinks cannot escape their authorized directory", async () => {
  await fs.symlink(path.join(root, ".cabinet"), path.join(external, "escape.md"));
  await assert.rejects(store.register(input("connected", "escape.md")), /Symlink/);
});

test("connected mount aliases into generated layers cannot become managed inputs", async () => {
  await fs.mkdir(path.join(root, "wiki"));
  await fs.writeFile(path.join(root, "wiki/page.md"), "compiled");
  await assert.rejects(store.register(input("alias", "page.md")), /generated/);
});

test("managed watcher reads read-only mounts and distinguishes unavailable mounts from deleted files", async () => {
  const { default: Database } = await import("better-sqlite3");
  const { runSqlMigrations } = await import("../system/sql-migrations");
  const { IngestionQueue } = await import("./queue");
  const { ManagedSourceWatcher } = await import("../../../server/ingestion/managed");
  const db = new Database(path.join(root, ".cabinet.db"));
  runSqlMigrations(db, path.resolve("server/migrations"));
  const queue = await IngestionQueue.open(db, root);
  const watcher = new ManagedSourceWatcher(root, async () => queue, { stabilityMs: 20 });
  const settle = async () => {
    await watcher.refresh(); await new Promise((resolve) => setTimeout(resolve, 35)); await watcher.refresh();
  };
  const configPath = path.join(root, "room/.agents/.config/knowledge-sources.json");
  const config = await fs.readFile(configPath, "utf8");
  try {
    await settle();
    assert.equal(queue.list().length, 1);
    assert.equal(queue.list()[0].operation, "create");
    assert.equal(queue.list()[0].roomPath, "room");
    assert.equal(await fs.readFile(path.join(external, "note.md"), "utf8"), "original working file");
    await fs.writeFile(configPath, JSON.stringify({ version: 1, sources: [] }));
    await settle();
    assert.match(watcher.status().errors[0].error, /mount/);
    assert.equal(queue.list().length, 1);
    await fs.writeFile(configPath, config);
    await fs.rename(external, `${external}-offline`);
    await settle();
    assert.equal(watcher.status().errors.length, 1);
    assert.equal(queue.list().length, 1);
    await fs.rename(`${external}-offline`, external);
    await settle();
    assert.equal(watcher.status().errors.length, 0);
    assert.equal(queue.list().length, 1);
    await fs.unlink(path.join(external, "note.md")); await settle();
    assert.equal(queue.list()[1].operation, "delete");
    // The mount store and root pointer are rechecked on every refresh.
    await fs.mkdir(path.join(temp, ".home"), { recursive: true });
    await fs.writeFile(path.join(temp, ".home/home.json"), JSON.stringify({ activeCabinet: "Other" }));
    await fs.writeFile(path.join(external, "note.md"), "returned"); await settle();
    assert.match(watcher.status().error!, /root changed/);
    assert.equal(queue.list().length, 2);
  } finally {
    await watcher.close(); db.close();
    await fs.writeFile(configPath, config);
    await fs.rm(path.join(temp, ".home/home.json"), { force: true });
  }
});
