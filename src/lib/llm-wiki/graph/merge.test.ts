import test from "node:test";
import assert from "node:assert/strict";
import { mergeWikiGraph, type MergeInput } from "./merge";
import type { ScanResult } from "./scan";
import type { GraphEdge, GraphNode } from "./types";

const node = (id: string, name: string, type: GraphNode["type"] = "page", extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, type, name, summary: "", tags: [], ...extra });
const edge = (source: string, target: string, type: string, extra: Partial<GraphEdge> = {}): GraphEdge =>
  ({ source, target, type: type as GraphEdge["type"], direction: "forward", provenance: "explicit", extractor: "wikilink", confidence: 1, ...extra });
const scan = (nodes: GraphNode[], edges: GraphEdge[], warnings: string[] = []): ScanResult =>
  ({ nodes, edges, warnings, unresolvedLinks: 0 });
const base = (explicit: ScanResult, inferred: ScanResult[] = []): MergeInput =>
  ({ explicit, inferred, wikiRoot: "wiki", cabinetId: "cab-1", jobId: "job-1", inventoryFingerprint: "fp" });

test("explicit edges win dedup over inferred ones", () => {
  const explicit = scan(
    [node("page:concepts/a", "A"), node("page:concepts/b", "B")],
    [edge("page:concepts/a", "page:concepts/b", "links_to", { extractor: "wikilink" })]);
  const inferred = scan([], [
    edge("page:concepts/a", "page:concepts/b", "links_to", { provenance: "inferred", extractor: "llm:test", confidence: 0.4, evidence: [{ quote: "q" }] }),
  ]);
  const graph = mergeWikiGraph(base(explicit, [inferred]));
  const found = graph.edges.filter((item) => item.type === "links_to");
  assert.equal(found.length, 1);
  assert.equal(found[0].extractor, "wikilink");
  assert.equal(found[0].provenance, "explicit");
});

test("inferred entity nodes remap to an existing page by name", () => {
  const explicit = scan(
    [node("page:entities/ada-lovelace", "Ada Lovelace"), node("page:concepts/engine", "Engine")],
    [edge("page:concepts/engine", "page:entities/ada-lovelace", "links_to")]);
  const inferred = scan(
    [node("entity:ada-lovelace", "Ada Lovelace", "entity")],
    [edge("entity:ada-lovelace", "page:concepts/engine", "mentions", { provenance: "inferred", extractor: "llm:test", confidence: 0.5, evidence: [{ quote: "q" }] })]);
  const graph = mergeWikiGraph(base(explicit, [inferred]));
  assert.ok(!graph.nodes.some((item) => item.id === "entity:ada-lovelace"));
  const found = graph.edges.find((item) => item.type === "related")!;
  assert.equal(found.source, "page:entities/ada-lovelace");
  assert.equal(found.target, "page:concepts/engine");
});

test("inferred entities remap onto topics and pages by slug-insensitive name", () => {
  const explicit = scan(
    [
      node("topic:big-tech", "Big tech", "topic"),
      node("page:concepts/cafe-au-lait", "Café au lait", "page", { pagePath: "wiki/concepts/cafe-au-lait.md" }),
      node("page:concepts/engine", "Engine", "page", { pagePath: "wiki/concepts/engine.md" }),
      node("claim:c1", "A claim", "claim"),
    ],
    []);
  const inferred = scan(
    [
      node("entity:big-tech", "Big Tech", "entity"),
      node("entity:cafe-au-lait", "Cafe-au-Lait", "entity"),
      node("claim:c1-dup", "A claim", "claim"),
    ],
    [
      edge("entity:big-tech", "page:concepts/engine", "related", { provenance: "inferred", extractor: "llm:t", confidence: 0.5, evidence: [{ quote: "q" }] }),
      edge("entity:cafe-au-lait", "page:concepts/engine", "related", { provenance: "inferred", extractor: "llm:t", confidence: 0.5, evidence: [{ quote: "q" }] }),
    ]);
  const graph = mergeWikiGraph(base(explicit, [inferred]));
  const ids = new Set(graph.nodes.map((item) => item.id));
  assert.ok(!ids.has("entity:big-tech"));
  assert.ok(!ids.has("entity:cafe-au-lait"));
  assert.ok(ids.has("claim:c1-dup")); // claims never merge by name
  const pairs = new Set(graph.edges.filter((item) => item.type === "related").map((item) => `${item.source}->${item.target}`));
  assert.ok(pairs.has("topic:big-tech->page:concepts/engine"));
  assert.ok(pairs.has("page:concepts/cafe-au-lait->page:concepts/engine"));
});

test("edge aliases normalize and reversed aliases swap endpoints", () => {
  const explicit = scan(
    [node("page:concepts/a", "A"), node("page:concepts/b", "B")], []);
  const inferred = scan([], [
    edge("page:concepts/a", "page:concepts/b", "contains", { provenance: "inferred", extractor: "llm:t", confidence: 0.5, evidence: [{ quote: "q" }] }),
    edge("page:concepts/a", "page:concepts/b", "conflicts_with", { provenance: "inferred", extractor: "llm:t", confidence: 0.9, evidence: [{ quote: "q" }] }),
    edge("page:concepts/a", "page:concepts/b", "frobnicate", { provenance: "inferred", extractor: "llm:t", confidence: 0.5, evidence: [{ quote: "q" }] }),
  ]);
  const graph = mergeWikiGraph(base(explicit, [inferred]));
  const types = graph.edges.map((item) => `${item.source}->${item.target}:${item.type}`);
  assert.ok(types.includes("page:concepts/b->page:concepts/a:part_of"));
  assert.ok(types.includes("page:concepts/a->page:concepts/b:contradicts"));
  assert.ok(types.includes("page:concepts/a->page:concepts/b:related"));
  assert.ok(graph.warnings.some((warning) => warning.includes("frobnicate")));
});

test("dangling edges drop with a warning", () => {
  const explicit = scan(
    [node("page:concepts/a", "A")],
    [edge("page:concepts/a", "page:concepts/ghost", "links_to")]);
  const graph = mergeWikiGraph(base(explicit));
  assert.equal(graph.edges.length, 0);
  assert.ok(graph.warnings.some((warning) => warning.includes("Dropped dangling edge")));
});

test("layers cover wiki areas, cluster topics, sources and Other", () => {
  const explicit = scan(
    [
      node("page:concepts/a", "A", "page", { pagePath: "wiki/concepts/a.md" }),
      node("page:entities/b", "B", "page", { pagePath: "wiki/entities/b.md" }),
      node("topic:cluster-x", "X", "topic"),
      node("source:s1", "S", "source"),
      node("claim:c1", "C", "claim"),
    ],
    [
      edge("page:concepts/a", "topic:cluster-x", "part_of"),
      edge("page:concepts/a", "page:entities/b", "links_to"),
      edge("claim:c1", "source:s1", "supported_by"),
    ]);
  const graph = mergeWikiGraph(base(explicit));
  const layers = new Map(graph.layers.map((layer) => [layer.id, layer]));
  assert.deepEqual(layers.get("layer:concepts")!.nodeIds, ["page:concepts/a"]);
  assert.deepEqual(layers.get("layer:entities")!.nodeIds, ["page:entities/b"]);
  assert.deepEqual(layers.get("layer:cluster-x")!.nodeIds, ["page:concepts/a"]);
  assert.deepEqual(layers.get("layer:sources")!.nodeIds, ["source:s1"]);
  assert.ok(layers.get("layer:other")!.nodeIds.includes("topic:cluster-x"));
});

test("communities and output are deterministic across runs", () => {
  const build = () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    for (let index = 0; index < 8; index++) nodes.push(node(`page:concepts/p${index}`, `P${index}`));
    for (let index = 0; index < 7; index++) edges.push(edge(`page:concepts/p${index}`, `page:concepts/p${index + 1}`, "links_to"));
    edges.push(edge("page:concepts/p0", "page:concepts/p7", "links_to"));
    return mergeWikiGraph(base(scan(nodes, edges)));
  };
  const first = build();
  const second = build();
  assert.deepEqual(first.nodes.map((item) => [item.id, item.community]), second.nodes.map((item) => [item.id, item.community]));
  assert.ok(first.nodes.every((item) => typeof item.community === "number"));
});

test("merging does not mutate the input scan nodes", () => {
  const nodes = [node("page:concepts/a", "A"), node("page:concepts/b", "B")];
  const edges = [edge("page:concepts/a", "page:concepts/b", "links_to"), edge("page:concepts/b", "page:concepts/a", "links_to")];
  const input = scan(nodes, edges);
  mergeWikiGraph(base(input));
  assert.ok(input.nodes.every((item) => item.community === undefined));
  assert.ok(input.nodes.every((item) => item.degree === undefined));
});

test("validator issues throw instead of returning a broken graph", () => {
  const explicit = scan(
    [node("page:concepts/a", "A"), node("page:concepts/b", "B")],
    [edge("page:concepts/a", "page:concepts/b", "links_to", { confidence: 1.7 })]);
  assert.throws(() => mergeWikiGraph(base(explicit)), /validation failed/);
});
