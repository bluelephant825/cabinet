import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import { slugify } from "../wiki-index";
import { normalizeEdgeType, normalizeNodeType, validateWikiGraph } from "./schema";
import type { ScanResult } from "./scan";
import type { GraphEdge, GraphLayer, GraphNode, WikiGraph } from "./types";
import { WIKI_GRAPH_KIND } from "./types";

export interface MergeInput {
  explicit: ScanResult;
  inferred: ScanResult[];
  wikiRoot: string;
  cabinetId: string;
  jobId: string;
  inventoryFingerprint: string;
  generatedAt?: string;
}

/** Deterministic PRNG (mulberry32) so Louvain communities are reproducible. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

const wikiAreas = ["sources", "entities", "concepts", "comparisons", "synthesis"];
const areaName = (area: string) => `${area.slice(0, 1).toUpperCase()}${area.slice(1)}`;

/** Combine the deterministic scan with inferred analyses into the published
 * graph: explicit nodes/edges win, aliases normalize, communities and layers
 * are computed, and structural issues throw. */
export function mergeWikiGraph(input: MergeInput): WikiGraph {
  const warnings: string[] = [...input.explicit.warnings];
  const nodes = new Map<string, GraphNode>();
  const remap = new Map<string, string>();

  for (const node of input.explicit.nodes) nodes.set(node.id, { ...node });
  // Slug-keyed identity index: case-, hyphen- and accent-insensitive, so an
  // inferred "Big Tech" entity collapses onto an explicit "big-tech" topic or
  // a page whose title or file stem slugifies the same. Claims never merge.
  const nameIndex = new Map<string, string>();
  const indexNode = (node: GraphNode) => {
    if (node.type === "claim") return;
    const key = slugify(node.name);
    if (key && !nameIndex.has(key)) nameIndex.set(key, node.id);
    if (node.type === "page") {
      const stemKey = slugify(node.id.slice("page:".length).split("/").pop() ?? "");
      if (stemKey && !nameIndex.has(stemKey)) nameIndex.set(stemKey, node.id);
    }
  };
  for (const node of nodes.values()) indexNode(node);
  for (const scan of input.inferred) {
    warnings.push(...scan.warnings);
    for (const node of scan.nodes) {
      const type = normalizeNodeType(node.type) ?? "topic";
      let id = node.id;
      const expected = `${type}:`;
      const key = slugify(node.name);
      if (!id.startsWith(expected)) {
        const match = key ? nameIndex.get(key) : undefined;
        if (match) { remap.set(id, match); continue; }
        id = `${expected}${id.replace(/^[a-z-]+:/i, "")}`;
      }
      if (nodes.has(id)) { remap.set(node.id, id); continue; }
      const match = key ? nameIndex.get(key) : undefined;
      if (match && type !== "claim") { remap.set(node.id, match); continue; }
      const copy = { ...node, id, type };
      nodes.set(id, copy);
      indexNode(copy);
    }
  }

  const edges = new Map<string, GraphEdge>();
  const push = (edge: GraphEdge) => {
    const normalized = normalizeEdgeType(edge.type);
    let { source, target, type } = { source: edge.source, target: edge.target, type: edge.type };
    if (!normalized) {
      type = "related";
      warnings.push(`Unknown edge type "${edge.type}" normalized to related: ${edge.source} -> ${edge.target}`);
    } else {
      type = normalized.type;
      if (normalized.reversed) [source, target] = [target, source];
    }
    source = remap.get(source) ?? source;
    target = remap.get(target) ?? target;
    if (!nodes.has(source) || !nodes.has(target)) {
      warnings.push(`Dropped dangling edge: ${source} -> ${target} (${type})`);
      return;
    }
    const candidate: GraphEdge = { ...edge, source, target, type };
    const key = `${source}	${target}	${type}`;
    const prior = edges.get(key);
    if (!prior || (prior.provenance === "inferred" && (candidate.provenance === "explicit" || candidate.confidence > prior.confidence))) {
      edges.set(key, candidate);
    }
  };
  for (const edge of input.explicit.edges) push(edge);
  for (const scan of input.inferred) for (const edge of scan.edges) push(edge);

  // Communities over an undirected simple projection. Degree is recomputed on
  // the merged edge set so inferred nodes size correctly too.
  const edgeList = [...edges.values()];
  for (const node of nodes.values()) node.degree = 0;
  for (const edge of edgeList) {
    nodes.get(edge.source)!.degree!++;
    nodes.get(edge.target)!.degree!++;
  }
  if (edgeList.length >= 2) {
    const graph = new Graph({ multi: false, type: "undirected" });
    for (const id of nodes.keys()) graph.addNode(id);
    for (const edge of edgeList) {
      if (edge.source === edge.target) continue;
      graph.mergeEdge(edge.source, edge.target);
    }
    if (graph.order && graph.size >= 2) {
      const communities = louvain(graph, { rng: seeded(1) });
      for (const [id, community] of Object.entries(communities)) {
        const node = nodes.get(id);
        if (node) node.community = community as number;
      }
    }
  }

  // Layers: one per wiki area, one per cluster topic, Sources, then Other.
  const layers: GraphLayer[] = [];
  const layered = new Set<string>();
  const prefix = `${input.wikiRoot}/`;
  for (const area of wikiAreas) {
    const members = [...nodes.values()]
      .filter((node) => node.type === "page" && node.pagePath?.startsWith(`${prefix}${area}/`))
      .map((node) => node.id).sort();
    if (members.length) {
      for (const id of members) layered.add(id);
      layers.push({ id: `layer:${area}`, name: areaName(area), nodeIds: members });
    }
  }
  for (const node of [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (node.type !== "topic" || !node.id.startsWith("topic:cluster-")) continue;
    const members = edgeList.filter((edge) => edge.type === "part_of" && edge.target === node.id).map((edge) => edge.source).sort();
    layers.push({ id: `layer:${node.id.slice("topic:".length)}`, name: node.name, nodeIds: members });
    for (const id of members) layered.add(id);
  }
  const sourceNodes = [...nodes.values()].filter((node) => node.type === "source").map((node) => node.id).sort();
  if (sourceNodes.length) {
    const existing = layers.find((layer) => layer.id === "layer:sources");
    if (existing) existing.nodeIds = [...new Set([...existing.nodeIds, ...sourceNodes])].sort();
    else layers.push({ id: "layer:sources", name: "Sources", nodeIds: sourceNodes });
    for (const id of sourceNodes) layered.add(id);
  }
  const other = [...nodes.keys()].filter((id) => !layered.has(id)).sort();
  if (other.length) layers.push({ id: "layer:other", name: "Other", nodeIds: other });

  const graph: WikiGraph = {
    schemaVersion: 1, kind: WIKI_GRAPH_KIND, cabinetId: input.cabinetId,
    generatedAt: input.generatedAt ?? new Date().toISOString(), jobId: input.jobId,
    inventoryFingerprint: input.inventoryFingerprint, warnings: [],
    stats: { nodes: 0, edges: 0, byNodeType: {}, byEdgeType: {}, explicitEdges: 0, inferredEdges: 0, unresolvedLinks: 0 },
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: edgeList.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.type.localeCompare(b.type)),
    layers,
  };
  const result = validateWikiGraph(graph);
  if (result.issues.length) throw new Error(`Wiki graph validation failed: ${result.issues.slice(0, 5).join("; ")}`);
  result.stats.unresolvedLinks = input.explicit.unresolvedLinks +
    input.inferred.reduce((total, scan) => total + scan.unresolvedLinks, 0);
  graph.stats = result.stats;
  graph.warnings = [...warnings, ...result.warnings];
  return graph;
}
