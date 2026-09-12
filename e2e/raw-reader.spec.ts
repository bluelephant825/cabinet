import { test, expect, type Route } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { bootCabinet, type CabinetInstance } from "../test/support/harness";
import { initializeWikiCabinet } from "../src/lib/llm-wiki/config";
import { SourceStore } from "../src/lib/llm-wiki/source-store";
import { RawPublicationStore } from "../src/lib/llm-wiki/raw-publication";
import { SourceNormalizationService } from "../src/lib/llm-wiki/normalizers";
let cabinet: CabinetInstance;
let rawPath: string;
let historyPath: string;
let firstVersion: string;
let secondVersion: string;
test.beforeAll(async () => {
  const seed = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-reader-seed-"));
  try {
    const root = path.join(seed, "Cabinet");
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: Sources\n");
    await initializeWikiCabinet(root, { enabled: true });
    const entry = await new SourceStore(root).register({ mode: "snapshot", title: "Coffee research", classification: "research", roomPath: null });
    rawPath = entry.source.rawPath;
    const bytes = Buffer.from('<h1>Original coffee report</h1><p>Captured findings.</p><script>parent.__rawExecuted = true</script><img src="https://tracker.invalid/pixel"><a href="/api/pages">Do not navigate</a>');
    const normalizer = new SourceNormalizationService({ async convert() {
      return { markdown: '# Coffee research\n\nA captured report on brewing.\n\n| Method | Score |\n|---|---|\n| Filter | 8 |\n| Espresso | 9 |\n\n> [!NOTE]\n> Measurements were repeated.\n\n```js\nconsole.log("inert example");\n```\n\n[Reference](https://example.org)', metadata: {}, assets: [], warnings: [], converter: { name: "fixture", version: "1" } };
    } });
    await new RawPublicationStore(root).publishInitial(entry.source.id,
      await normalizer.normalize({ path: "report.html", bytes, contentHash: createHash("sha256").update(bytes).digest("hex") }));
    await fs.writeFile(path.join(root, "working.md"), "Working document");
    const managed = await new SourceStore(root).register({ mode: "managed", title: "Versioned report", classification: "research", roomPath: null,
      managedLocation: { kind: "cabinet", path: "working.md" } });
    historyPath = managed.source.rawPath;
    const captured = async (value: string) => {
      const content = Buffer.from(value);
      return new SourceNormalizationService().normalize({ path: "working.md", bytes: content, contentHash: createHash("sha256").update(content).digest("hex") });
    };
    const publisher = new RawPublicationStore(root);
    const first = await publisher.publishInitial(managed.source.id, await captured("# Version one\nEarlier findings."));
    firstVersion = first.versions[0].id;
    const second = await publisher.publishUpdate(managed.source.id, first.versions[0].id, await captured("# Version two\nLatest findings."));
    secondVersion = second.versions[1].id;
    await fs.mkdir(path.join(seed, ".home"));
    await fs.writeFile(path.join(seed, ".home/home.json"), JSON.stringify({ schemaVersion: 1, kind: "home", activeCabinet: "Cabinet" }));
    cabinet = await bootCabinet({ seed, files: {
      "Cabinet/.agents/.config/workspace.json": JSON.stringify({ exists: true, version: 2, home: { name: "Test" }, cabinet: { name: "Test" } }),
      "Cabinet/.agents/.runtime/daemon-token": randomUUID(),
    } });
  } finally { await fs.rm(seed, { recursive: true, force: true }); }
});
test.afterAll(async () => {
  if (!cabinet) return;
  try {
    const token = (await cabinet.read("Cabinet/.agents/.runtime/daemon-token")).trim();
    await fetch(`${cabinet.daemonUrl}/restart`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    await expect.poll(async () => { try { return (await fetch(`${cabinet.daemonUrl}/health`)).ok; } catch { return false; } }).toBe(false);
  } finally { await cabinet.close(); }
});
test("captured Source switches views, keeps preferences, and blocks unsafe content and writes", async ({ page, request }) => {
  await page.addInitScript(() => { localStorage.setItem("cabinet.tour-done", "1"); localStorage.setItem("cabinet.wizard-done", "1"); });
  let remoteRequests = 0;
  page.on("request", (req) => { if (req.url().includes("tracker.invalid")) remoteRequests++; });
  await page.goto(`${cabinet.appUrl}/room/${rawPath}/v1/source`);
  const viewer = page.getByRole("region", { name: "Captured source" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("combobox", { name: "Source version" })).toHaveCount(0);
  await expect(viewer.getByRole("table")).toContainText("Espresso");
  await viewer.getByRole("tab", { name: "Markdown", exact: true }).click();
  await expect(viewer.getByRole("tabpanel")).toContainText("source_version_id:");
  await expect(viewer.locator("textarea,[contenteditable=true]")).toHaveCount(0);
  await page.reload();
  await expect(viewer.getByRole("tab", { name: "Markdown", exact: true })).toHaveAttribute("aria-selected", "true");
  await viewer.getByRole("tab", { name: "Original", exact: true }).click();
  const frame = page.frameLocator('iframe[title="Original HTML preview"]');
  await expect(frame.getByRole("heading", { name: "Original coffee report" })).toBeVisible();
  await expect(frame.locator("script,a[href],img[src]")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __rawExecuted?: boolean }).__rawExecuted)).toBeUndefined();
  expect(remoteRequests).toBe(0);
  const download = viewer.getByRole("link", { name: "Download original" });
  const response = await request.get(`${cabinet.appUrl}${await download.getAttribute("href")}`);
  expect(response.headers()["content-disposition"]).toContain("attachment");
  expect(await response.text()).toContain("parent.__rawExecuted");
  expect((await request.put(`${cabinet.appUrl}/api/pages/${rawPath}/v1/source`, { data: { content: "altered" } })).status()).toBe(403);
  expect((await request.delete(`${cabinet.appUrl}/api/assets/${rawPath}/v1/original.html`)).status()).toBe(403);
  expect((await request.get(`${cabinet.appUrl}/api/assets/${rawPath}/v1/original.html`)).status()).toBe(403);
  expect((await request.post(`${cabinet.appUrl}/api/upload/${rawPath}/v1`, { multipart: { file: { name: "extra.txt", mimeType: "text/plain", buffer: Buffer.from("altered") } } })).status()).toBe(403);
  expect((await request.patch(`${cabinet.appUrl}/api/pages/${rawPath}`, { data: { rename: "changed" } })).status()).toBe(403);
  expect((await request.post(`${cabinet.appUrl}/api/git/restore`, { data: { hash: "HEAD", pagePath: `${rawPath}/v1/source.md` } })).ok()).toBe(false);
  await viewer.getByRole("tab", { name: "Reader", exact: true }).click();
  await viewer.getByRole("tab", { name: "Reader", exact: true }).press("ArrowRight");
  await expect(viewer.getByRole("tab", { name: "Original", exact: true })).toHaveAttribute("aria-selected", "true");
  await viewer.getByRole("tab", { name: "Reader", exact: true }).click();
  await viewer.screenshot({ path: "/private/tmp/cabinet-phase13-reader.png" });
});


test("version selector keeps historical views and downloads aligned and defaults back to current on reload", async ({ page, request }) => {
  await page.addInitScript(() => { localStorage.setItem("cabinet.tour-done", "1"); localStorage.setItem("cabinet.wizard-done", "1"); });
  await page.goto(`${cabinet.appUrl}/room/${historyPath}`);
  const viewer = page.getByRole("region", { name: "Captured source" });
  const selector = viewer.getByRole("combobox", { name: "Source version" });
  await expect(selector).toHaveValue(secondVersion);
  await expect(selector.locator("option").first()).toContainText("v2 · Current");
  await expect(selector.locator("option").last()).toContainText("v1 · Superseded");
  await viewer.getByRole("tab", { name: "Markdown", exact: true }).click();
  await selector.selectOption(firstVersion);
  await expect(viewer.getByRole("tabpanel")).toContainText("Earlier findings.");
  await expect(viewer.getByRole("tab", { name: "Markdown", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(viewer.getByRole("tabpanel")).toContainText(firstVersion);
  await viewer.getByRole("tab", { name: "Original", exact: true }).click();
  await expect(viewer.getByRole("tabpanel")).toHaveText("# Version one\nEarlier findings.");
  const original = await request.get(`${cabinet.appUrl}${await viewer.getByRole("link", { name: "Download original" }).getAttribute("href")}`);
  expect(await original.text()).toBe("# Version one\nEarlier findings.");
  await viewer.getByRole("tab", { name: "Reader", exact: true }).click();
  await expect(viewer.getByRole("heading", { name: "Version one" })).toBeVisible();
  await viewer.screenshot({ path: "/private/tmp/cabinet-phase14-versions.png" });
  await page.reload();
  await expect(selector).toHaveValue(secondVersion);
  await expect(viewer.getByRole("heading", { name: "Version two" })).toBeVisible();
  let release!: () => void;
  let started!: () => void;
  let finished!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const intercepted = new Promise<void>((resolve) => { started = resolve; });
  const settled = new Promise<void>((resolve) => { finished = resolve; });
  const delayOld = async (route: Route) => {
    if (new URL(route.request().url()).searchParams.get("version") !== firstVersion) { await route.continue(); return; }
    const response = await route.fetch();
    started();
    await held;
    try { await route.fulfill({ response }); } catch { /* The obsolete request is cancelled. */ }
    finally { finished(); }
  };
  await page.route("**/api/llm-wiki/reader?**", delayOld);
  await selector.selectOption(firstVersion);
  await intercepted;
  await expect(viewer.getByRole("link", { name: "Download original" })).toHaveCount(0);
  await selector.selectOption(secondVersion);
  await expect(viewer.getByRole("heading", { name: "Version two" })).toBeVisible();
  release();
  await settled;
  await expect(selector).toHaveValue(secondVersion);
  await expect(viewer.getByRole("heading", { name: "Version two" })).toBeVisible();
  await page.unroute("**/api/llm-wiki/reader?**", delayOld);
  await page.route("**/api/llm-wiki/reader?**", async (route) => {
    if (new URL(route.request().url()).searchParams.get("version") === firstVersion) await route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "Evidence integrity mismatch" }) });
    else await route.continue();
  });
  await selector.selectOption(firstVersion);
  await expect(viewer.getByRole("alert")).toContainText("previous version is still displayed");
  await expect(selector).toHaveValue(secondVersion);
  await expect(viewer.getByRole("heading", { name: "Version two" })).toBeVisible();
  await page.unroute("**/api/llm-wiki/reader?**");
  await page.goto(`${cabinet.appUrl}/room/${historyPath}/v1/source`);
  await expect(selector).toHaveValue(firstVersion);
  await expect(viewer.getByRole("heading", { name: "Version one" })).toBeVisible();
  await page.reload();
  await expect(selector).toHaveValue(firstVersion);
});
