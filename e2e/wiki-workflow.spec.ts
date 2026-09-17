import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { bootCabinet, type CabinetInstance } from "../test/support/harness";
import { claudeStream } from "../test/support/fake-agent-cli";
let cabinet: CabinetInstance;
const useCodex = process.env.CABINET_WIKI_TEST_PROVIDER === "codex";
const useGemini = process.env.CABINET_WIKI_TEST_PROVIDER === "gemini";
const useAntigravity = process.env.CABINET_WIKI_TEST_PROVIDER === "antigravity";
const agentName = useCodex ? "codex" : useGemini ? "gemini" : useAntigravity ? "agy" : "claude";
const agentProvider = useCodex ? "codex-cli" : useGemini ? "gemini-cli" : useAntigravity ? "antigravity-cli" : "claude-code";
const agentModel = useGemini ? "gemini-2.5-pro" : useAntigravity ? "gemini-3.8-flash-medium" : null;
const geminiStream = (value: unknown) => [
  JSON.stringify({ type: "init", session_id: randomUUID(), model: "gemini-2.5-pro" }),
  JSON.stringify({ type: "message", role: "assistant", content: JSON.stringify(value), delta: true }),
  JSON.stringify({ type: "result", status: "success" }),
];
const antigravityStream = (value: unknown) => [
  JSON.stringify({ event: "init", conversation_id: randomUUID(), init: { cwd: "/tmp/wiki", tools: ["run_command", "write_to_file"], permission_mode: "request-review", model: "gemini-3.8-flash-medium" } }),
  JSON.stringify({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: JSON.stringify(value) } }),
  JSON.stringify({ event: "result", result: { status: "SUCCESS", response: JSON.stringify(value), usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } } }),
];
const quote = "Spaced repetition improves recall.";
const summary = { summary: [{ text: "The note discusses a study method.", quote }], claims: [], qualifications: [] };
const concepts = { candidates: [{ kind: "concept", category: "method", name: "Spaced repetition", description: "A method discussed for recall.", quote }] };
const entityPage = "---\ntitle: Test Entity\ntype: entity\ncreated: 2026-01-01\nupdated: 2026-01-01\nsources: [apple-study]\ntags: [fixture]\n---\n\n# Test Entity\n\nA fixture entity linked to [[apple-study]].\n";
const files = ["Notes/Apple Notes/Apple study.md", "Notes/Eureka/Eureka study.md"];
const streamFor = (value: unknown) => useCodex
  ? [JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(value) } })]
  : useGemini ? geminiStream(value) : useAntigravity ? antigravityStream(value) : claudeStream({ text: JSON.stringify(value), cabinet: null });
test.beforeAll(async () => {
  cabinet = await bootCabinet({ files: {
    "Cabinet/.agents/.config/providers.json": JSON.stringify({ defaultProvider: "claude-code", disabledProviderIds: [] }),
    "Cabinet/.agents/wiki-helper/persona.md": `---\nname: Wiki Helper\nslug: wiki-helper\nrole: Wiki editor\nprovider: ${agentProvider}\n${agentModel ? `model: ${agentModel}\n` : ""}active: false\nheartbeatEnabled: false\n---\n\nYou are the Wiki Helper fixture agent.\n`,
    "Cabinet/.agents/.runtime/daemon-token": randomUUID(),
    ...Object.fromEntries(files.map((name) => [`Cabinet/${name}`, `# Study\n\n${quote}\n\nA separate personal observation.\n`])),
  }, fakeAgents: [{ name: agentName, steps: [
    // Stage 2 tool-enabled pass: the prompt carries "Source summary:"; it writes a real wiki page.
    { match: "Source summary:", files: { "wiki/entities/test-entity.md": entityPage }, stdout: streamFor("Created wiki/entities/test-entity.md") },
    // Stage 1 restricted inference calls, told apart by their instructions.
    { match: "summary, claims and qualifications", stdout: streamFor(summary) },
    { match: "Identify candidate entities", stdout: streamFor(concepts) },
    // Knowledge-graph analysis batches (Phase B "graph" job).
    { match: "Analyze this batch of Wiki pages", stdout: streamFor({ nodes: [], edges: [] }) },
  ] }] });
});
test.afterAll(async () => {
  if (!cabinet) return;
  try {
    const token = (await cabinet.read("Cabinet/.agents/.runtime/daemon-token")).trim();
    await fetch(`${cabinet.daemonUrl}/restart`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    await expect.poll(async () => { try { return (await fetch(`${cabinet.daemonUrl}/health`)).ok; } catch { return false; } }).toBe(false);
  } finally { await cabinet.close(); }
});
test("older Wiki service response keeps Settings usable and requests a service restart", async ({ page }) => {
  await page.route("**/api/llm-wiki/workflow", (route) => route.fulfill({ json: {
    enabled: true, cabinetName: "My Study", running: true, busy: false, error: null,
    folders: ["Notes/Eureka"], wikiPath: "wiki", jobs: [], sources: [],
    provider: { available: true, provider: "codex-cli", message: "Codex ready" },
  } }));
  await page.addInitScript(() => { localStorage.setItem("cabinet.tour-done", "1"); localStorage.setItem("cabinet.wizard-done", "1"); });
  await page.goto(`${cabinet.appUrl}/#/settings/storage`);
  const wiki = page.getByRole("region", { name: "LLM Wiki", exact: true });
  await expect(wiki).toContainText("Restart Cabinet’s background service");
  await expect(wiki.getByRole("combobox", { name: "Wiki agent" })).toBeDisabled();
  await expect(wiki.getByRole("textbox", { name: "Wiki source folders" })).toHaveValue("Notes/Eureka");
});
test("Wiki folder edits persist across refreshes and remain specific to each Cabinet", async ({ page }) => {
  const state = { enabled: true, cabinetName: "Folder draft test", running: false, busy: false, error: null, selectedAgent: "editor", agents: [{ slug: "editor", name: "Editor", provider: "codex-cli", model: null }],
    folders: ["Notes/Saved articles"], wikiPath: "wiki", jobs: [], sources: [],
    provider: { available: true, provider: "codex-cli", message: "Codex ready" } };
  let polls = 0;
  await page.route("**/api/llm-wiki/workflow", (route) => { polls++; return route.fulfill({ json: state }); });
  await page.addInitScript(() => { localStorage.setItem("cabinet.tour-done", "1"); localStorage.setItem("cabinet.wizard-done", "1"); });
  await page.goto(`${cabinet.appUrl}/#/settings/storage`);
  const input = page.getByRole("textbox", { name: "Wiki source folders" });
  await expect(input).toHaveValue("Notes/Saved articles");
  await input.fill("Notes/Eureka/Articles\nNotes/Research");
  const initialPolls = polls;
  await expect.poll(() => polls).toBeGreaterThan(initialPolls);
  await expect(input).toHaveValue("Notes/Eureka/Articles\nNotes/Research");
  await page.reload();
  await expect(input).toHaveValue("Notes/Eureka/Articles\nNotes/Research");
  state.cabinetName = "Another Cabinet";
  await page.reload();
  await expect(input).toHaveValue("Notes/Saved articles");
  state.cabinetName = "Folder draft test";
  await page.reload();
  await expect(input).toHaveValue("Notes/Eureka/Articles\nNotes/Research");
  await input.fill("");
  await page.reload();
  await expect(input).toHaveValue("");
});

test("Wiki progress shows current work, failures and connection loss", async ({ page }) => {
  const jobs = Array.from({ length: 26 }, (_, index) => ({ id: `job-${index}`, sourceId: `source-${index}`,
    status: index < 3 ? "complete" : index === 3 ? "compiling" : index === 4 ? "needs-review" : "queued",
    input: { path: `Notes/Article ${index}.md` }, error: index === 4 ? "Summary validation failed" : null, updatedAt: new Date().toISOString() }));
  let offline = false;
  const state = { enabled: true, cabinetName: "Test Study", running: true, busy: true, error: null, selectedAgent: "editor", agents: [{ slug: "editor", name: "Editor", provider: "codex-cli", model: null }],
    folders: [], wikiPath: "wiki", jobs, sources: [], provider: { available: true, provider: "codex-cli", message: "Codex ready" } };
  await page.route("**/api/llm-wiki/workflow", (route) => offline ? route.abort() : route.fulfill({ json: state }));
  await page.addInitScript(() => { localStorage.setItem("cabinet.tour-done", "1"); localStorage.setItem("cabinet.wizard-done", "1"); });
  await page.goto(`${cabinet.appUrl}/#/settings/storage`);
  const wiki = page.getByRole("region", { name: "LLM Wiki", exact: true });
  const progress = wiki.getByRole("region", { name: "Wiki ingestion progress" });
  const bar = progress.getByRole("progressbar");
  await expect(bar).toHaveAttribute("aria-valuenow", "3");
  await expect(bar).toHaveAttribute("aria-valuemax", "26");
  await expect(progress).toContainText("1 in progress · 21 waiting · 1 need attention");
  await expect(progress).toContainText("Notes/Article 3.md");
  await expect(progress).toContainText("Generating and checking Wiki content");
  await expect(progress).toContainText("Status received at");
  await progress.locator("summary").click();
  await expect(progress.getByRole("listitem")).toHaveCount(26);
  offline = true;
  await expect(wiki).toContainText("Cannot refresh progress");
  await expect(wiki).toContainText("Progress unavailable");
  await expect(bar).toHaveAttribute("aria-valuenow", "3");
  offline = false;
  state.busy = false;
  for (const job of jobs) if (job.status !== "needs-review") job.status = "complete";
  await expect(bar).toHaveAttribute("aria-valuenow", "25");
  await expect(wiki).toContainText("Finished processing; some operations need attention");
  await expect(wiki).not.toContainText("Cannot refresh progress");
  jobs[4].status = "complete";
  await expect(bar).toHaveAttribute("aria-valuenow", "26");
  await expect(progress).toContainText("100%");
});

test("select notes in settings, publish Wiki, open all reader views and capture a later edit", async ({ page, request }) => {
  await page.addInitScript(() => { localStorage.setItem("cabinet.tour-done", "1"); localStorage.setItem("cabinet.wizard-done", "1"); });
  await page.goto(`${cabinet.appUrl}/#/settings/storage`);
  const wiki = page.getByRole("region", { name: "LLM Wiki", exact: true });
  await expect(wiki).toBeVisible();
  await wiki.getByRole("button", { name: "Enable LLM Wiki" }).click();
  await wiki.getByRole("combobox", { name: "Wiki agent" }).selectOption("wiki-helper");
  await expect.poll(async () => (await (await request.get(`${cabinet.appUrl}/api/llm-wiki/workflow`)).json()).selectedAgent).toBe("wiki-helper");
  expect(await cabinet.read("Cabinet/.agents/wiki-helper/persona.md")).toContain("active: false");
  await wiki.getByRole("button", { name: "Preview notes" }).click();
  await expect(wiki).toContainText("2 notes found");
  await wiki.getByRole("checkbox").nth(0).check(); await wiki.getByRole("checkbox").nth(1).check();
  await wiki.getByRole("button", { name: "Build Wiki from 2 selected notes" }).click();
  const status = async () => (await request.get(`${cabinet.appUrl}/api/llm-wiki/workflow`)).json();
  // Two source jobs plus the auto-enqueued consolidate and graph passes after the batch drains.
  await expect.poll(async () => (await status()).jobs.filter((job: { status: string }) => job.status === "complete").length, { timeout: 60_000 }).toBe(4);
  await expect(wiki).toContainText("4 of 4 operations completed.");
  const state = await status();
  expect(state.sources.every((source: { compiled: boolean }) => source.compiled)).toBe(true);
  const appleSource = state.sources.find((source: { path: string }) => source.path === files[0]);
  expect(appleSource.rawPath).toBe("raw/Notes/Apple Notes/Apple study");
  await page.goto(`${cabinet.appUrl}/room/${appleSource.rawPath}/v1/capture.json`);
  await expect(page.getByRole("region", { name: "Captured file" })).toContainText('"original":"original.md"');
  await page.goto(`${cabinet.appUrl}/room/${appleSource.rawPath}/manifest.yaml`);
  await expect(page.getByRole("region", { name: "Captured file" })).toContainText("schemaVersion: 1");
  await page.goto(`${cabinet.appUrl}/room/${appleSource.rawPath}/v1/original`);
  await expect(page.getByRole("region", { name: "Captured file" })).toContainText(quote);
  for (const folder of ["raw", "Notes", "Apple Notes", "Apple study", "v1"]) {
    const expand = page.getByRole("button", { name: `Expand ${folder}`, exact: true }).last();
    if (await expand.count()) await expand.click();
  }
  await page.getByRole("button", { name: "capture.json", exact: true }).click();
  await expect(page.getByRole("region", { name: "Captured file" })).toContainText('"original":"original.md"');
  await page.goto(`${cabinet.appUrl}/room/wiki/sources/apple-study`);
  await page.getByRole("link", { name: "Raw v1", exact: true }).first().click();
  await expect(page.getByRole("region", { name: "Captured source" })).toBeVisible();
  expect(await cabinet.read("Cabinet/wiki/index.md")).toContain("entities/test-entity.md");
  const graph = JSON.parse(await cabinet.read("Cabinet/wiki/graph.json"));
  expect(graph.kind).toBe("cabinet-wiki-graph");
  expect(graph.nodes.some((node: { id: string }) => node.id === "page:entities/test-entity")).toBe(true);
  await page.goto(`${cabinet.appUrl}/room/${files[0].replace(/\.md$/, "").split("/").map(encodeURIComponent).join("/")}`);
  await page.getByRole("link", { name: "Read captured source (Reader / Original / Markdown)" }).click();
  const viewer = page.getByRole("region", { name: "Captured source" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("tabpanel")).toContainText(quote);
  await viewer.getByRole("tab", { name: "Original", exact: true }).click();
  await expect(viewer.getByRole("tabpanel")).toContainText("A separate personal observation.");
  await viewer.getByRole("tab", { name: "Markdown", exact: true }).click();
  await expect(viewer.getByRole("tabpanel")).toContainText("source_version_id:");
  await fs.appendFile(path.join(cabinet.dataDir, "Cabinet", files[0]), "\nA later observation.\n");
  await expect.poll(async () => (await status()).sources.find((source: { path: string }) => source.path === files[0])?.version, { timeout: 60_000 }).toBe(2);
  await page.reload();
  await expect(viewer.getByRole("combobox", { name: "Source version" })).toBeVisible();
  const options = viewer.getByRole("combobox", { name: "Source version" }).locator("option");
  await viewer.getByRole("combobox", { name: "Source version" }).selectOption((await options.nth(1).getAttribute("value"))!);
  await expect(viewer.getByRole("tabpanel")).not.toContainText("A later observation.");
  const calls = (await cabinet.agent(agentName).invocations()).filter((call) => call.has(useCodex ? "exec" : "-p"));
  const callText = (call: { stdin: string; args: string[] }) => `${call.stdin}\n${call.args.join("\n")}`;
  const inferenceCalls = calls.filter((call) => callText(call).includes("untrusted source data"));
  const agentCalls = calls.filter((call) => !callText(call).includes("untrusted source data"));
  expect(agentCalls.filter((call) => callText(call).includes("Source summary:")).length).toBeGreaterThanOrEqual(2);
  expect(inferenceCalls.length).toBeGreaterThanOrEqual(4);
  expect(inferenceCalls.every((call) => useCodex ? call.flag("--sandbox") === "read-only" && call.has("--ignore-user-config") : useGemini ? !!call.flag("--admin-policy") && call.flag("--extensions") === "none" && !call.has("--yolo") && call.flag("-m") === "gemini-2.5-pro" : useAntigravity ? call.has("--sandbox") && !call.has("--dangerously-skip-permissions") && call.flag("--model") === "gemini-3.8-flash-medium" : call.flag("--tools") === "" && call.has("--strict-mcp-config"))).toBe(true);
});
