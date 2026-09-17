/**
 * Portable Wiki knowledge-graph contracts. Deterministic (explicit) edges come
 * from wikilinks, frontmatter and provenance; inferred edges arrive through
 * the LLM analysis pass. No runtime imports.
 */
export type GraphNodeType = "page" | "source" | "topic" | "entity" | "claim";
export type PageKind = "source-summary" | "entity" | "concept" | "comparison" | "synthesis" | "overview" | "concept-table";
export type GraphEdgeType =
  | "links_to" | "cites" | "categorized_under" | "part_of" | "asserts" | "supported_by"
  | "related" | "similar_to" | "builds_on" | "contradicts" | "exemplifies" | "authored_by";
export type GraphEdgeDirection = "forward" | "bidirectional";
export type GraphEdgeProvenance = "explicit" | "inferred";
export type GraphExtractor =
  | "wikilink" | "frontmatter" | "provenance" | "concept-table" | "source-manifest" | `llm:${string}`;

export interface GraphEvidence {
  pagePath?: string;
  sourceId?: string;
  versionId?: string;
  quote: string;
  start?: number;
  end?: number;
}

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  summary: string;
  tags: string[];
  pagePath?: string;
  pageKind?: PageKind;
  category?: string;
  community?: number;
  degree?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: GraphEdgeType;
  direction: GraphEdgeDirection;
  provenance: GraphEdgeProvenance;
  extractor: GraphExtractor;
  confidence: number;
  description?: string;
  evidence?: GraphEvidence[];
}

export interface GraphLayer { id: string; name: string; nodeIds: string[] }

export interface WikiGraphStats {
  nodes: number;
  edges: number;
  byNodeType: Record<string, number>;
  byEdgeType: Record<string, number>;
  explicitEdges: number;
  inferredEdges: number;
  unresolvedLinks: number;
}

export interface WikiGraph {
  schemaVersion: 1;
  kind: "cabinet-wiki-graph";
  cabinetId: string;
  generatedAt: string;
  jobId: string;
  inventoryFingerprint: string;
  stats: WikiGraphStats;
  warnings: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  layers: GraphLayer[];
}

export const WIKI_GRAPH_KIND = "cabinet-wiki-graph" as const;
export const WIKI_GRAPH_FILE = "graph.json";

export const graphNodeTypes: readonly GraphNodeType[] = ["page", "source", "topic", "entity", "claim"];
export const pageKinds: readonly PageKind[] = ["source-summary", "entity", "concept", "comparison", "synthesis", "overview", "concept-table"];
export const graphEdgeTypes: readonly GraphEdgeType[] = [
  "links_to", "cites", "categorized_under", "part_of", "asserts", "supported_by",
  "related", "similar_to", "builds_on", "contradicts", "exemplifies", "authored_by",
];
