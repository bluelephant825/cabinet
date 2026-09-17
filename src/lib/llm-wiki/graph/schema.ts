import { record } from "../filesystem";
import {
  WIKI_GRAPH_KIND, graphEdgeTypes, graphNodeTypes, pageKinds,
  type GraphEdgeType, type GraphNodeType, type WikiGraph, type WikiGraphStats,
} from "./types";

/** Knowledge-subset aliases ported from Understand Anything's normalize-graph. */
export const NODE_TYPE_ALIASES: Record<string, GraphNodeType> = {
  article: "page", document: "page", page: "page",
  file: "source", raw: "source", source: "source",
  category: "topic", tag: "topic", cluster: "topic", topic: "topic",
  person: "entity", organization: "entity", technology: "entity", project: "entity", paper: "entity", entity: "entity",
  statement: "claim", fact: "claim", claim: "claim",
};

export const EDGE_TYPE_ALIASES: Record<string, { type: GraphEdgeType; reversed: boolean }> = {
  wikilink: { type: "links_to", reversed: false }, link: { type: "links_to", reversed: false },
  links: { type: "links_to", reversed: false }, links_to: { type: "links_to", reversed: false },
  references: { type: "links_to", reversed: false }, reference: { type: "links_to", reversed: false },
  cite: { type: "cites", reversed: false }, citation: { type: "cites", reversed: false },
  cites: { type: "cites", reversed: false }, cited_by: { type: "cites", reversed: true },
  category: { type: "categorized_under", reversed: false }, categorized: { type: "categorized_under", reversed: false },
  categorized_under: { type: "categorized_under", reversed: false },
  tagged: { type: "categorized_under", reversed: false }, belongs_to: { type: "categorized_under", reversed: false },
  part_of: { type: "part_of", reversed: false }, member_of: { type: "part_of", reversed: false },
  contains: { type: "part_of", reversed: true },
  extends: { type: "builds_on", reversed: false }, builds_on: { type: "builds_on", reversed: false },
  depends_on: { type: "builds_on", reversed: false }, derived_from: { type: "builds_on", reversed: false },
  conflicts_with: { type: "contradicts", reversed: false }, contradicts: { type: "contradicts", reversed: false },
  disputes: { type: "contradicts", reversed: false },
  example_of: { type: "exemplifies", reversed: false }, instance_of: { type: "exemplifies", reversed: false },
  exemplifies: { type: "exemplifies", reversed: false },
  written_by: { type: "authored_by", reversed: false }, author: { type: "authored_by", reversed: false },
  authored_by: { type: "authored_by", reversed: false },
  relates: { type: "related", reversed: false }, related: { type: "related", reversed: false },
  related_to: { type: "related", reversed: false }, similar: { type: "related", reversed: false },
  similar_to: { type: "similar_to", reversed: false },
  asserts: { type: "asserts", reversed: false }, supported_by: { type: "supported_by", reversed: false },
};

export function normalizeNodeType(value: unknown): GraphNodeType | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  if ((graphNodeTypes as string[]).includes(key)) return key as GraphNodeType;
  return NODE_TYPE_ALIASES[key] ?? null;
}

export function normalizeEdgeType(value: unknown): { type: GraphEdgeType; reversed: boolean } | null {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return EDGE_TYPE_ALIASES[key] ?? null;
}

const NODE_PREFIX: Record<GraphNodeType, string> = { page: "page:", source: "source:", topic: "topic:", entity: "entity:", claim: "claim:" };

/** Structural and referential QA checks ported from the graph-reviewer
 * checklist. Issues make the graph unpublishable; warnings are recorded. */
export function validateWikiGraph(graph: WikiGraph): { issues: string[]; warnings: string[]; stats: WikiGraphStats } {
  const issues: string[] = [];
  const warnings: string[] = [];
  const ids = new Set<string>();
  const degree = new Map<string, number>();
  const byNodeType: Record<string, number> = {};
  const byEdgeType: Record<string, number> = {};
  let explicitEdges = 0, inferredEdges = 0;

  for (const node of graph.nodes) {
    if (typeof node.id !== "string" || typeof node.name !== "string" || typeof node.summary !== "string" ||
        !Array.isArray(node.tags) || !(graphNodeTypes as string[]).includes(node.type)) {
      issues.push(`Invalid node record: ${JSON.stringify(node.id)}`);
      continue;
    }
    if (ids.has(node.id)) issues.push(`Duplicate node id: ${node.id}`);
    ids.add(node.id);
    if (!node.id.startsWith(NODE_PREFIX[node.type])) issues.push(`Node id prefix does not match type: ${node.id}`);
    if (node.pageKind !== undefined && !(pageKinds as string[]).includes(node.pageKind)) issues.push(`Invalid pageKind: ${node.id}`);
    degree.set(node.id, node.degree ?? 0);
    byNodeType[node.type] = (byNodeType[node.type] ?? 0) + 1;
  }

  const seen = new Set<string>();
  for (const edge of graph.edges) {
    if (typeof edge.source !== "string" || typeof edge.target !== "string" ||
        !(graphEdgeTypes as string[]).includes(edge.type) || typeof edge.confidence !== "number") {
      issues.push(`Invalid edge record: ${JSON.stringify(edge)}`.slice(0, 200));
      continue;
    }
    if (!ids.has(edge.source)) issues.push(`Edge endpoint missing: ${edge.source} (${edge.type})`);
    if (!ids.has(edge.target)) issues.push(`Edge endpoint missing: ${edge.target} (${edge.type})`);
    if (edge.confidence < 0 || edge.confidence > 1) issues.push(`Confidence outside 0..1: ${edge.source} -> ${edge.target}`);
    if (edge.source === edge.target) warnings.push(`Self-edge: ${edge.source} (${edge.type})`);
    const key = `${edge.source}	${edge.target}	${edge.type}`;
    if (seen.has(key)) warnings.push(`Duplicate edge: ${edge.source} -> ${edge.target} (${edge.type})`);
    seen.add(key);
    if (edge.provenance === "inferred" && (!Array.isArray(edge.evidence) || !edge.evidence.length))
      warnings.push(`Inferred edge without evidence: ${edge.source} -> ${edge.target} (${edge.type})`);
    if (edge.provenance === "explicit") explicitEdges++; else inferredEdges++;
    byEdgeType[edge.type] = (byEdgeType[edge.type] ?? 0) + 1;
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  const orphans = [...degree.entries()].filter(([, value]) => value === 0).map(([id]) => id);
  if (orphans.length) warnings.push(`${orphans.length} orphan node(s) with no edges`);

  const layered = new Set<string>();
  for (const layer of graph.layers) {
    if (typeof layer.id !== "string" || typeof layer.name !== "string" || !Array.isArray(layer.nodeIds)) {
      issues.push(`Invalid layer record: ${JSON.stringify(layer.id)}`);
      continue;
    }
    for (const id of layer.nodeIds) {
      if (!ids.has(id)) issues.push(`Layer ${layer.id} references missing node: ${id}`);
      layered.add(id);
    }
  }
  const unlayered = [...ids].filter((id) => !layered.has(id));
  if (unlayered.length) warnings.push(`${unlayered.length} node(s) not in any layer`);

  const stats: WikiGraphStats = {
    nodes: graph.nodes.length, edges: graph.edges.length, byNodeType, byEdgeType,
    explicitEdges, inferredEdges, unresolvedLinks: graph.stats?.unresolvedLinks ?? 0,
  };
  return { issues, warnings, stats };
}

/** Structural decode used by the store: throws on the wrong kind marker or
 * schema version so a hand-edited or foreign file never loads silently. */
export function parseWikiGraph(value: unknown): WikiGraph {
  const data = record(value);
  if (data.schemaVersion !== 1 || data.kind !== WIKI_GRAPH_KIND) throw new Error("Not a Cabinet Wiki graph");
  if (typeof data.cabinetId !== "string" || typeof data.generatedAt !== "string" || typeof data.jobId !== "string" ||
      typeof data.inventoryFingerprint !== "string" || !Array.isArray(data.nodes) || !Array.isArray(data.edges) ||
      !Array.isArray(data.layers) || !Array.isArray(data.warnings) || typeof data.stats !== "object" || data.stats === null) {
    throw new Error("Invalid Wiki graph structure");
  }
  return data as unknown as WikiGraph;
}
