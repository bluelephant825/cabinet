import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { runSqlMigrations } from "../system/sql-migrations";
import { initializeWikiCabinet } from "./config";
import { IngestionQueue } from "./queue";
import { WikiWorkflow } from "../../../server/ingestion/wiki-workflow";
import { SourceStore } from "./source-store";
import { RawPublicationStore } from "./raw-publication";
import { WikiPublicationStore, readWikiInventory, textHash } from "./wiki-publication";
import { SourceSummaryPlanner } from "./source-summary";
import { PlanningWikiCompiler } from "./compiler";
import { captureNote } from "./capture-note";
import { readRawSource } from "./raw-reader";
import { ManagedSourceWatcher } from "../../../server/ingestion/managed";
import { WikiAgentRunner } from "../../../server/ingestion/wiki-agent";
import type { AgentPersona } from "../agents/persona-manager";
import { WIKI_WORKER_HEARTBEAT_MS } from "./execution-limits";

const folders = ["Notes/Apple Notes", "Notes/Eureka"];
const names = folders.map((folder) => `${folder}/Learning.md`);
const model = {
  async summarize(input: { body: string }) { return { summary: [{ text: "The note describes a practice for studying.", quote: input.body.split("\n").find((line) => line.includes("Spaced repetition"))! }], claims: [], qualifications: [] }; },
  async extract(input: { body: string }) { return { candidates: [{ kind: "concept", category: "method", name: "Spaced repetition", description: "A study practice mentioned by this note.", quote: input.body.split("\n").find((line) => line.includes("Spaced repetition"))! }] }; },
};
async function fixture(t: { after: (fn: () => Promise<void>) => void }, customModel = model) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-wiki-workflow-"));
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: My Study\n");
  for (const [index, folder] of folders.entries()) {
    await fs.mkdir(path.join(root, folder), { recursive: true });
    await fs.writeFile(path.join(root, names[index]), `# Study ${index}\n\nSpaced repetition supports study ${index}.\n\nThese are separate original notes.\n`);
  }
  await initializeWikiCabinet(root, { enabled: true });
  const db = new Database(path.join(root, ".cabinet.db"));
  runSqlMigrations(db, path.resolve("server/migrations"));
  const queue = await IngestionQueue.open(db, root);
  const agent = new WikiAgentRunner(root, {
    persona: { slug: "wiki-stub", provider: "claude-code" } as unknown as AgentPersona,
    async execute() { return { exitCode: 0, signal: null, timedOut: false, output: "Wiki updated." }; },
  });
  const workflow = new WikiWorkflow(root, async () => queue, customModel, () => false, agent);
  t.after(async () => { await workflow.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); });
  const enqueue = async (paths = names) => {
    const inventory = await workflow.action({ action: "inspect", folders }) as { fingerprint: string };
    await workflow.action({ action: "import", folders, paths, fingerprint: inventory.fingerprint });
  };
  const drain = async () => {
    for (let i = 0; i < 20 && queue.list().some((job) => ["queued", "discovered"].includes(job.status)); i++) await workflow.tick();
  };
  return { root, db, queue, workflow, enqueue, drain };
}

test("summary and candidate evidence auto-correct before one Wiki publication", async (t) => {
  let summaries = 0, extractions = 0;
  const f = await fixture(t, {
    async summarize(input) {
      const result = await model.summarize(input);
      if (++summaries === 1) result.summary[0].quote = "A fabricated summary quotation.";
      return result;
    },
    async extract(input) {
      const result = await model.extract(input);
      if (++extractions === 1) result.candidates[0].quote = "A fabricated candidate quotation.";
      return result;
    },
  });
  await f.enqueue([names[0]]); await f.workflow.tick();
  assert.equal(summaries, 2);
  assert.equal(extractions, 2);
  assert.equal(f.queue.list()[0].status, "complete");
  assert.equal(f.queue.list()[0].attempts, 1);
  const [source] = await new SourceStore(f.root).list();
  assert.equal(source.versions.length, 1);
  assert.equal(source.source.currentVersionId, source.source.lastCompiledVersionId);
});

test("persistent invalid summaries stop after bounded corrections without publishing", async (t) => {
  let calls = 0;
  const f = await fixture(t, { ...model, async summarize(input) {
    calls++;
    const result = await model.summarize(input);
    result.summary[0].quote = "Never present in the article.";
    return result;
  } });
  await f.enqueue([names[0]]); await f.workflow.tick();
  assert.equal(calls, 3);
  assert.equal(f.queue.list()[0].status, "needs-review");
  assert.deepEqual(await readWikiInventory(f.root), []);
  const [source] = await new SourceStore(f.root).list();
  assert.equal(source.versions.length, 1);
  assert.equal(source.source.lastCompiledVersionId, null);
});

test("folder onboarding publishes cross-folder Wiki, captures and reader links without changing originals", async (t) => {
  const f = await fixture(t);
  const before = await Promise.all(names.map((name) => fs.readFile(path.join(f.root, name), "utf8")));
  await f.enqueue(); await f.drain();
  assert.deepEqual(f.queue.list().map((job) => [job.status, job.error]), [["complete", null], ["complete", null], ["complete", null], ["complete", null]]);
  const inventory = await readWikiInventory(f.root);
  const sourcesPages = inventory.filter((item) => item.provenance.pagePath.includes("/sources/"));
  assert.equal(sourcesPages.length, 2);
  const sources = await new SourceStore(f.root).list();
  for (const { source } of sources) {
    assert.equal(source.currentVersionId, source.lastCompiledVersionId);
    assert.equal((await readRawSource(f.root, source.rawPath)).kind, "source");
    if (source.mode === "managed") assert.equal((await readRawSource(f.root, source.managedLocation.path)).kind, "ordinary");
  }
  assert.deepEqual(await Promise.all(names.map((name) => fs.readFile(path.join(f.root, name), "utf8"))), before);
  await f.enqueue(); assert.equal(f.queue.list().filter((job) => !["consolidate", "graph"].includes(job.operation)).length, 2);
  assert.match(await fs.readFile(path.join(f.root, "wiki/index.md"), "utf8"), /Learning/);
});

test("connected watcher handles changes, deletion and restoration while preserving independent support", async (t) => {
  const f = await fixture(t); await f.enqueue(); await f.drain();
  const watcher = new ManagedSourceWatcher(f.root, async () => f.queue, { stabilityMs: 20 });
  t.after(() => watcher.close());
  const settle = async () => { await watcher.refresh(); await new Promise((resolve) => setTimeout(resolve, 35)); await watcher.refresh(); };
  await settle();
  await fs.appendFile(path.join(f.root, names[0]), "\nAdditional observations.\n");
  await settle(); await f.drain();
  assert.equal(f.queue.list().at(-1)?.status, "complete", f.queue.list().at(-1)?.error ?? "");
  const source = await new SourceStore(f.root).findManaged({ kind: "cabinet", path: names[0] });
  assert.equal((await new SourceStore(f.root).get(source!.id))!.versions.length, 2);
  const saved = await fs.readFile(path.join(f.root, names[0]));
  await fs.unlink(path.join(f.root, names[0])); await settle(); await f.drain();
  assert.equal(f.queue.list().at(-1)?.status, "complete", f.queue.list().at(-1)?.error ?? "");
  assert.equal((await new SourceStore(f.root).get(source!.id))!.source.lifecycle?.reconciliation, "complete");
  const sourcePages = async () => (await readWikiInventory(f.root)).filter((item) => item.provenance.pagePath.includes("/sources/"));
  assert.equal((await sourcePages()).length, 2);
  await fs.writeFile(path.join(f.root, names[0]), saved); await settle(); await f.drain();
  assert.equal(f.queue.list().at(-1)?.status, "complete", f.queue.list().at(-1)?.error ?? "");
  assert.equal((await new SourceStore(f.root).get(source!.id))!.source.status, "active");
  assert.equal((await sourcePages()).length, 2);
});

test("failed inference leaves Raw captured, then explicit retry publishes once", async (t) => {
  let fail = true;
  const f = await fixture(t, { ...model, async summarize(input) { if (fail) throw new Error("Provider unavailable"); return model.summarize(input); } });
  await f.enqueue([names[0]]); await f.workflow.tick();
  const job = f.queue.list()[0]; assert.equal(job.status, "needs-review");
  assert.equal((await new SourceStore(f.root).get(job.sourceId!))!.source.lastCompiledVersionId, null);
  fail = false;
  await f.workflow.action({ action: "retry", id: job.id, updatedAt: job.updatedAt }); await f.workflow.tick();
  assert.equal(f.queue.get(job.id).status, "complete", f.queue.get(job.id).error ?? "");
  assert.equal((await new SourceStore(f.root).get(job.sourceId!))!.versions.length, 1);
});

test("publication recovers partial files and refuses intervening edits", async (t) => {
  const f = await fixture(t);
  const source = (await new SourceStore(f.root).register({ mode: "managed", roomPath: null, title: "Learning", classification: "notes", managedLocation: { kind: "cabinet", path: names[0] } })).source;
  const captured = await captureNote(f.root, names[0], folders[0]);
  const manifest = await new RawPublicationStore(f.root).publishInitial(source.id, captured.normalized);
  const compiler = new PlanningWikiCompiler(f.root, new SourceSummaryPlanner(model));
  const plan = await compiler.ingest(manifest.source, manifest.versions[0]);
  const id = randomUUID();
  await assert.rejects(new WikiPublicationStore(f.root, async (index) => { if (index === 0) throw new Error("crash"); }).publish(id, plan, compiler), /crash/);
  assert.equal((await new SourceStore(f.root).get(source.id))!.source.lastCompiledVersionId, null);
  await fs.writeFile(path.join(f.root, plan.changes[0].path), "Human edit");
  await assert.rejects(new WikiPublicationStore(f.root).recover(id), /target changed/);
  assert.equal(plan.changes[0].kind, "write");
  if (plan.changes[0].kind === "write") await fs.writeFile(path.join(f.root, plan.changes[0].path), plan.changes[0].markdown);
  assert.equal(await new WikiPublicationStore(f.root).recover(id), true);
  assert.equal((await new SourceStore(f.root).get(source.id))!.source.lastCompiledVersionId, manifest.source.currentVersionId);
});

test("publication refuses Wiki pages appearing after compilation", async (t) => {
  const f = await fixture(t);
  const source = (await new SourceStore(f.root).register({ mode: "managed", roomPath: null, title: "Learning", classification: "notes", managedLocation: { kind: "cabinet", path: names[0] } })).source;
  const manifest = await new RawPublicationStore(f.root).publishInitial(source.id, (await captureNote(f.root, names[0], folders[0])).normalized);
  const compiler = new PlanningWikiCompiler(f.root, new SourceSummaryPlanner(model));
  const plan = await compiler.ingest(manifest.source, manifest.versions[0]);
  await fs.mkdir(path.join(f.root, "wiki")); await fs.writeFile(path.join(f.root, "wiki/index.md"), "Human index");
  await assert.rejects(new WikiPublicationStore(f.root).publish(randomUUID(), plan, compiler), /inputs changed/);
});

test("attachments are captured, dependency edits change fingerprint, and external paths are not read", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, folders[0], "image.png"), "image-one");
  await fs.appendFile(path.join(f.root, names[0]), "\n![[image.png]]\n![Outside](../../../secret.png)\n![[Other note]]\n");
  const first = await captureNote(f.root, names[0], folders[0]);
  assert.equal(first.normalized.original.assets.length, 1);
  assert.match(first.normalized.body, /assets\//);
  assert.ok(first.normalized.warnings.some((warning) => warning.code === "unresolved-asset"));
  assert.ok(first.normalized.warnings.some((warning) => warning.code === "unsupported-embed"));
  await fs.writeFile(path.join(f.root, folders[0], "image.png"), "image-two");
  const next = await captureNote(f.root, names[0], folders[0]);
  assert.equal(first.contentHash, next.contentHash);
  assert.notEqual(first.fingerprint, next.fingerprint);
  assert.equal(textHash(first.normalized.original.bytes), first.contentHash);
});

test("dependency-only changes publish a new captured version after worker restart", async (t) => {
  const f = await fixture(t);
  const asset = path.join(f.root, folders[0], "image.png");
  await fs.writeFile(asset, "image-one");
  await fs.appendFile(path.join(f.root, names[0]), "\n![Image](image.png)\n");
  await f.enqueue([names[0]]); await f.workflow.tick();
  const before = (await new SourceStore(f.root).list())[0];
  assert.equal(before.versions.length, 1);
  await f.workflow.close();
  await fs.writeFile(asset, "image-two");
  const restarted = new WikiWorkflow(f.root, async () => f.queue, model);
  try { await restarted.tick(); } finally { await restarted.close(); }
  const after = (await new SourceStore(f.root).list())[0];
  assert.deepEqual(f.queue.list().map((job) => [job.status, job.error]), [["complete", null], ["complete", null]]);
  assert.equal(after.versions.length, 2);
  assert.equal(after.source.currentVersionId, after.source.lastCompiledVersionId);
  assert.equal(after.versions[0].contentHash, after.versions[1].contentHash);
  const captured = await new RawPublicationStore(f.root).readCapturedFile(after.source.id, after.versions[1].id, `capture/${folders[0]}/image.png`);
  assert.equal(captured.bytes.toString(), "image-two");
});

test("long Wiki work renews its lease and stops renewing after cancellation", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(t, { ...model, async summarize(_input, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof model.summarize>>> {
    started();
    return new Promise((_, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); });
  } });
  const heartbeat = f.queue.heartbeat.bind(f.queue);
  let renewals = 0;
  f.queue.heartbeat = (...args) => { renewals++; return heartbeat(...args); };
  await f.enqueue([names[0]]);
  const pending = f.workflow.tick(); await ready;
  t.mock.timers.tick(WIKI_WORKER_HEARTBEAT_MS * 12);
  assert.equal(renewals, 12);
  assert.equal(f.queue.list()[0].status, "compiling");
  await f.workflow.action({ action: "pause" }); await pending;
  t.mock.timers.tick(WIKI_WORKER_HEARTBEAT_MS * 2);
  assert.equal(renewals, 12);
  assert.equal((await new SourceStore(f.root).list())[0].source.lastCompiledVersionId, null);
});

test("lost Wiki lease cancels inference instead of publishing", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(t, { ...model, async summarize(_input, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof model.summarize>>> {
    started();
    return new Promise((_, reject) => { signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }); });
  } });
  f.queue.heartbeat = () => { throw new Error("Expired or stale worker lease"); };
  await f.enqueue([names[0]]);
  const pending = f.workflow.tick(); await ready;
  t.mock.timers.tick(WIKI_WORKER_HEARTBEAT_MS);
  await pending;
  assert.match(f.queue.list()[0].error!, /Expired or stale worker lease/);
  assert.deepEqual(await readWikiInventory(f.root), []);
});

test("pausing cancels inference without acknowledging compilation", async (t) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const f = await fixture(t, { ...model, async summarize(_input, signal?: AbortSignal): Promise<Awaited<ReturnType<typeof model.summarize>>> {
    started();
    return new Promise((_, reject) => { signal!.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true }); });
  } });
  await f.enqueue([names[0]]);
  const pending = f.workflow.tick(); await ready;
  await f.workflow.action({ action: "pause" }); await pending;
  assert.equal(f.queue.list()[0].status, "needs-review");
  assert.equal((await f.workflow.status()).running, false);
  assert.equal((await new SourceStore(f.root).list())[0].source.lastCompiledVersionId, null);
});

test("a changed preview and overlapping generated folder are rejected before registration", async (t) => {
  const f = await fixture(t);
  const inventory = await f.workflow.action({ action: "inspect", folders }) as { fingerprint: string };
  await fs.appendFile(path.join(f.root, names[0]), "Changed after preview");
  await assert.rejects(f.workflow.action({ action: "import", folders, paths: [names[0]], fingerprint: inventory.fingerprint }), /changed/);
  await assert.rejects(f.workflow.action({ action: "inspect", folders: ["raw"] }), /generated layer/);
  assert.equal((await new SourceStore(f.root).list()).length, 0);
});

test("an unsupported imported filename is reported without blocking preview or the ordinary editor", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, folders[0], "Question?.md"), "An imported note");
  const inventory = await f.workflow.action({ action: "inspect", folders }) as { notes: readonly unknown[]; skipped: readonly { path: string; reason: string }[] };
  assert.equal(inventory.notes.length, 2);
  assert.ok(inventory.skipped.some((item) => item.path.endsWith("Question?.md") && item.reason.includes("Filename")));
  assert.equal((await readRawSource(f.root, `${folders[0]}/Question?`)).kind, "ordinary");
});

const graphModel = {
  ...model,
  async analyze(input: { pages: { path: string; body: string }[] }) {
    const nodes = input.pages.map((page, index) => {
      const quote = (page.body.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#")) ?? "content").slice(0, 200);
      return { id: `entity:g${index}`, type: "entity", name: quote.split(/\s+/).slice(0, 3).join(" "), summary: "Found by analysis.", pagePath: page.path, quote };
    });
    const edges = input.pages.map((page, index) => ({ source: `entity:g${index}`, target: page.path.replace(/^wiki\/|\.md$/g, "").replace(/^/, "page:"), type: "related", pagePath: page.path, quote: nodes[index].quote }));
    return { nodes, edges };
  },
};

test("a consolidate completion auto-enqueues a graph job which analyzes pages", async (t) => {
  const f = await fixture(t, graphModel);
  await f.enqueue(); await f.drain();
  const jobs = f.queue.list();
  const graphJob = jobs.find((job) => job.operation === "graph");
  assert.ok(graphJob, "consolidate should enqueue a graph job");
  assert.equal(graphJob!.status, "complete", graphJob!.error ?? "");
  const record = JSON.parse(await fs.readFile(path.join(f.root, ".cabinet-state/llm-wiki/operations", `${graphJob!.id}.json`), "utf8"));
  assert.ok(record.graph.analyzed >= 2);
  const graph = JSON.parse(await fs.readFile(path.join(f.root, "wiki/graph.json"), "utf8"));
  assert.ok(graph.edges.some((edge: { provenance: string; extractor: string }) => edge.provenance === "inferred" && edge.extractor === "llm:test"));
  assert.match(await fs.readFile(path.join(f.root, "wiki/log.md"), "utf8"), /## \[\d{4}-\d{2}-\d{2}\] graph \| Knowledge graph/);
});

test("a graph job without an analysis model completes with a warning", async (t) => {
  const f = await fixture(t);
  await f.enqueue(); await f.drain();
  await f.workflow.action({ action: "graph" });
  const active = f.queue.list().filter((job) => job.operation === "graph" && job.status !== "complete");
  assert.ok(active.length <= 1);
  await f.drain();
  const graphJob = f.queue.list().filter((job) => job.operation === "graph").at(-1)!;
  assert.equal(graphJob.status, "complete", graphJob.error ?? "");
  const record = JSON.parse(await fs.readFile(path.join(f.root, ".cabinet-state/llm-wiki/operations", `${graphJob.id}.json`), "utf8"));
  assert.ok(record.graphWarnings.some((warning: string) => warning.includes("No analysis model available")));
});

test("reprocess-all honors sourceIds and legacyOnly filters", async (t) => {
  const f = await fixture(t);
  await f.enqueue(); await f.drain();
  const sources = (await new SourceStore(f.root).list()).map((entry) => entry.source)
    .filter((source) => source.status === "active" && source.currentVersionId);
  assert.ok(sources.length >= 2);
  await assert.rejects(f.workflow.action({ action: "reprocess-all", sourceIds: ["missing-id"] }), /Unknown source/);
  // legacyOnly selects only sources still at the old source-<id>.md path.
  await fs.mkdir(path.join(f.root, "wiki/sources"), { recursive: true });
  await fs.writeFile(path.join(f.root, `wiki/sources/source-${sources[1].id}.md`), "legacy page\n");
  await f.workflow.action({ action: "reprocess-all", legacyOnly: true });
  let jobs = f.queue.list().filter((job) => job.operation === "reprocess" && job.status === "queued");
  assert.deepEqual(jobs.map((job) => job.sourceId), [sources[1].id]);
  await assert.rejects(f.workflow.action({ action: "reprocess-all" }), /already queued or running/);
  await f.drain();
  await f.workflow.action({ action: "reprocess-all", sourceIds: [sources[0].id] });
  jobs = f.queue.list().filter((job) => job.operation === "reprocess" && job.status === "queued");
  assert.deepEqual(jobs.map((job) => job.sourceId), [sources[0].id]);
});
