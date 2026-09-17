import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { initializeWikiCabinet } from "../src/lib/llm-wiki/config";
import { WIKI_STATE_PATH } from "../src/lib/llm-wiki/config";
import { WikiGraphBuilder } from "../server/ingestion/wiki-graph";
import { readWikiGraph, readWikiGraphHeader } from "../src/lib/llm-wiki/graph/store";
import type { GraphAnalysisModel } from "../src/lib/llm-wiki/graph/analyze";

const page = (title: string, type: string, body: string, extra = "") =>
  `---\ntitle: ${title}\ntype: ${type}\n${extra}---\n\n# ${title}\n\n${body}\n`;

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-wiki-graph-"));
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: Graph Study\n");
  await initializeWikiCabinet(root, { enabled: true });
  await fs.mkdir(path.join(root, "wiki/concepts"), { recursive: true });
  await fs.mkdir(path.join(root, "wiki/entities"), { recursive: true });
  await fs.writeFile(path.join(root, "wiki/concepts/alpha.md"), page("Alpha", "concept", "Alpha links to [[Beta]] and mentions the Analytical Engine."));
  await fs.writeFile(path.join(root, "wiki/entities/beta.md"), page("Beta", "entity", "Beta body."));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  return { root };
}

test("refresh writes a valid graph.json with page nodes and edges", async (t) => {
  const { root } = await fixture(t);
  const result = await new WikiGraphBuilder(root).refresh("job-1");
  assert.equal(result.path, "wiki/graph.json");
  assert.ok(result.stats);
  const graph = await readWikiGraph(root, "wiki");
  assert.ok(graph);
  assert.equal(graph.jobId, "job-1");
  assert.equal(graph.kind, "cabinet-wiki-graph");
  assert.ok(graph.stats.nodes >= 2);
  assert.ok(graph.edges.some((edge) => edge.source === "page:concepts/alpha" && edge.target === "page:entities/beta" && edge.type === "links_to"));
  assert.ok(graph.layers.length >= 2);
});

test("a second refresh after a page is removed rewrites graph.json", async (t) => {
  const { root } = await fixture(t);
  await new WikiGraphBuilder(root).refresh("job-2");
  const before = await fs.readFile(path.join(root, "wiki/graph.json"), "utf8");
  await fs.rm(path.join(root, "wiki/entities/beta.md"));
  const result = await new WikiGraphBuilder(root).refresh("job-3");
  const graph = await readWikiGraph(root, "wiki");
  assert.equal(graph!.jobId, "job-3");
  assert.ok(!graph!.nodes.some((node) => node.id === "page:entities/beta"));
  assert.notEqual(await fs.readFile(path.join(root, "wiki/graph.json"), "utf8"), before);
  assert.ok(result.stats!.unresolvedLinks >= 1); // [[Beta]] now dangles
});

test("readWikiGraphHeader tracks file rewrites and serves cached headers", async (t) => {
  const { root } = await fixture(t);
  assert.equal(await readWikiGraphHeader(root, "wiki"), null);
  await new WikiGraphBuilder(root).refresh("job-6");
  const first = await readWikiGraphHeader(root, "wiki");
  assert.equal(first!.jobId, "job-6");
  await new WikiGraphBuilder(root).refresh("job-7");
  const second = await readWikiGraphHeader(root, "wiki");
  assert.equal(second!.jobId, "job-7");
});

interface AnalyzeInput { pages: { id: string; path: string; name: string; body: string }[]; existingIds: readonly string[]; instructions: string }
const analyzer = (impl: (input: AnalyzeInput) => unknown): GraphAnalysisModel & { calls: number } => {
  const model = { calls: 0, async analyze(input: AnalyzeInput) { model.calls++; return impl(input); } };
  return model;
};
const analyze = (model: GraphAnalysisModel) => ({ model, modelName: "test/model", signal: new AbortController().signal });
const cacheDir = (root: string) => path.join(root, WIKI_STATE_PATH, "graph/analysis");

test("refresh with an analysis model caches per page and merges inferred edges", async (t) => {
  const { root } = await fixture(t);
  // Page-named entities exercise the explicit-wins name remap; "Analytical
  // Engine" is a standalone inferred entity only alpha's body supports.
  const model = analyzer((input) => ({
    nodes: input.pages.map((page, index) => page.body.includes("Analytical Engine")
      ? { id: `entity:e${index}`, type: "entity", name: "Analytical Engine", summary: "Entity.", pagePath: page.path, quote: "the Analytical Engine" }
      : { id: `entity:e${index}`, type: "entity", name: page.name, summary: "Entity.", pagePath: page.path, quote: page.name }),
    edges: input.pages.map((page, index) => ({ source: `entity:e${index}`, target: page.id, type: "related", description: "Mentioned.", pagePath: page.path, quote: page.body.includes("Analytical Engine") ? "the Analytical Engine" : page.name })),
  }));
  const first = await new WikiGraphBuilder(root).refresh("job-a", { analyze: analyze(model) });
  assert.equal(first.analyzed, 2);
  assert.equal(first.cached, 0);
  assert.equal(first.failedBatches, 0);
  assert.equal(model.calls, 2); // one batch per area (concepts, entities)
  assert.equal((await fs.readdir(cacheDir(root))).length, 2);
  const graph = await readWikiGraph(root, "wiki");
  const inferred = graph!.edges.filter((edge) => edge.provenance === "inferred");
  assert.equal(inferred.length, 2);
  assert.equal(inferred[0].extractor, "llm:test/model");
  assert.equal(inferred[0].confidence, 0.5);
  assert.ok(inferred[0].evidence?.[0].quote);
  assert.ok(graph!.nodes.some((node) => node.id === "entity:analytical-engine"));
  // The "Beta" entity matched an existing page name and remapped onto it.
  assert.ok(!graph!.nodes.some((node) => node.id === "entity:beta"));

  const second = await new WikiGraphBuilder(root).refresh("job-b", { analyze: analyze(model) });
  assert.equal(second.analyzed, 0);
  assert.equal(second.cached, 2);
  assert.equal(model.calls, 2);
});

test("editing a page re-analyzes only it and prunes the stale record", async (t) => {
  const { root } = await fixture(t);
  const model = analyzer((input) => ({
    nodes: input.pages.map((page, index) => ({ id: `entity:e${index}`, type: "entity", name: page.name, summary: "Entity.", pagePath: page.path, quote: page.name })),
    edges: [],
  }));
  await new WikiGraphBuilder(root).refresh("job-c", { analyze: analyze(model) });
  const before = await fs.readdir(cacheDir(root));
  await fs.writeFile(path.join(root, "wiki/concepts/alpha.md"), page("Alpha", "concept", "Alpha now links to [[Beta]] and changed."));
  const result = await new WikiGraphBuilder(root).refresh("job-d", { analyze: analyze(model) });
  assert.equal(result.analyzed, 1);
  assert.equal(result.cached, 1);
  assert.equal(model.calls, 3);
  const after = await fs.readdir(cacheDir(root));
  assert.equal(after.length, 2);
  assert.notDeepEqual(after.sort(), before.sort());
});

test("a failing analysis batch warns and still publishes the explicit layer", async (t) => {
  const { root } = await fixture(t);
  const model = analyzer(() => { throw new Error("provider down"); });
  const result = await new WikiGraphBuilder(root).refresh("job-e", { analyze: analyze(model) });
  assert.equal(result.failedBatches, 2); // pages group by area: concepts + entities
  assert.ok(result.warnings.some((warning) => warning.includes("Graph analysis failed for batch 1 (wiki/concepts/alpha.md): provider down")));
  const graph = await readWikiGraph(root, "wiki");
  assert.ok(graph!.edges.some((edge) => edge.type === "links_to" && edge.provenance === "explicit"));
});

test("a failed refresh warns and leaves the prior graph.json untouched", async (t) => {
  const { root } = await fixture(t);
  await new WikiGraphBuilder(root).refresh("job-4");
  const before = await fs.readFile(path.join(root, "wiki/graph.json"), "utf8");
  await fs.mkdir(path.join(root, WIKI_STATE_PATH), { recursive: true });
  await fs.writeFile(path.join(root, WIKI_STATE_PATH, "wiki-inventory.json"), "not json{{{");
  const result = await new WikiGraphBuilder(root).refresh("job-5");
  assert.equal(result.path, null);
  assert.equal(result.stats, null);
  assert.ok(result.warnings.some((warning) => warning.includes("Knowledge graph rebuild failed")));
  assert.equal(await fs.readFile(path.join(root, "wiki/graph.json"), "utf8"), before);
});
