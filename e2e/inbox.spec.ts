import { expect, test } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import yaml from "js-yaml";
import { bootCabinet, type CabinetInstance } from "../test/support/harness";

let cabinet: CabinetInstance;
test.beforeAll(async () => {
  cabinet = await bootCabinet({ files: {
    ".home/home.json": JSON.stringify({ schemaVersion: 1, kind: "home", activeCabinet: "Cabinet" }),
    "Cabinet/.cabinet": JSON.stringify({ schemaVersion: 1, kind: "root", name: "Inbox test", llmWiki: {
      schemaVersion: 1, cabinetId: randomUUID(), enabled: true, autoIngestInbox: false,
      paths: { inbox: "Inbox", raw: "raw", wiki: "wiki" },
    } }),
    "Cabinet/.agents/.config/workspace.json": JSON.stringify({ exists: true, version: 2, home: { name: "Test" }, cabinet: { name: "Test" } }),
    "Cabinet/Inbox/article.md": "Preserve this original.\n",
    "Cabinet/.agents/.runtime/daemon-token": randomUUID(),
  } });
});
test.afterAll(async () => {
  if (!cabinet) return;
  try {
    // The shared harness launches tsx through npx. Stop its daemon child before
    // the harness deletes the watched temporary root (npx may not forward SIGTERM).
    const token = (await cabinet.read("Cabinet/.agents/.runtime/daemon-token")).trim();
    await fetch(`${cabinet.daemonUrl}/restart`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    await expect.poll(async () => {
      try { return (await fetch(`${cabinet.daemonUrl}/health`)).ok; } catch { return false; }
    }).toBe(false);
  } finally { await cabinet.close(); }
});

test("Inbox settings show pending items, queue manually, and persist automatic mode", async ({ page, request }) => {
  expect((await request.get(`${cabinet.daemonUrl}/ingestion/inbox`)).status()).toBe(401);
  await expect.poll(async () => (await (await request.get(`${cabinet.appUrl}/api/ingestion/inbox`)).json()).pending).toBe(1);
  expect((await request.post(`${cabinet.appUrl}/api/ingestion/inbox`, { data: { action: "set-automatic", enabled: "yes" } })).status()).toBe(400);
  expect((await request.post(`${cabinet.appUrl}/api/ingestion/inbox`, { data: "x".repeat(5000) })).status()).toBe(413);
  await page.addInitScript(() => {
    localStorage.setItem("cabinet.tour-done", "1");
    localStorage.setItem("cabinet.wizard-done", "1");
  });
  await page.goto(`${cabinet.appUrl}/settings/storage`);
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await expect(inbox).toBeVisible();
  await expect(inbox.getByRole("checkbox")).not.toBeChecked();
  await inbox.getByRole("button", { name: "Ingest all" }).click();
  await expect(inbox).toContainText("Submitted to the queue: 1", { timeout: 20000 });
  await inbox.getByRole("checkbox").check();
  await fs.writeFile(path.join(cabinet.dataDir, "Cabinet/Inbox/second.md"), "Second original.\n");
  await expect(inbox).toContainText("Submitted to the queue: 2", { timeout: 20000 });
  const manifest = yaml.load(await cabinet.read("Cabinet/.cabinet")) as { llmWiki: { autoIngestInbox: boolean } };
  expect(manifest.llmWiki.autoIngestInbox).toBe(true);
  await inbox.screenshot({ path: "/private/tmp/cabinet-phase4-inbox.png" });
  expect(await cabinet.read("Cabinet/Inbox/article.md")).toBe("Preserve this original.\n");
  await page.reload();
  await expect(page.getByRole("region", { name: "Inbox", exact: true }).getByRole("checkbox")).toBeChecked();
});

test("daemon discovers a managed registration and queues changes and deletion while retaining evidence", async () => {
  const rootConfig = yaml.load(await cabinet.read("Cabinet/.cabinet")) as { llmWiki: { cabinetId: string } };
  const sourceId = randomUUID();
  const versionId = randomUUID();
  const rawPath = `raw/notes/managed-${sourceId}`;
  const root = path.join(cabinet.dataDir, "Cabinet");
  const original = "Captured original.";
  const changed = "Updated working file.";
  const workingPath = path.join(root, "managed.md");
  await fs.writeFile(workingPath, original);
  await fs.mkdir(path.join(root, rawPath, "v1"), { recursive: true });
  await fs.writeFile(path.join(root, rawPath, "v1/original.md"), original);
  const timestamp = new Date().toISOString();
  const manifest = JSON.stringify({ schemaVersion: 1, source: {
    id: sourceId, cabinetId: rootConfig.llmWiki.cabinetId, roomPath: null, title: "Managed", slug: "managed",
    rawPath, mode: "managed", managedLocation: { kind: "cabinet", path: "managed.md" }, status: "active",
    currentVersionId: versionId, lastCompiledVersionId: null, createdAt: timestamp, updatedAt: timestamp,
  }, versions: [{ id: versionId, sourceId, cabinetId: rootConfig.llmWiki.cabinetId, version: 1,
    contentHash: createHash("sha256").update(original).digest("hex"), originalPath: `${rawPath}/v1/original.md`,
    markdownPath: `${rawPath}/v1/source.md`, originalFormat: "md", createdAt: timestamp }] });
  await fs.writeFile(path.join(root, rawPath, "manifest.yaml"), manifest);
  const db = new Database(path.join(root, ".cabinet.db"), { readonly: true });
  const jobs = () => db.prepare("SELECT operation,content_hash,status FROM llm_wiki_jobs WHERE source_id=? ORDER BY sequence").all(sourceId);
  try {
    await fs.writeFile(workingPath, changed);
    await expect.poll(jobs, { timeout: 15000 }).toEqual([{ operation: "update",
      content_hash: createHash("sha256").update(changed).digest("hex"), status: "queued" }]);
    await fs.unlink(workingPath);
    await expect.poll(jobs, { timeout: 15000 }).toHaveLength(2);
    expect(jobs()[1]).toEqual({ operation: "delete", content_hash: null, status: "queued" });
    expect(await fs.readFile(path.join(root, rawPath, "manifest.yaml"), "utf8")).toBe(manifest);
    expect(await fs.readFile(path.join(root, rawPath, "v1/original.md"), "utf8")).toBe(original);
  } finally { db.close(); }
});
