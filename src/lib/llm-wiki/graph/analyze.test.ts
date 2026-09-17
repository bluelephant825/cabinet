import test from "node:test";
import assert from "node:assert/strict";
import { analyzeWikiBatch, analysisBody, GRAPH_PROMPT_VERSION, type GraphAnalysisModel } from "./analyze";
import type { GraphNode } from "./types";
import type { ScanPage } from "./scan";

const markdown = (body: string) => `---\ntitle: T\ntype: concept\n---\n\n# T\n\n${body}\n`;
const page = (p: string, body: string): ScanPage => ({ path: p, markdown: markdown(body), markdownHash: `hash-${p}` });
const node = (id: string, p: string): GraphNode => ({ id, type: "page", name: id, summary: "", tags: [], pagePath: p, pageKind: "concept" });
const batch = (...items: [ScanPage, GraphNode][]) => items.map(([p, n]) => ({ page: p, node: n, links: [] as string[] }));

const p1 = page("wiki/concepts/alpha.md", "Alpha mentions Ada Lovelace and the Analytical Engine.");
const p2 = page("wiki/concepts/beta.md", "Beta body about engines.");
const n1 = node("page:concepts/alpha", p1.path);
const n2 = node("page:concepts/beta", p2.path);

const fake = (impl: (input: { pages: unknown[]; existingIds: readonly string[]; instructions: string }) => unknown): GraphAnalysisModel & { calls: number } => {
  const model = { calls: 0, async analyze(input: { pages: unknown[]; existingIds: readonly string[]; instructions: string }) { model.calls++; return impl(input); } };
  return model;
};
const signal = () => new AbortController().signal;

const goodOutput = {
  nodes: [
    { id: "entity:ignored-supplied-id", type: "entity", name: "Ada Lovelace", summary: "Mathematician.", pagePath: p1.path, quote: "Ada Lovelace" },
    { id: "claim:x", type: "claim", name: "engines", summary: "Beta discusses engines.", pagePath: p2.path, quote: "engines" },
  ],
  edges: [
    { source: "entity:ignored-supplied-id", target: "page:concepts/alpha", type: "related", description: "Mentioned.", pagePath: p1.path, quote: "Ada Lovelace" },
    { source: "claim:beta-engines", target: "page:concepts/beta", type: "exemplifies", weight: 0.9, pagePath: p2.path, quote: "engines" },
  ],
};

test("valid output becomes per-page records with recomputed ids and defaults", async () => {
  const model = fake(() => goodOutput);
  const { records } = await analyzeWikiBatch(batch([p1, n1], [p2, n2]), ["page:concepts/alpha", "page:concepts/beta"], model, "test/model", signal());
  assert.equal(model.calls, 1);
  assert.equal(records.length, 2);
  const alpha = records.find((record) => record.pagePath === p1.path)!;
  const beta = records.find((record) => record.pagePath === p2.path)!;
  assert.equal(alpha.promptVersion, GRAPH_PROMPT_VERSION);
  assert.equal(alpha.markdownHash, p1.markdownHash);
  assert.equal(alpha.model, "test/model");
  // Entity id is recomputed from the name; the model's supplied id is ignored.
  assert.deepEqual(alpha.nodes.map((item) => item.id), ["entity:ada-lovelace"]);
  assert.equal(alpha.edges[0].source, "entity:ada-lovelace");
  assert.equal(alpha.edges[0].provenance, "inferred");
  assert.equal(alpha.edges[0].extractor, "llm:test/model");
  assert.equal(alpha.edges[0].confidence, 0.5); // related default weight
  assert.equal(alpha.edges[0].evidence![0].quote, "Ada Lovelace");
  // Claim id = page stem slug + name slug; explicit weight honored.
  assert.deepEqual(beta.nodes.map((item) => item.id), ["claim:beta-engines"]);
  assert.equal(beta.edges[0].confidence, 0.9);
});

test("a quote missing from the page fails validation with feedback and can recover", async () => {
  let calls = 0;
  const model = fake(() => {
    calls++;
    if (calls === 1) return { nodes: [{ id: "entity:x", type: "entity", name: "Ada Lovelace", summary: "s", pagePath: p1.path, quote: "not in the page" }], edges: [] };
    return goodOutput;
  });
  const { records } = await analyzeWikiBatch(batch([p1, n1], [p2, n2]), ["page:concepts/alpha", "page:concepts/beta"], model, "test", signal());
  assert.equal(calls, 2);
  assert.equal(records.length, 2);
});

test("persistent bad quotes throw an error naming the quote problem", async () => {
  const model = fake(() => ({ nodes: [{ id: "e", type: "entity", name: "Ada Lovelace", summary: "s", pagePath: p1.path, quote: "fabricated" }], edges: [] }));
  await assert.rejects(analyzeWikiBatch(batch([p1, n1]), [], model, "test", signal()), /quote/i);
  assert.equal(model.calls, 3);
});

test("unknown edge types, outside endpoints and self edges throw", async () => {
  const base = { nodes: [], edges: [] as unknown[] };
  const run = (edges: unknown[]) => analyzeWikiBatch(batch([p1, n1]), ["page:concepts/alpha"], fake(() => ({ ...base, edges })), "test", signal());
  const edge = { source: "page:concepts/alpha", target: "page:concepts/alpha", type: "related", pagePath: p1.path, quote: "Alpha" };
  await assert.rejects(run([{ ...edge, type: "frobnicate" }]), /Unknown analysis edge type/);
  await assert.rejects(run([{ ...edge, target: "page:concepts/elsewhere" }]), /existingIds/);
  await assert.rejects(run([edge]), /self-edge/i);
  await assert.rejects(run([{ ...edge, target: "entity:ghost" }]), /existingIds/);
});

test("over-cap node and edge counts throw", async () => {
  const many = (count: number) => Array.from({ length: count }, (_, index) => ({ id: `entity:e${index}`, type: "entity", name: `Ada Lovelace`, summary: "s", pagePath: p1.path, quote: "Ada Lovelace" }));
  await assert.rejects(analyzeWikiBatch(batch([p1, n1]), [], fake(() => ({ nodes: many(65), edges: [] })), "test", signal()), /node count/);
  const tooManyEdges = Array.from({ length: 129 }, () => ({ source: "page:concepts/alpha", target: "page:concepts/beta", type: "related", pagePath: p1.path, quote: "Alpha" }));
  await assert.rejects(analyzeWikiBatch(batch([p1, n1]), ["page:concepts/alpha", "page:concepts/beta"], fake(() => ({ nodes: [], edges: tooManyEdges })), "test", signal()), /edge count/);
});

test("pagePath must be a batch page and fields are exact", async () => {
  await assert.rejects(analyzeWikiBatch(batch([p1, n1]), [], fake(() => ({
    nodes: [{ id: "e", type: "entity", name: "Ada Lovelace", summary: "s", pagePath: "wiki/concepts/other.md", quote: "Ada Lovelace" }], edges: [],
  })), "test", signal()), /batch page/);
  await assert.rejects(analyzeWikiBatch(batch([p1, n1]), [], fake(() => ({
    nodes: [{ id: "e", type: "entity", name: "Ada Lovelace", summary: "s", pagePath: p1.path, quote: "Ada Lovelace", extra: 1 }], edges: [],
  })), "test", signal()), /fields/);
});

test("analysisBody strips frontmatter and caps at 6000 chars", () => {
  assert.equal(analysisBody(markdown("Hello")).trim(), "# T\n\nHello");
  const long = analysisBody(markdown("x".repeat(7000)));
  assert.ok(long.length < 6100);
  assert.ok(long.endsWith("[truncated]"));
});
