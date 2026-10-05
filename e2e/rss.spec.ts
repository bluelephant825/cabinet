import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { bootCabinet, type CabinetInstance } from "../test/support/harness";
import { claudeReply } from "../test/support/fake-agent-cli";
import { emptyConfig, type RssArticle, type RssBrief, type RssState } from "../src/lib/rss/types";

let cabinet: CabinetInstance;
const timestamp = new Date().toISOString();
const feed = { id: "news", name: "Technology", url: "https://news.invalid/feed", folder: "Tech", enabled: true, addedAt: timestamp };
const article: RssArticle = { id: "article", feedId: "news", title: "Useful technology update", url: "https://example.com/article", text: "A useful development in technology.", html: '<p>A useful development.</p>' + '<p>More source content for reading.</p>'.repeat(60) + '<p><a href="https://example.com/related">Read source</a></p><img src="https://tracker.invalid/pixel"><script>window.rssAttack=true</script>', authors: ["Alice"], categories: ["Tech"], language: "en", publishedAt: timestamp, firstSeenAt: timestamp, read: false };
test.describe.configure({ mode: "serial" });
test.beforeAll(async () => {
  const persona = '---\nname: Writer\nslug: writer\nrole: RSS summarization\nprovider: claude-code\nadapterType: claude_local\nactive: true\nheartbeatEnabled: false\nworkdir: /data\n---\nYou summarize RSS articles.\n';
  const inactiveAssistant = '---\nname: Assistant\nslug: assistant\nrole: Personal assistant\ndepartment: personal\nprovider: claude-code\nadapterType: claude_local\nheartbeat: "0 8 * * *"\nactive: false\nheartbeatEnabled: true\nworkdir: /data\n---\nYou are the room assistant.\n';
  cabinet = await bootCabinet({ fakeAgents: [{ name: "claude", fallback: claudeReply("# Technology brief\n\nA useful technology update. [Source](https://example.com/article)") }], files: {
    "alpha/.cabinet": "schemaVersion: 1\nname: Alpha\nkind: room\n",
    "alpha/browser-preview.md": "# Local preview\n",
    "beta/.cabinet": "schemaVersion: 1\nname: Beta\nkind: room\n",
    "alpha/.agents/writer/persona.md": persona,
    "alpha/.agents/assistant/persona.md": inactiveAssistant,
    ".global-agents/shared-editor/persona.md": '---\nname: Shared Editor\nslug: shared-editor\nrole: Shared editing assistant\ndepartment: engineering\nprovider: claude-code\nadapterType: claude_local\nactive: true\nheartbeatEnabled: false\nworkdir: /data\n---\nYou edit content.\n',
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
  await page.addInitScript(() => {
    localStorage.setItem("cabinet.tour-done", "1"); localStorage.setItem("cabinet.wizard-done", "1");
    const sources = new Set<TestBrowserEventSource>();
    class TestBrowserEventSource extends EventTarget {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      constructor() { super(); sources.add(this); }
      close() { sources.delete(this); }
    }
    const NativeEventSource = window.EventSource;
    window.EventSource = new Proxy(NativeEventSource, { construct(target, args) { return String(args[0]).includes("channel=browser") ? new TestBrowserEventSource() : Reflect.construct(target, args); } });
    Object.assign(window, { emitBrowserEvent: (data: Record<string, unknown>) => { for (const source of sources) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) })); } });
  });
  await page.goto(`${cabinet.appUrl}/settings/rss`);
  await expect(page.getByLabel("Room", { exact: true })).toBeVisible({ timeout: 15000 });
  await page.getByLabel("Room", { exact: true }).selectOption("alpha");
  await expect(page.getByRole("region", { name: "Subscriptions", exact: true })).toContainText("Technology");
  await page.getByRole("button", { name: "Add exclusion rule", exact: true }).click();
  await page.getByLabel("Rule name", { exact: true }).fill("Hide technology");
  await expect(page.getByRole("region", { name: "Filtering", exact: true })).toContainText("gam* looks for an actual asterisk");
  await page.getByLabel("Value 1", { exact: true }).fill("technology*");
  await page.getByRole("button", { name: "Preview matches", exact: true }).click();
  await expect(page.getByRole("region", { name: "Filtering", exact: true }).getByRole("status")).toContainText("Matching articles: 0");
  await page.getByLabel("Value 1", { exact: true }).fill("technology");
  await page.getByRole("button", { name: "Preview matches", exact: true }).click();
  await expect(page.getByRole("region", { name: "Filtering", exact: true }).getByRole("status")).toContainText("Matching articles: 1");
  await page.getByRole("region", { name: "Filtering", exact: true }).getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(async () => (await (await request.get(`${cabinet.appUrl}/api/rss/state?room=alpha`)).json()).config.rules.length).toBe(1);
  await page.getByRole("button", { name: "Open RSS reader", exact: true }).click();
  await expect(page).toHaveURL(/\/room\/alpha\/-\/rss/);
  await expect(page.getByText("No matching articles.", { exact: false })).toBeVisible();
  await page.getByLabel("Show excluded", { exact: true }).check();
  await page.locator("main aside").getByRole("button", { name: /^Technology/ }).click();
  await page.getByRole("button", { name: /Useful technology update/ }).click();
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toBeVisible();
  await expect(page.locator("article img, article script, article iframe")).toHaveCount(0);
  await expect.poll(async () => (await (await request.get(`${cabinet.appUrl}/api/rss/articles?room=alpha&excluded=1`)).json()).articles[0].read).toBe(true);
  let externalOpens = 0;
  page.on("popup", (popup) => { externalOpens++; void popup.close(); });
  await page.context().route("https://example.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<html><body>Source page</body></html>" }));
  const browserNavigations: string[] = [];
  let openedTabs = 0;
  let tabUrl = "https://www.wikiwand.com/extension-installed";
  let tabTitle = "Wikiwand";
  const previousTabs = [{ id: "previous-one", targetId: "previous-one", url: "https://example.com/one", title: "Previous one", active: false }, { id: "previous-two", targetId: "previous-two", url: "https://example.com/two", title: "Previous two", active: false }];
  const tab = () => ({ id: "rss-browser", targetId: "rss-target", url: tabUrl, title: tabTitle, active: true });
  await page.route("**/api/browser/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/browser/bookmarks") return route.continue();
    if (path === "/api/browser/status") return route.fulfill({ json: { status: "running", available: true, eligible: true, version: "test", executablePath: null } });
    if (path === "/api/browser/tabs" && route.request().method() === "POST") { openedTabs++; tabUrl = route.request().postDataJSON().url; browserNavigations.push(tabUrl); return route.fulfill({ json: { tab: tab() } }); }
    if (path === "/api/browser/tabs") return route.fulfill({ json: { tabs: [...previousTabs, tab()] } });
    if (path === "/api/browser/tabs/rss-browser/navigate") {
      tabUrl = route.request().postDataJSON().url; browserNavigations.push(tabUrl); tabTitle = "Source page";
      await page.evaluate((tab) => (window as Window & { emitBrowserEvent?: (data: Record<string, unknown>) => void }).emitBrowserEvent!({ channel: "browser", type: "browser:tab", action: "updated", tab }), tab());
      return route.fulfill({ json: { tab: { ...tab(), title: "Wikiwand" } } });
    }
    if (path === "/api/browser/extensions") return route.fulfill({ json: { extensions: [] } });
    return route.fulfill({ json: { ok: true } });
  });
  const address = page.getByPlaceholder("Built-in browser ready. Click a link in a page to open it here.");
  await page.getByRole("link", { name: "Open original", exact: true }).click();
  await expect(address).toHaveValue(article.url!);
  await expect.poll(() => browserNavigations.includes(article.url!)).toBe(true);
  expect(openedTabs).toBe(0);
  await expect(page.getByRole("button", { name: "Source page", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Wikiwand", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Previous one", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Previous two", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toBeVisible();
  await expect(page.getByLabel("Show excluded", { exact: true })).toBeChecked();
  const bodyLink = page.locator("article").getByRole("link", { name: "Read source", exact: true });
  await bodyLink.scrollIntoViewIfNeeded();
  const scrollTop = await page.locator("article").evaluate((element) => element.scrollTop);
  expect(scrollTop).toBeGreaterThan(0);
  await bodyLink.click();
  await expect(address).toHaveValue("https://example.com/related");
  await page.locator("main").getByRole("button", { name: "Go back", exact: true }).click();
  await expect(page.locator("article")).toBeVisible();
  await expect.poll(() => page.locator("article").evaluate((element) => element.scrollTop)).toBe(scrollTop);
  await expect(page.getByLabel("Room", { exact: true })).toHaveValue("alpha");
  await expect(page.getByLabel("Show excluded", { exact: true })).toBeChecked();
  expect(externalOpens).toBe(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("link", { name: "Open original", exact: true }).click();
  await expect(address).toHaveValue(article.url!);
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toBeVisible();
  expect(externalOpens).toBe(0);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.unroute("**/api/browser/**");
  await page.context().unroute("https://example.com/**");
  await page.getByLabel("Show excluded", { exact: true }).uncheck();
  await expect(page.getByRole("button", { name: /Useful technology update/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toHaveCount(0);
  const filterState = await (await request.get(`${cabinet.appUrl}/api/rss/state?room=alpha`)).json() as RssState;
  const exclusionRule = filterState.config.rules[0];
  const disabledResponse = await request.post(`${cabinet.appUrl}/api/rss/action`, { data: { room: "alpha", action: "rule-save", revision: filterState.config.revision, rule: { ...exclusionRule, enabled: false } } });
  expect(disabledResponse.ok()).toBe(true);
  const disabledState = await disabledResponse.json() as RssState;
  await page.getByRole("button", { name: /Useful technology update/ }).click();
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toBeVisible();
  const enabledResponse = await request.post(`${cabinet.appUrl}/api/rss/action`, { data: { room: "alpha", action: "rule-save", revision: disabledState.config.revision, rule: exclusionRule } });
  expect(enabledResponse.ok()).toBe(true);
  await expect(page.getByRole("button", { name: /Useful technology update/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toHaveCount(0);
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
test("subscription removal uses an in-app confirmation with cancellation and retry", async ({ request, page }) => {
  const saved = await request.post(`${cabinet.appUrl}/api/rss/action`, { data: { room: "beta", action: "feed-save", name: "Removal test", url: "https://removal.invalid/feed", folder: "", enabled: false } });
  expect(saved.ok()).toBe(true);
  const initialState = await saved.json() as RssState;
  const target = initialState.feeds.find((item) => item.name === "Removal test")!;
  await page.addInitScript(() => { localStorage.setItem("cabinet.tour-done", "1"); localStorage.setItem("cabinet.wizard-done", "1"); window.confirm = () => false; });
  await page.goto(`${cabinet.appUrl}/settings/rss`);
  await page.getByLabel("Room", { exact: true }).selectOption("beta");
  const subscriptions = page.getByRole("region", { name: "Subscriptions", exact: true });
  const dialog = page.getByRole("dialog", { name: "Remove", exact: true });
  await expect(subscriptions).toContainText(target.name);
  await subscriptions.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(target.name);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(subscriptions).toContainText(target.name);
  expect((await (await request.get(`${cabinet.appUrl}/api/rss/state?room=beta`)).json()).feeds.some((item: { id: string }) => item.id === target.id)).toBe(true);
  await page.route("**/api/rss/action", async (route) => {
    if (route.request().postDataJSON().action === "feed-remove") return route.fulfill({ status: 500, json: { error: "Subscription removal failed" } });
    await route.continue();
  });
  await subscriptions.getByRole("button", { name: "Remove", exact: true }).click();
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Subscription removal failed");
  await page.waitForTimeout(5500);
  await expect(dialog.getByRole("alert")).toHaveText("Subscription removal failed");
  await expect(dialog.getByRole("button", { name: "Remove", exact: true })).toBeEnabled();
  expect((await (await request.get(`${cabinet.appUrl}/api/rss/state?room=beta`)).json()).feeds.some((item: { id: string }) => item.id === target.id)).toBe(true);
  await page.unroute("**/api/rss/action");
  await dialog.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(subscriptions).not.toContainText(target.name);
  await page.reload();
  await page.getByLabel("Room", { exact: true }).selectOption("beta");
  await expect(subscriptions).not.toContainText(target.name);
  expect((await (await request.get(`${cabinet.appUrl}/api/rss/state?room=beta`)).json()).feeds.some((item: { id: string }) => item.id === target.id)).toBe(false);
  expect((await (await request.get(`${cabinet.appUrl}/api/rss/state?room=alpha`)).json()).feeds.some((item: { id: string }) => item.id === feed.id)).toBe(true);
});
test("named briefs use the fake room agent and publish dated source-linked pages", async ({ request, page }) => {
  const personasUrl = `${cabinet.appUrl}/api/agents/personas?cabinetPath=alpha`;
  const overviewUrl = `${cabinet.appUrl}/api/cabinets/overview?path=alpha&visibility=own`;
  let assistant = (await (await request.get(personasUrl)).json()).personas.find((persona: { slug: string }) => persona.slug === "assistant");
  expect(assistant.active).toBe(false);
  const initialOverview = await (await request.get(overviewUrl)).json();
  expect(initialOverview.agents.find((agent: { slug: string }) => agent.slug === "assistant").active).toBe(false);
  const startedAssistant = await request.put(`${cabinet.appUrl}/api/agents/personas/assistant`, { data: { action: "toggle", cabinetPath: "alpha" } });
  expect(startedAssistant.ok()).toBe(true);
  expect((await startedAssistant.json()).active).toBe(true);
  assistant = (await (await request.get(personasUrl)).json()).personas.find((persona: { slug: string }) => persona.slug === "assistant");
  expect(assistant.active).toBe(true);
  expect((await (await request.get(overviewUrl)).json()).agents.find((agent: { slug: string }) => agent.slug === "assistant").active).toBe(true);
  const stoppedAssistant = await request.put(`${cabinet.appUrl}/api/agents/personas/assistant`, { data: { action: "toggle", cabinetPath: "alpha" } });
  expect(stoppedAssistant.ok()).toBe(true);
  expect((await stoppedAssistant.json()).active).toBe(false);
  await page.addInitScript(() => { localStorage.setItem("cabinet.wizard-done", "1"); localStorage.setItem("cabinet.tour-done", "1"); });
  await page.goto(`${cabinet.appUrl}/#/cabinet/alpha/agents`);
  const assistantCard = page.locator("main").getByRole("group", { name: "Assistant", exact: true });
  await expect(assistantCard).toContainText("Scope: Room");
  await expect(assistantCard).toContainText("Department: Personal");
  const sharedEditorCard = page.locator("main").getByRole("group", { name: "Shared Editor", exact: true });
  await expect(sharedEditorCard).toContainText("Scope: Global");
  await expect(sharedEditorCard).toContainText("Department: Engineering");
  await sharedEditorCard.getByRole("button", { name: "Shared Editor", exact: true }).click();
  await expect(page.locator("main").getByText("Scope: Global", { exact: true })).toBeVisible();
  await page.goto(`${cabinet.appUrl}/#/cabinet/alpha/agents`);
  await page.locator("main").getByRole("group", { name: "Assistant", exact: true }).getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.locator("main").getByText("Scope: Room", { exact: true })).toBeVisible();
  await expect(page.locator("main").getByText("Department: Personal", { exact: true })).toBeVisible();
  await page.goto(`${cabinet.appUrl}/#/cabinet/alpha/agents`);
  await expect(page.getByRole("switch", { name: "Start Assistant", exact: true })).toBeVisible();
  await page.route("**/api/agents/personas/assistant", async (route) => {
    if (route.request().method() === "PUT") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "toggle failed" }) });
    await route.continue();
  });
  await page.getByRole("switch", { name: "Start Assistant", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Start Assistant", exact: true })).toBeVisible();
  await page.unroute("**/api/agents/personas/assistant");
  await page.getByRole("switch", { name: "Start Assistant", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Stop Assistant", exact: true })).toBeVisible();
  expect((await (await request.get(personasUrl)).json()).personas.find((persona: { slug: string }) => persona.slug === "assistant").active).toBe(true);
  expect((await (await request.get(overviewUrl)).json()).agents.find((agent: { slug: string }) => agent.slug === "assistant").active).toBe(true);
  await page.getByRole("switch", { name: "Stop Assistant", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Start Assistant", exact: true })).toBeVisible();
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
  await expect(briefs.getByRole("group", { name: "Technology daily", exact: true })).toContainText("writer · Schedule off");
  await expect(briefs.getByRole("link", { name: "Open brief", exact: true })).toBeVisible();
  await briefs.getByRole("button", { name: "Add brief", exact: true }).click();
  await briefs.getByLabel("Name", { exact: true }).fill("Another daily brief");
  await briefs.getByLabel("Room agent", { exact: true }).selectOption("assistant");
  await expect(briefs.getByLabel("Room agent", { exact: true })).toHaveValue("assistant");
  await expect(briefs.locator('option[value="assistant"]')).toHaveText("Assistant (Disabled)");
  await expect(briefs.getByLabel("Enable scheduled runs", { exact: true })).not.toBeChecked();
  const responsePromise = page.waitForResponse((response) => response.url().endsWith("/api/rss/action") && response.request().method() === "POST", { timeout: 15000 });
  await briefs.getByRole("button", { name: "Save", exact: true }).click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(briefs).toContainText("Another daily brief");
  const secondBrief = (await (await request.get(`${cabinet.appUrl}/api/rss/state?room=alpha`)).json() as RssState).config.briefs.find((entry) => entry.name === "Another daily brief")!;
  const secondBriefCard = briefs.getByRole("group", { name: "Another daily brief" });
  await secondBriefCard.getByRole("button", { name: "Run now", exact: true }).click();
  const runDialog = page.getByRole("dialog");
  await expect(runDialog).toBeVisible();
  await runDialog.getByRole("button", { name: "Run now", exact: true }).click();
  await expect.poll(async () => ((await (await request.get(`${cabinet.appUrl}/api/rss/state?room=alpha`)).json()) as RssState).runs.find((entry) => entry.briefId === secondBrief.id)?.status, { timeout: 60000 }).toBe("completed");
  await expect(secondBriefCard).toContainText("completed");
  await page.evaluate(() => { Reflect.set(window, "rssNavigationMarker", true); });
  await secondBriefCard.getByRole("link", { name: "Open agent run", exact: true }).click();
  await expect(page.locator("main").getByRole("button", { name: "RSS: Another daily brief", exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, "rssNavigationMarker"))).toBe(true);
  await expect(page.locator("main").getByRole("button", { name: "Go back", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Back to RSS settings", exact: true }).click();
  await expect(page).toHaveURL(`${cabinet.appUrl}/settings/rss`);
  await expect(page.getByLabel("Room", { exact: true })).toHaveValue("alpha");
  await expect(secondBriefCard).toContainText("completed");
  await page.route("**/api/rss/action", async (route) => {
    if (route.request().postDataJSON().action === "brief-run") return route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "The linked job changed. Save the brief to reconcile its settings" }) });
    await route.continue();
  });
  await secondBriefCard.getByRole("button", { name: "Run now", exact: true }).click();
  const failedRunDialog = page.getByRole("dialog");
  await failedRunDialog.getByRole("button", { name: "Run now", exact: true }).click();
  await expect(briefs.getByRole("alert")).toContainText("The linked job changed");
  await page.unroute("**/api/rss/action");
  await page.setViewportSize({ width: 390, height: 844 });
  await secondBriefCard.getByRole("link", { name: "Open agent run", exact: true }).click();
  await page.getByRole("button", { name: "Back to RSS settings", exact: true }).click();
  await expect(page.getByLabel("Room", { exact: true })).toHaveValue("alpha");
  await page.goto(`${cabinet.appUrl}/settings/rss`);
  await page.getByLabel("Room", { exact: true }).selectOption("beta");
  const betaBriefs = page.getByRole("region", { name: "AI briefs", exact: true });
  await expect(betaBriefs.getByText(/Create a room-scoped agent/)).toBeVisible();
  await expect(betaBriefs.getByRole("button", { name: "Add brief", exact: true })).toBeDisabled();
  await expect(betaBriefs.getByRole("button", { name: "Open room agents", exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${cabinet.appUrl}/room/alpha/-/rss`);
  await expect(page.getByLabel("Room", { exact: true })).toHaveValue("alpha");
  await page.getByRole("button", { name: /Useful technology update/ }).click();
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toBeVisible();
  await page.evaluate(() => { window.confirm = () => false; });
  let deleteRequests = 0, allowDelete = false;
  await page.route("**/api/rss/action", async (route) => {
    if (route.request().postDataJSON().action === "article-delete") {
      deleteRequests++;
      if (!allowDelete) return route.fulfill({ status: 500, json: { error: "Article deletion failed. Please retry." } });
    }
    return route.continue();
  });
  await page.getByRole("article").getByRole("button", { name: "Delete article", exact: true }).click();
  const deleteDialog = page.getByRole("dialog", { name: "Delete article", exact: true });
  await expect(deleteDialog).toBeVisible();
  await expect(deleteDialog).toContainText(article.title);
  await deleteDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(deleteDialog).toHaveCount(0);
  expect(deleteRequests).toBe(0);
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toBeVisible();
  await page.getByRole("article").getByRole("button", { name: "Delete article", exact: true }).click();
  await deleteDialog.getByRole("button", { name: "Delete article", exact: true }).click();
  await expect(deleteDialog.getByRole("alert")).toContainText("Article deletion failed");
  expect(JSON.parse(await cabinet.read("alpha/.agents/.runtime/rss/news.json")).articles).toHaveLength(1);
  allowDelete = true;
  await deleteDialog.getByRole("button", { name: "Delete article", exact: true }).click();
  await expect(deleteDialog).toHaveCount(0);
  await expect(page.getByRole("heading", { name: article.title, exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /Useful technology update/ })).toHaveCount(0);
  expect(deleteRequests).toBe(2);
  await page.unroute("**/api/rss/action");
  await request.post(`${cabinet.appUrl}/api/rss/action`, { data: { room: "alpha", action: "refresh", feedId: feed.id } });
  await expect.poll(async () => JSON.parse(await cabinet.read("alpha/.agents/.runtime/rss/news.json")).checkedAt).not.toBe(timestamp);
  expect(JSON.parse(await cabinet.read("alpha/.agents/.runtime/rss/news.json")).articles).toHaveLength(0);
  expect(JSON.parse(await cabinet.read("alpha/.agents/.runtime/rss/news.json")).deleted).toContain(article.id);
});
test("browse mode restores the active page and all previous tabs without replaying a stale URL", async ({ page }) => {
  const activeUrl = "https://www.wikiwand.com/extension-installed";
  const tabs = [
    { id: "previous-one", targetId: "previous-one", url: "https://example.com/one", title: "Previous one", active: false },
    { id: "previous-two", targetId: "previous-two", url: "https://example.com/two", title: "Previous two", active: false },
    { id: "wiki", targetId: "wiki", url: activeUrl, title: "Wikiwand", active: true },
  ];
  const navigationCalls: string[] = [];
  await page.addInitScript(() => {
    localStorage.setItem("cabinet.wizard-done", "1"); localStorage.setItem("cabinet.tour-done", "1");
    sessionStorage.setItem("cabinet.browser.session", JSON.stringify({ history: ["https://example.com/stale-session"], index: 0, url: "https://example.com/stale-session" }));
  });
  await page.context().route("https://example.com/**", (route) => route.fulfill({ contentType: "text/html", body: "<html><body>Cached page</body></html>" }));
  await page.route("**/api/browser/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/browser/bookmarks") return route.continue();
    if (path === "/api/browser/status") return route.fulfill({ json: { status: "running", available: true, eligible: true, version: "test", executablePath: null } });
    if (path === "/api/browser/tabs" && route.request().method() === "GET") return route.fulfill({ json: { tabs } });
    if ((path === "/api/browser/tabs" || path.endsWith("/navigate")) && route.request().method() === "POST") navigationCalls.push(path);
    if (path === "/api/browser/extensions") return route.fulfill({ json: { extensions: [] } });
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto(`${cabinet.appUrl}/settings/rss`);
  const address = page.getByPlaceholder("Built-in browser ready. Click a link in a page to open it here.");
  for (let visit = 0; visit < 3; visit++) {
    await page.getByRole("button", { name: "Browse mode", exact: true }).click();
    await expect(address).toHaveValue(activeUrl);
    for (const title of ["Previous one", "Previous two", "Wikiwand"]) await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();
    expect(navigationCalls).toEqual([]);
    await page.getByRole("button", { name: "Edit mode", exact: true }).click();
    if (visit === 1) await page.reload();
  }
  tabs[2] = { ...tabs[2], url: "about:blank", title: "Blank session" };
  await page.getByRole("button", { name: "Browse mode", exact: true }).click();
  await expect(address).toHaveValue("about:blank");
  await expect(page.getByRole("button", { name: "Previous one", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Blank session", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Edit mode", exact: true }).click();
  tabs[2] = { ...tabs[2], url: activeUrl, title: "Wikiwand" };
  await page.goto(`${cabinet.appUrl}/room/alpha/browser-preview.md`);
  await page.getByRole("button", { name: "Browse mode", exact: true }).click();
  await expect(address).toHaveValue("/api/assets/alpha/browser-preview.md");
  await expect(page.getByRole("button", { name: "Previous one", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Wikiwand", exact: true }).click();
  await expect(address).toHaveValue(activeUrl);
  expect(navigationCalls).toEqual([]);
});

test("legacy root-room RSS run keeps Cabinet navigation even when its conversation is unavailable", async ({ page }) => {
  const brief: RssBrief = { id: "root-brief", name: "Root daily brief", agentSlug: "editor", feedIds: [], folders: [], instructions: "Summarize", schedule: "0 9 * * *", enabled: false, outputFolder: "RSS Briefs", maxArticles: 10, maxBytes: 20000 };
  const rootCabinet = await bootCabinet({ files: {
    ".cabinet": "schemaVersion: 1\nname: Root Study\nkind: room\n",
    ".agents/.config/rss.json": JSON.stringify({ ...emptyConfig(), briefs: [brief] }),
    ".agents/.runtime/rss/brief-runs.json": JSON.stringify([{ id: "root-run", briefId: brief.id, occurrence: timestamp, createdAt: timestamp, status: "completed", configRevision: 0, brief, articles: [], prompt: "", omitted: 0, conversationId: "missing-conversation" }]),
    ".agents/.runtime/daemon-token": randomUUID(),
  } });
  try {
    await page.addInitScript(() => { localStorage.setItem("cabinet.wizard-done", "1"); localStorage.setItem("cabinet.tour-done", "1"); });
    await page.goto(`${rootCabinet.appUrl}/settings/rss`);
    await expect(page.getByLabel("Room", { exact: true })).toHaveValue(".");
    await page.evaluate(() => { Reflect.set(window, "rssNavigationMarker", true); });
    await page.getByRole("group", { name: brief.name, exact: true }).getByRole("link", { name: "Open agent run", exact: true }).click();
    await expect(page.locator("main").getByText(/load task/)).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, "rssNavigationMarker"))).toBe(true);
    await page.getByRole("button", { name: "Back to RSS settings", exact: true }).click();
    await expect(page).toHaveURL(`${rootCabinet.appUrl}/settings/rss`);
    await expect(page.getByLabel("Room", { exact: true })).toHaveValue(".");
  } finally {
    try { const token = (await rootCabinet.read(".agents/.runtime/daemon-token")).trim(); await fetch(`${rootCabinet.daemonUrl}/restart`, { method: "POST", headers: { Authorization: `Bearer ${token}` } }); }
    finally { await rootCabinet.close(); }
  }
});
