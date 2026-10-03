import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { bootCabinet, type CabinetInstance } from "../test/support/harness";
import { claudeReply } from "../test/support/fake-agent-cli";
import { emptyConfig, type RssArticle, type RssBrief, type RssState } from "../src/lib/rss/types";

let cabinet: CabinetInstance;
const timestamp = new Date().toISOString();
const feed = { id: "news", name: "Technology", url: "https://news.invalid/feed", folder: "Tech", enabled: true, addedAt: timestamp };
const article: RssArticle = { id: "article", feedId: "news", title: "Useful technology update", url: "https://example.com/article", text: "A useful development in technology.", html: '<p>A useful development.</p><img src="https://tracker.invalid/pixel"><script>window.rssAttack=true</script>', authors: ["Alice"], categories: ["Tech"], language: "en", publishedAt: timestamp, firstSeenAt: timestamp, read: false };
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const persona = '---\nname: Writer\nslug: writer\nrole: RSS summarization\nprovider: claude-code\nadapterType: claude_local\nactive: true\nheartbeatEnabled: false\nworkdir: /data\n---\nYou summarize RSS articles.\n';
  cabinet = await bootCabinet({ fakeAgents: [{ name: "claude", fallback: claudeReply("# Technology brief\n\nA useful technology update. [Source](https://example.com/article)") }], files: {
    "alpha/.cabinet": "schemaVersion: 1\nname: Alpha\nkind: room\n",
    "beta/.cabinet": "schemaVersion: 1\nname: Beta\nkind: room\n",
    "alpha/.agents/writer/persona.md": persona,
    "alpha/.agents/.config/rss.json": JSON.stringify({ ...emptyConfig(), feeds: [feed] }),
    "alpha/.agents/.runtime/rss/news.json": JSON.stringify({ version: 1, articles: [article], seen: [article.id], checkedAt: timestamp, error: null }),
    ".agents/.runtime/daemon-token": randomUUID(),
  } });
});
test.afterAll(async () => {
  if (!cabinet) return;
  try { const token = (await cabinet.read(".agents/.runtime/daemon-token")).trim(); await fetch(`${cabinet.daemonUrl}/restart`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }); }
  finally { await cabinet.close(); }
});
test("RSS settings, reversible filtering, reading state, room isolation and OPML exchange", async ({ page, request }) => {
  expect((await request.get(`${cabinet.daemonUrl}/rss/state?room=alpha`)).status()).toBe(401);
  expect((await request.post(`${cabinet.appUrl}/api/rss/prepare`, { data: { room: "alpha" } })).status()).toBe(404);
  expect((await request.get(`${cabinet.appUrl}/api/rss/state?room=..`)).status()).toBe(404);
  expect((await request.get(`${cabinet.appUrl}/api/rss/export?room=missing`)).status()).toBe(404);
  expect((await request.post(`${cabinet.appUrl}/api/rss/action`, { data: { room: "beta", action: "read", id: article.id, read: true } })).status()).toBe(404);
  expect((await request.post(`${cabinet.appUrl}/api/rss/action`, { data: { room: "beta", action: "feed-save", url: "http://127.0.0.1/feed", name: "Private", folder: "", enabled: true } })).status()).toBe(400);
  await page.addInitScript(() => { localStorage.setItem("cabinet.tour-done", "1"); localStorage.setItem("cabinet.wizard-done", "1"); });
  await page.goto(`${cabinet.appUrl}/settings/rss`);
  await expect(page.getByLabel("Room", { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByLabel("Room", { exact: true }).selectOption("alpha");
  await expect(page.getByRole("region", { name: "Subscriptions", exact: true })).toContainText("Technology");
  await page.getByRole("button", { name: "Add exclusion rule", exact: true }).click();
  await page.getByLabel("Rule name", { exact: true }).fill("Hide technology");
  await page.getByLabel("Value 1", { exact: true }).fill("technology");
  await page.getByRole("button", { name: "Preview matches", exact: true }).click();
  await expect(page.getByRole("region", { name: "Filtering", exact: true }).getByRole("status")).toContainText("Matching articles: 1");
  await page.getByRole("region", { name: "Filtering", exact: true }).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await (await request.get(`${cabinet.appUrl}/api/rss/state?room=alpha`)).json()).config.rules.length).toBe(1);
  await page.getByRole("button", { name: "Open RSS reader", exact: true }).click();
  await expect(page).toHaveURL(/\/room\/alpha\/-\/rss/);
  await expect(page.getByText("No matching articles.", { exact: false })).toBeVisible();
  await page.getByLabel("Show excluded", { exact: true }).check();
  await page.getByRole("button", { name: /Useful technology update/ }).click();
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toBeVisible();
  await expect(page.locator("article img, article script, article iframe")).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`${cabinet.appUrl}/api/rss/articles?room=alpha&excluded=1`)).json()).articles[0].read).toBe(true);
  await page.reload();
  await page.getByLabel("Room", { exact: true }).selectOption("beta");
  await expect(page.getByRole("button", { name: /Useful technology update/ })).toHaveCount(0);
  await page.goto(`${cabinet.appUrl}/settings/rss`);
  await page.getByLabel("Room", { exact: true }).selectOption("alpha");
  const opml = '<opml version="2.0"><body><outline text="Tech"><outline text="Technology" xmlUrl="https://news.invalid/feed"/><outline text="Second feed" xmlUrl="https://second.invalid/feed"/></outline></body></opml>';
  await page.getByLabel("Import OPML", { exact: true }).setInputFiles({ name: "feeds.opml", mimeType: "text/xml", buffer: Buffer.from(opml) });
  await expect(page.getByText("Duplicates skipped: 1", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Merge subscriptions", exact: true }).click();
  await expect(page.getByText("Imported: 1", { exact: false })).toBeVisible();
  const exported = await request.get(`${cabinet.appUrl}/api/rss/export?room=alpha`);
  expect(exported.headers()["content-disposition"]).toContain(".opml");
  expect(await exported.text()).toContain("second.invalid/feed");
});
test("named briefs use the fake room agent and publish dated source-linked pages", async ({ request, page }) => {
  let state = await (await request.get(`${cabinet.appUrl}/api/rss/state?room=alpha`)).json() as RssState;
  for (const rule of state.config.rules) await request.post(`${cabinet.appUrl}/api/rss/action`, { data: { room: "alpha", action: "rule-remove", id: rule.id } });
  state = await (await request.get(`${cabinet.appUrl}/api/rss/state?room=alpha`)).json() as RssState;
  const brief: RssBrief = { id: "daily", name: "Technology daily", agentSlug: "writer", feedIds: ["news"], folders: [], instructions: "Summarize the technology update and cite its source.", schedule: "0 9 * * *", enabled: false, outputFolder: "RSS Briefs/Technology", maxArticles: 10, maxBytes: 20000 };
  const saved = await request.post(`${cabinet.appUrl}/api/rss/action`, { data: { room: "alpha", action: "brief-save", revision: state.config.revision, brief } });
  expect(saved.ok(), await saved.text()).toBe(true);
  const started = await request.post(`${cabinet.appUrl}/api/rss/action`, { data: { room: "alpha", action: "brief-run", id: brief.id } });
  expect(started.ok(), await started.text()).toBe(true);
  await expect.poll(async () => (await (await request.get(`${cabinet.appUrl}/api/rss/state?room=alpha`)).json()).runs[0]?.status, { timeout: 60000 }).toBe("completed");
  state = await (await request.get(`${cabinet.appUrl}/api/rss/state?room=alpha`)).json() as RssState;
  const run = state.runs[0];
  expect(run.pagePath).toMatch(/^alpha\/RSS Briefs\/Technology\/\d{4}-\d{2}-\d{2}-/);
  expect(await cabinet.read(run.pagePath!)).toContain("https://example.com/article");
  const invocations = await cabinet.agent("claude").waitForInvocations(1);
  const briefInvocation = invocations.find((invocation) => invocation.stdin.includes("BEGIN UNTRUSTED SOURCE DATA"));
  expect(briefInvocation).toBeDefined();
  expect(briefInvocation!.stdin).toContain(article.text);
  expect(briefInvocation!.stdin).not.toContain(feed.url);
  expect((await (await request.get(`${cabinet.appUrl}/api/rss/state?room=beta`)).json()).runs).toEqual([]);
  await page.addInitScript(() => { localStorage.setItem("cabinet.wizard-done", "1"); localStorage.setItem("cabinet.tour-done", "1"); });
  await page.goto(`${cabinet.appUrl}/settings/rss`);
  await page.getByLabel("Room", { exact: true }).selectOption("alpha");
  const briefs = page.getByRole("region", { name: "AI briefs", exact: true });
  await expect(briefs.getByRole("link", { name: "Open brief", exact: true })).toBeVisible();
  await briefs.getByRole("button", { name: "Add brief", exact: true }).click();
  await briefs.getByLabel("Name", { exact: true }).fill("Another daily brief");
  await expect(briefs.getByLabel("Enable scheduled runs", { exact: true })).not.toBeChecked();
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/rss/action") && response.request().method() === "POST", { timeout: 15000 });
  await briefs.getByRole("button", { name: "Save", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(briefs).toContainText("Another daily brief");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${cabinet.appUrl}/room/alpha/-/rss`);
  await expect(page.getByLabel("Room", { exact: true })).toHaveValue("alpha");
  await page.getByRole("button", { name: /Useful technology update/ }).click();
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toBeVisible();
});
