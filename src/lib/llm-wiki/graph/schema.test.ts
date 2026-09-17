import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEdgeType, normalizeNodeType, parseWikiGraph, validateWikiGraph } from "./schema";
import type { GraphEdge, GraphNode, WikiGraph } from "./types";

const node = (id: string, type: GraphNode["type"] = "page"): GraphNode =>
  ({ id, type, name: id, summary: "", tags: [] });
const edge = (source: string, target: string, type: GraphEdge["type"] = "links_to", extra: Partial<GraphEdge> = {}): GraphEdge =>
  ({ source, target, type, direction: "forward", provenance: "explicit", extractor: "wikilink", confidence: 1, ...extra });
const graph = (nodes: GraphNode[], edges: GraphEdge[], layers: WikiGraph["layers"] = []): WikiGraph => ({
  schemaVersion: 1, kind: "cabinet-wiki-graph", cabinetId: "cab", generatedAt: "2026-01-01T00:00:00Z",
  jobId: "job", inventoryFingerprint: "fp", warnings: [], layers,
  stats: { nodes: nodes.length, edges: edges.length, byNodeType: {}, byEdgeType: {}, explicitEdges: 0, inferredEdges: 0, unresolvedLinks: 0 },
  nodes, edges,
});

test("node and edge alias tables normalize knowledge vocabulary", () => {
  assert.equal(normalizeNodeType("article"), "page");
  assert.equal(normalizeNodeType("File"), "source");
  assert.equal(normalizeNodeType("cluster"), "topic");
  assert.equal(normalizeNodeType("person"), "entity");
  assert.equal(normalizeNodeType("fact"), "claim");
  assert.equal(normalizeNodeType("claim"), "claim");
  assert.equal(normalizeNodeType("nonsense"), null);
  assert.deepEqual(normalizeEdgeType("wikilink"), { type: "links_to", reversed: false });
  assert.deepEqual(normalizeEdgeType("cited_by"), { type: "cites", reversed: true });
  assert.deepEqual(normalizeEdgeType("contains"), { type: "part_of", reversed: true });
  assert.deepEqual(normalizeEdgeType("depends_on"), { type: "builds_on", reversed: false });
  assert.deepEqual(normalizeEdgeType("author"), { type: "authored_by", reversed: false });
  assert.deepEqual(normalizeEdgeType("belongs to"), { type: "categorized_under", reversed: false });
  assert.equal(normalizeEdgeType("nonsense"), null);
});

test("validator flags duplicates, dangling endpoints, prefix and confidence issues", () => {
  const result = validateWikiGraph(graph(
    [node("page:a"), node("page:a"), node("topic:wrong-prefix", "page"), node("page:b")],
    [edge("page:a", "page:b"), edge("page:a", "page:missing"), edge("page:a", "page:b", "links_to", { confidence: 2 })],
    [{ id: "layer:x", name: "X", nodeIds: ["page:a", "page:b", "topic:wrong-prefix", "page:gone"] }]));
  assert.ok(result.issues.some((issue) => issue.includes("Duplicate node id: page:a")));
  assert.ok(result.issues.some((issue) => issue.includes("Edge endpoint missing: page:missing")));
  assert.ok(result.issues.some((issue) => issue.includes("prefix does not match type: topic:wrong-prefix")));
  assert.ok(result.issues.some((issue) => issue.includes("Confidence outside 0..1")));
  assert.ok(result.issues.some((issue) => issue.includes("Layer layer:x references missing node: page:gone")));
});

test("validator warns on self-edges, orphans, unlayered nodes and evidence-free inferred edges", () => {
  const result = validateWikiGraph(graph(
    [node("page:a"), node("page:b"), node("page:c")],
    [
      edge("page:a", "page:a"),
      edge("page:a", "page:b", "related", { provenance: "inferred", extractor: "llm:t", confidence: 0.5 }),
    ]));
  assert.ok(result.warnings.some((warning) => warning.includes("Self-edge: page:a")));
  assert.ok(result.warnings.some((warning) => warning === "1 orphan node(s) with no edges"));
  assert.ok(result.warnings.some((warning) => warning.includes("not in any layer")));
  assert.ok(result.warnings.some((warning) => warning.includes("Inferred edge without evidence")));
  assert.equal(result.stats.nodes, 3);
  assert.equal(result.stats.edges, 2);
  assert.equal(result.stats.byEdgeType.related, 1);
  assert.equal(result.stats.inferredEdges, 1);
});

test("parseWikiGraph rejects wrong kind and bad schema versions", () => {
  const value = graph([node("page:a")], []);
  assert.deepEqual(parseWikiGraph(JSON.parse(JSON.stringify(value))).kind, "cabinet-wiki-graph");
  assert.throws(() => parseWikiGraph({ ...value, kind: "other" }), /Not a Cabinet Wiki graph/);
  assert.throws(() => parseWikiGraph({ ...value, schemaVersion: 2 }), /Not a Cabinet Wiki graph/);
  assert.throws(() => parseWikiGraph({ ...value, nodes: {} }), /Invalid Wiki graph structure/);
});
