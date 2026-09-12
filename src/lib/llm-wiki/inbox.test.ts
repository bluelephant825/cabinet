import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { runSqlMigrations } from "../system/sql-migrations";
import { initializeWikiCabinet, setWikiEnabled } from "./config";
import { IngestionQueue } from "./queue";
import { InboxWatcher, isInboxCandidate } from "../../../server/ingestion/inbox";

async function until(check: () => boolean, message: string) {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function fixture(t: { after: (fn: () => Promise<void>) => void }, paths?: { inbox: string }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-inbox-"));
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: Inbox test\n");
  await initializeWikiCabinet(root, { enabled: true, paths });
  const db = new Database(path.join(root, ".cabinet.db"));
  db.pragma("journal_mode = WAL");
  runSqlMigrations(db, path.resolve("server/migrations"));
  const queue = await IngestionQueue.open(db, root);
  const watcher = new InboxWatcher(root, async () => queue, { stabilityMs: 80 });
  t.after(async () => { await watcher.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  return { root, db, queue, watcher, inbox: path.join(root, paths?.inbox ?? "Inbox") };
}

test("Inbox filter excludes hidden state, temp/download files, and traversal", () => {
  for (const name of [".DS_Store", ".agents/a.md", "node_modules/a.md", "a.pdf.crdownload", "a.part", "a.tmp", "a.swp", "a.md~", "../escape", "a\\b"]) assert.equal(isInboxCandidate(name), false, name);
  for (const name of ["article.html", "Notes/a.md", "experiment.ipynb", "proposal.docx"]) assert.equal(isInboxCandidate(name), true, name);
});

test("startup discovers existing files with auto-ingest off; manual ingest queues only once", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.inbox);
  await fs.writeFile(path.join(f.inbox, "article.html"), "existing");
  await f.watcher.start();
  await until(() => f.watcher.status().items[0]?.status === "awaiting", "manual candidate");
  assert.equal(f.queue.list().length, 0);
  await f.watcher.ingestAll();
  await until(() => f.queue.list().length === 1, "manual queue");
  await f.watcher.ingestAll();
  assert.equal(f.queue.list().length, 1);
  assert.equal(f.queue.list()[0].status, "queued");
  assert.equal(await fs.readFile(path.join(f.inbox, "article.html"), "utf8"), "existing");
});

test("automatic detection hashes stabilized multi-write contents and ignores same-content saves", async (t) => {
  const f = await fixture(t);
  await f.watcher.start();
  await f.watcher.setAutomatic(true);
  const file = path.join(f.inbox, "article.md");
  await fs.writeFile(file, "part");
  await new Promise((resolve) => setTimeout(resolve, 30));
  await fs.appendFile(file, " two");
  await until(() => f.queue.list().length === 1, "automatic queue");
  assert.equal(f.queue.list()[0].contentHash, createHash("sha256").update("part two").digest("hex"));
  await fs.writeFile(file, "part two");
  await new Promise((resolve) => setTimeout(resolve, 450));
  assert.equal(f.queue.list().length, 1);
  await fs.writeFile(file, "new content");
  await until(() => f.queue.list().length === 2, "changed content queue");
});

test("Raw, Wiki, hidden folders and symlinks never feed ingestion", async (t) => {
  const f = await fixture(t);
  await f.watcher.start();
  await f.watcher.setAutomatic(true);
  for (const folder of ["raw", "wiki", "Inbox/.hidden"]) {
    await fs.mkdir(path.join(f.root, folder), { recursive: true });
    await fs.writeFile(path.join(f.root, folder, "ignored.md"), "ignored");
  }
  await fs.writeFile(path.join(f.inbox, "download.pdf.part"), "partial");
  await fs.symlink(path.join(f.root, "raw"), path.join(f.inbox, "linked"), "dir");
  await fs.writeFile(path.join(f.inbox, "valid.md"), "valid");
  await until(() => f.queue.list().length === 1, "valid queue");
  assert.equal(f.queue.list()[0].input?.path, "Inbox/valid.md");
  assert.equal(f.watcher.status().items.length, 1);
});

test("unlink removes staging candidate without deleting its durable job", async (t) => {
  const f = await fixture(t);
  await f.watcher.start();
  await f.watcher.setAutomatic(true);
  const file = path.join(f.inbox, "gone.md");
  await fs.writeFile(file, "evidence");
  await until(() => f.queue.list().length === 1, "queue before unlink");
  await fs.unlink(file);
  await until(() => f.watcher.status().items.length === 0, "unlink candidate");
  assert.equal(f.queue.list().length, 1);
  assert.equal(f.queue.list()[0].operation, "create");
});

test("restart recognizes existing queued contents and respects custom Inbox paths", async (t) => {
  const f = await fixture(t, { inbox: "Incoming" });
  await f.watcher.start();
  await f.watcher.setAutomatic(true);
  await fs.writeFile(path.join(f.inbox, "a.md"), "existing");
  await until(() => f.queue.list().length === 1, "first watcher");
  await f.watcher.close();
  const reopened = new InboxWatcher(f.root, async () => f.queue, { stabilityMs: 80 });
  try {
    await reopened.start();
    await until(() => reopened.status().queued === 1, "reopened watcher");
    assert.equal(f.queue.list().length, 1);
    assert.equal(f.queue.list()[0].input?.path, "Incoming/a.md");
  } finally { await reopened.close(); }
});

test("automatic mode queues waiting items; turning it off leaves later files awaiting", async (t) => {
  const f = await fixture(t);
  await f.watcher.start();
  await fs.writeFile(path.join(f.inbox, "first.md"), "first");
  await until(() => f.watcher.status().items[0]?.status === "awaiting", "waiting");
  await f.watcher.setAutomatic(true);
  await until(() => f.queue.list().length === 1, "enable automatic");
  await f.watcher.setAutomatic(false);
  await fs.writeFile(path.join(f.inbox, "second.md"), "second");
  await until(() => f.watcher.status().items.some((item) => item.path.endsWith("second.md") && item.status === "awaiting"), "disabled automatic");
  assert.equal(f.queue.list().length, 1);
});

test("feature disable closes the watcher and close cancels pending work", async (t) => {
  const f = await fixture(t);
  await f.watcher.start();
  await f.watcher.setAutomatic(true);
  await setWikiEnabled(f.root, false);
  await until(() => !f.watcher.status().watching, "disabled watcher");
  await fs.writeFile(path.join(f.inbox, "disabled.md"), "disabled");
  await f.watcher.close();
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(f.queue.list().length, 0);
});

test("queue failure is visible and a manual rescan can retry validation", async (t) => {
  const f = await fixture(t);
  let fail = true;
  const queue = new Proxy(f.queue, { get(target, key) {
    if (key === "enqueue") return async (...args: Parameters<IngestionQueue["enqueue"]>) => {
      if (fail) throw new Error("temporary database failure");
      return target.enqueue(...args);
    };
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
  const watcher = new InboxWatcher(f.root, async () => queue, { stabilityMs: 80 });
  try {
    await watcher.start();
    await watcher.setAutomatic(true);
    await fs.writeFile(path.join(f.inbox, "retry.md"), "retry");
    await until(() => watcher.status().failed === 1, "visible error");
    fail = false;
    await watcher.ingestAll();
    await until(() => watcher.status().queued === 1, "retry succeeds");
  } finally { await watcher.close(); }
});

test("partial download is ignored until renamed; oversized files are reported without queueing", async (t) => {
  const f = await fixture(t);
  await f.watcher.start();
  await f.watcher.setAutomatic(true);
  await fs.writeFile(path.join(f.inbox, "article.md.part"), "downloaded");
  const huge = await fs.open(path.join(f.inbox, "huge.pdf"), "w");
  await huge.truncate(500 * 1024 * 1024 + 1);
  await huge.close();
  await until(() => f.watcher.status().failed === 1, "oversize error");
  assert.equal(f.queue.list().length, 0);
  await fs.rename(path.join(f.inbox, "article.md.part"), path.join(f.inbox, "article.md"));
  await until(() => f.queue.list().length === 1, "completed download");
  assert.equal(f.queue.list()[0].input?.path, "Inbox/article.md");
});
