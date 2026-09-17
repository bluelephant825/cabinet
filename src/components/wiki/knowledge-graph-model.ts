import Graph from "graphology";
import forceAtlas2 from "graphology-layout-forceatlas2";
import type { GraphEdge, GraphNode, WikiGraph } from "../../lib/llm-wiki/graph/types";

export const COMMUNITY_PALETTE = [
  "#4f79a7", "#f28e2b", "#e15759", "#76b7b2", "#59a14f", "#edc948",
  "#b07aa1", "#ff9da7", "#9c755f", "#bab0ac", "#86bcb6", "#8cd17d",
];
export const TYPE_COLORS: Record<string, string> = {
  page: "#4f79a7", source: "#9c755f", topic: "#59a14f", entity: "#b07aa1", claim: "#edc948",
};
export const EXPLICIT_EDGE_TYPES = ["links_to", "cites", "categorized_under", "part_of", "asserts", "supported_by"];
export const INFERRED_EDGE_TYPES = ["related", "similar_to", "builds_on", "contradicts", "exemplifies", "authored_by"];
export const NODE_TYPES = ["page", "source", "topic", "entity", "claim"];
export const OTHER_COMMUNITY_COLOR = "#bab0ac";

export type ColorMode = "community" | "type";

export interface GraphFilters {
  nodeTypes: ReadonlySet<string>;
  edgeTypes: ReadonlySet<string>;
  showInferred: boolean;
  minConfidence: number;
  /** Layer id, or null for all. */
  layer: string | null;
  search: string;
  colorMode: ColorMode;
  /** Legend key ("community:<n>" / "type:<type>") whose members stay lit. */
  legendFocus: string | null;
}

export const defaultFilters = (): GraphFilters => ({
  nodeTypes: new Set(NODE_TYPES),
  edgeTypes: new Set([...EXPLICIT_EDGE_TYPES, ...INFERRED_EDGE_TYPES]),
  showInferred: true, minConfidence: 0, layer: null, search: "",
  colorMode: "community", legendFocus: null,
});

export function nodeVisible(node: GraphNode, filters: GraphFilters, layerMembers: ReadonlySet<string> | null): boolean {
  if (!filters.nodeTypes.has(node.type)) return false;
  if (layerMembers && !layerMembers.has(node.id)) return false;
  return true;
}

/** Search dims rather than hides: non-matching nodes stay rendered muted. */
export function nodeMatches(node: GraphNode, search: string): boolean {
  return !search || node.name.toLowerCase().includes(search.toLowerCase());
}

export function edgeVisible(edge: GraphEdge, filters: GraphFilters): boolean {
  if (!filters.edgeTypes.has(edge.type)) return false;
  if (edge.provenance === "inferred" && (!filters.showInferred || edge.confidence < filters.minConfidence)) return false;
  return true;
}

/** Deterministic golden-angle spiral so layouts do not depend on Math.random. */
export function initialPosition(index: number): { x: number; y: number } {
  const angle = index * 2.399963229728653;
  const radius = 10 * Math.sqrt(index + 0.5);
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

export function layoutIterations(count: number): number {
  return count < 500 ? 200 : count < 5000 ? 60 : 20;
}

export function nodeColor(node: GraphNode, mode: ColorMode, palette: ReadonlyMap<number, string>): string {
  if (mode === "type") return TYPE_COLORS[node.type] ?? OTHER_COMMUNITY_COLOR;
  return (typeof node.community === "number" ? palette.get(node.community) : undefined) ?? OTHER_COMMUNITY_COLOR;
}

/** Legend key used by legendFocus: "community:<rank>" (or -1 for the gray
 * bucket / uncommunitied nodes) in community mode, "type:<type>" in type mode. */
export function legendKey(node: GraphNode, mode: ColorMode, palette: ReadonlyMap<number, string>): string {
  if (mode === "type") return `type:${node.type}`;
  return `community:${typeof node.community === "number" && palette.has(node.community) ? node.community : -1}`;
}

export interface LegendEntry { community: number; color: string; label: string; size: number }

const clip = (name: string) => (name.length > 28 ? `${name.slice(0, 25).trimEnd()}...` : name);

/** Top communities by member count, labeled by their two highest-degree
 * non-claim members (pages/topics preferred). The tail collapses into one
 * gray "Other communities" entry. */
export function communityLegend(graph: WikiGraph, max = 11): LegendEntry[] {
  const members = new Map<number, GraphNode[]>();
  for (const node of graph.nodes) {
    if (typeof node.community !== "number") continue;
    members.set(node.community, [...(members.get(node.community) ?? []), node]);
  }
  const ranked = [...members.entries()].sort((a, b) => b[1].length - a[1].length || a[0] - b[0]);
  const preferred = (node: GraphNode) => (node.type === "page" || node.type === "topic" ? 1 : 0);
  // Overview/concept-table pages and cluster topics sit in every community;
  // they make useless labels, so only fall back to them when nothing else exists.
  const isHub = (node: GraphNode) =>
    node.pageKind === "overview" || node.pageKind === "concept-table" || node.id.startsWith("topic:cluster-");
  const entries = ranked.slice(0, max).map(([community, nodes], rank) => {
    const nonClaim = nodes.filter((node) => node.type !== "claim");
    const candidates = nonClaim.filter((node) => !isHub(node));
    const top = (candidates.length ? candidates : nonClaim)
      .sort((a, b) => preferred(b) - preferred(a) || (b.degree ?? 0) - (a.degree ?? 0) || a.id.localeCompare(b.id))
      .slice(0, 2);
    const rest = nodes.length - 2;
    return {
      community, color: COMMUNITY_PALETTE[rank], size: nodes.length,
      label: top.length ? top.map((node) => clip(node.name)).join(", ") + (rest > 0 ? ` +${rest}` : "") : `Community ${community}`,
    };
  });
  const tail = ranked.slice(max);
  if (tail.length) {
    entries.push({ community: -1, color: OTHER_COMMUNITY_COLOR, label: "Other communities",
      size: tail.reduce((total, [, nodes]) => total + nodes.length, 0) });
  }
  return entries;
}

export function communityPalette(graph: WikiGraph, max = 11): Map<number, string> {
  return new Map(communityLegend(graph, max).filter((entry) => entry.community >= 0).map((entry) => [entry.community, entry.color]));
}

/** Type-mode legend rows: one per node type present in the graph. */
export function typeLegend(graph: WikiGraph): { key: string; color: string; label: string; size: number }[] {
  return NODE_TYPES
    .map((type) => ({ type, size: graph.nodes.filter((node) => node.type === type).length }))
    .filter((entry) => entry.size > 0)
    .map((entry) => ({ key: `type:${entry.type}`, color: TYPE_COLORS[entry.type], label: entry.type, size: entry.size }));
}

export function nodeSize(node: GraphNode): number {
  return 4 + Math.min(12, Math.sqrt(node.degree ?? 0));
}

/** Build the render graph: node attributes carry the full record for the
 * detail panel; edge key is stable for reducer lookups. */
export function buildGraph(data: WikiGraph): Graph {
  const graph = new Graph({ multi: false, type: "directed" });
  const palette = communityPalette(data);
  data.nodes.forEach((node, index) => {
    graph.addNode(node.id, {
      label: node.name, size: nodeSize(node), color: nodeColor(node, "community", palette),
      ...initialPosition(index), record: node,
    });
  });
  for (const edge of data.edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target) || edge.source === edge.target) continue;
    // A simple graph collapses parallel edges of different types between the
    // same pair; keep every record so reducers and the detail panel see them.
    const existing = graph.hasEdge(edge.source, edge.target) ? graph.getEdgeAttributes(edge.source, edge.target) : null;
    if (existing) {
      (existing.records as GraphEdge[]).push(edge);
      if (edge.provenance === "inferred") existing.color = "#c4b5fd";
      continue;
    }
    // Sigma 3 has no dashed-line program; inferred edges get a lighter color.
    graph.addEdge(edge.source, edge.target, {
      size: 1, color: edge.provenance === "inferred" ? "#c4b5fd" : "#cbd5e1", records: [edge],
    });
  }
  return graph;
}

/** Synchronous ForceAtlas2 with a bounded iteration count; a worker variant
 * would need bundler config, so layout runs once on load. */
export function applyLayout(graph: Graph): void {
  if (graph.order < 2 || graph.size === 0) return;
  forceAtlas2.assign(graph, { iterations: layoutIterations(graph.order), settings: forceAtlas2.inferSettings(graph) });
}

export function layerMemberSet(data: WikiGraph, layerId: string | null): Set<string> | null {
  if (!layerId) return null;
  const layer = data.layers.find((item) => item.id === layerId);
  return layer ? new Set(layer.nodeIds) : null;
}
