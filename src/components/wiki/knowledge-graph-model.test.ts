import test from "node:test";
import assert from "node:assert/strict";
import {
  applyLayout, buildGraph, communityLegend, communityPalette, defaultFilters, edgeVisible, initialPosition,
  layerMemberSet, layoutIterations, legendKey, nodeColor, nodeMatches, nodeVisible, typeLegend,
  COMMUNITY_PALETTE, TYPE_COLORS,
} from "./knowledge-graph-model";
import type { GraphEdge, GraphNode, WikiGraph } from "../../lib/llm-wiki/graph/types";

const node = (id: string, type: GraphNode["type"] = "page", extra: Partial<GraphNode> = {}): GraphNode =>
  ({ id, type, name: id, summary: "", tags: [], ...extra });
const edge = (source: string, target: string, type: GraphEdge["type"] = "links_to", extra: Partial<GraphEdge> = {}): GraphEdge =>
  ({ source, target, type, direction: "forward", provenance: "explicit", extractor: "wikilink", confidence: 1, ...extra });
const graphData = (nodes: GraphNode[], edges: GraphEdge[], layers: WikiGraph["layers"] = []): WikiGraph => ({
  schemaVersion: 1, kind: "cabinet-wiki-graph", cabinetId: "cab", generatedAt: "2026-01-01", jobId: "job",
  inventoryFingerprint: "fp", warnings: [], nodes, edges, layers,
  stats: { nodes: nodes.length, edges: edges.length, byNodeType: {}, byEdgeType: {}, explicitEdges: edges.length, inferredEdges: 0, unresolvedLinks: 0 },
});

const fixture = () => graphData(
  [
    node("page:a", "page", { degree: 4, community: 0 }),
    node("page:b", "page", { degree: 2, community: 1 }),
    node("topic:t", "topic", { degree: 1 }),
    node("claim:c", "claim"),
  ],
  [
    edge("page:a", "page:b"),
    edge("page:a", "topic:t", "categorized_under"),
    edge("page:b", "claim:c", "asserts"),
    edge("page:a", "page:b", "related", { provenance: "inferred", extractor: "llm:test", confidence: 0.4, evidence: [{ quote: "q" }] }),
    edge("page:a", "page:missing", "links_to"),
  ],
  [{ id: "layer:concepts", name: "Concepts", nodeIds: ["page:a"] }]);

test("buildGraph counts nodes, drops dangling/self edges and sizes by degree", () => {
  const graph = buildGraph(fixture());
  assert.equal(graph.order, 4);
  assert.equal(graph.size, 3); // dangling dropped; a->b pair merges with both records
  assert.equal(graph.getEdgeAttributes("page:a", "page:b").records.length, 2);
  // Mixed explicit+inferred pair renders with the inferred color.
  assert.equal(graph.getEdgeAttributes("page:a", "page:b").color, "#c4b5fd");
  assert.equal(graph.getEdgeAttributes("page:a", "topic:t").color, "#cbd5e1");
  const a = graph.getNodeAttributes("page:a");
  assert.equal(a.label, "page:a");
  assert.equal(a.size, 4 + Math.min(12, 2));
});

test("filter predicate honors types, provenance, confidence, layer and search", () => {
  const data = fixture();
  const filters = defaultFilters();
  const layer = layerMemberSet(data, "layer:concepts");
  assert.equal(nodeVisible(data.nodes[0], filters, layer), true);
  assert.equal(nodeVisible(data.nodes[1], filters, layer), false);
  // Search never hides nodes; nodeMatches drives dim/highlight instead.
  const searching = { ...filters, search: "page:b" };
  assert.equal(nodeVisible(data.nodes[0], searching, null), true);
  assert.equal(nodeMatches(data.nodes[1], "page:b"), true);
  assert.equal(nodeMatches(data.nodes[0], "page:b"), false);
  assert.equal(nodeMatches(data.nodes[0], ""), true);
  const noTopics = { ...filters, nodeTypes: new Set(["page"]) };
  assert.equal(nodeVisible(data.nodes[2], noTopics, null), false);

  const inferred = data.edges[3];
  assert.equal(edgeVisible(inferred, filters), true);
  assert.equal(edgeVisible(inferred, { ...filters, showInferred: false }), false);
  assert.equal(edgeVisible(inferred, { ...filters, minConfidence: 0.5 }), false);
  assert.equal(edgeVisible(data.edges[0], { ...filters, minConfidence: 0.5 }), true);
  assert.equal(edgeVisible(data.edges[0], { ...filters, edgeTypes: new Set(["cites"]) }), false);
});

test("communityLegend ranks by size, labels by top members and buckets the tail", () => {
  const nodes: GraphNode[] = [];
  for (let c = 0; c < 14; c++) {
    for (let i = 0; i <= 14 - c; i++) {
      nodes.push(node(`page:c${c}/p${i}`, "page", { community: c, degree: i, name: `Page ${c}-${i}` }));
    }
  }
  nodes.push(node("claim:x", "claim", { community: 0, degree: 99, name: "A claim" }));
  // Hub nodes are poor label candidates even at high degree.
  nodes.push(node("page:overview", "page", { community: 0, degree: 500, name: "Overview", pageKind: "overview" }));
  nodes.push(node("page:concept-table", "page", { community: 0, degree: 400, name: "Concept Table", pageKind: "concept-table" }));
  nodes.push(node("topic:cluster-hub", "topic", { community: 0, degree: 300, name: "Cluster Hub" }));
  nodes.push(node("topic:none", "topic", { name: "No community" }));
  const data = graphData(nodes, []);
  const legend = communityLegend(data);
  assert.equal(legend.length, 12); // 11 ranked + gray bucket
  assert.equal(legend[0].community, 0);
  assert.equal(legend[0].color, COMMUNITY_PALETTE[0]);
  assert.equal(legend[0].label, "Page 0-14, Page 0-13 +17"); // claims and hubs skipped for labels
  assert.equal(legend[0].size, 19);
  const other = legend[11];
  assert.equal(other.community, -1);
  assert.equal(other.color, "#bab0ac");
  assert.equal(other.label, "Other communities");
  assert.equal(other.size, nodes.filter((n) => typeof n.community === "number" && n.community >= 11).length);
  // Small graph: no gray bucket.
  const small = graphData([node("page:a", "page", { community: 2 }), node("page:b", "page", { community: 2 })], []);
  const smallLegend = communityLegend(small);
  assert.equal(smallLegend.length, 1);
  assert.equal(smallLegend[0].label, "page:a, page:b");
  assert.equal(smallLegend[0].size, 2);
  // A community with only hub members falls back to any non-claim node.
  const hubsOnly = graphData([
    node("topic:cluster-solo", "topic", { community: 1, name: "Cluster Solo" }),
    node("claim:y", "claim", { community: 1 }),
  ], []);
  assert.equal(communityLegend(hubsOnly)[0].label, "Cluster Solo");
});

test("nodeColor honors color mode and palette misses fall back to gray", () => {
  const data = fixture();
  const palette = communityPalette(data);
  const a = data.nodes[0]; // community 0
  const t = data.nodes[2]; // no community
  assert.equal(nodeColor(a, "community", palette), COMMUNITY_PALETTE[0]);
  assert.equal(nodeColor(t, "community", palette), "#bab0ac");
  assert.equal(nodeColor(a, "type", palette), TYPE_COLORS.page);
  assert.equal(nodeColor(t, "type", palette), TYPE_COLORS.topic);
});

test("legendKey maps nodes to legend rows per mode", () => {
  const data = fixture();
  const palette = communityPalette(data);
  assert.equal(legendKey(data.nodes[0], "community", palette), "community:0");
  assert.equal(legendKey(data.nodes[2], "community", palette), "community:-1"); // no community -> gray bucket
  assert.equal(legendKey(data.nodes[0], "type", palette), "type:page");
  assert.equal(legendKey(data.nodes[3], "type", palette), "type:claim");
  const types = typeLegend(data);
  assert.deepEqual(types.map((entry) => entry.key), ["type:page", "type:topic", "type:claim"]);
});

test("initial positions and layout are deterministic", () => {
  assert.deepEqual(initialPosition(3), initialPosition(3));
  assert.notDeepEqual(initialPosition(3), initialPosition(4));
  assert.equal(layoutIterations(10), 200);
  assert.equal(layoutIterations(600), 60);
  assert.equal(layoutIterations(9000), 20);
  const first = buildGraph(fixture());
  const second = buildGraph(fixture());
  applyLayout(first);
  applyLayout(second);
  assert.deepEqual(first.getNodeAttributes("page:a").x, second.getNodeAttributes("page:a").x);
});
