import { createHash } from "node:crypto";
import { record, relativePath } from "./filesystem";
import { SourceStore } from "./source-store";
import { RawPublicationStore } from "./raw-publication";
import { readEvidenceDocument } from "./provenance";
import type { WikiCompilationRequest, WikiEvidence, WikiSupport } from "./compiler";
import type { Source } from "./types";

export const knowledgeKinds = ["claim", "concept", "relationship", "summary-statement", "entity", "qualification"] as const;
export type KnowledgeKind = typeof knowledgeKinds[number];
export interface KnowledgeSupport extends WikiSupport { readonly quote: string; readonly start: number; readonly end: number }
export interface WikiKnowledge {
  readonly id: string;
  readonly kind: KnowledgeKind;
  readonly text: string;
  readonly supports: readonly KnowledgeSupport[];
  /** Excluded from current synthesis; retained for historical traceability. */
  readonly inactiveSupports?: readonly KnowledgeSupport[];
}
export interface WikiProvenance {
  readonly schemaVersion: 1;
  readonly cabinetId: Source["cabinetId"];
  readonly roomPath: string | null;
  readonly pagePath: string;
  readonly knowledge: readonly WikiKnowledge[];
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (scope: Pick<WikiProvenance, "cabinetId" | "roomPath" | "pagePath">, kind: KnowledgeKind, text: string) =>
  hash([scope.cabinetId, scope.roomPath, scope.pagePath, kind, text]);
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).sort().join() !== [...keys].sort().join()) throw new Error("Invalid Wiki provenance fields");
}
function bounded(value: unknown, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw new Error("Invalid Wiki provenance text");
  return value;
}
const uuid = (value: unknown) => {
  const text = bounded(value, 36);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)) throw new Error("Invalid Wiki provenance identity");
  return text;
};
/** Portable, versioned machine record. Structural decoding is not evidence verification. */
export function parseWikiProvenance(value: unknown): WikiProvenance {
  const data = record(value); exact(data, ["schemaVersion", "cabinetId", "roomPath", "pagePath", "knowledge"]);
  if (data.schemaVersion !== 1 || !Array.isArray(data.knowledge) || data.knowledge.length > 256) throw new Error("Invalid Wiki provenance schema or count");
  const cabinetId = uuid(data.cabinetId) as Source["cabinetId"], roomPath = data.roomPath === null ? null : relativePath(data.roomPath);
  const pagePath = relativePath(data.pagePath);
  if (!pagePath.endsWith(".md")) throw new Error("Invalid Wiki provenance page");
  const scope = { cabinetId, roomPath, pagePath }, ids = new Set<string>();
  let edges = 0;
  const knowledge = data.knowledge.map((value): WikiKnowledge => {
    const node = record(value); exact(node, ["id", "kind", "text", "supports", ...(node.inactiveSupports === undefined ? [] : ["inactiveSupports"])]);
    if (!knowledgeKinds.includes(node.kind as KnowledgeKind)) throw new Error("Invalid Wiki knowledge kind");
    const kind = node.kind as KnowledgeKind, text = bounded(node.text, 1000);
    const id = identity(scope, kind, text);
    if (node.id !== id || ids.has(id)) throw new Error("Invalid or duplicate Wiki knowledge identity");
    ids.add(id);
    const inactive = node.inactiveSupports ?? [];
    if (!Array.isArray(node.supports) || !Array.isArray(inactive) || !(node.supports.length + inactive.length) || node.supports.length + inactive.length > 64 || (edges += node.supports.length + inactive.length) > 2048) throw new Error("Invalid Wiki knowledge supports");
    const all = [...node.supports, ...inactive].map((value): KnowledgeSupport => {
      const edge = record(value); exact(edge, ["sourceId", "versionId", "quote", "start", "end"]);
      const sourceId = uuid(edge.sourceId) as Source["id"], versionId = uuid(edge.versionId) as WikiSupport["versionId"];
      const quote = bounded(edge.quote, 500);
      if (!Number.isSafeInteger(edge.start) || !Number.isSafeInteger(edge.end) || (edge.start as number) < 0 || (edge.end as number) - (edge.start as number) !== quote.length) throw new Error("Invalid Wiki support offsets");
      return { sourceId, versionId, quote, start: edge.start as number, end: edge.end as number };
    });
    if (new Set(all.map((edge) => JSON.stringify(edge))).size !== all.length) throw new Error("Duplicate Wiki support");
    return { id, kind, text, supports: all.slice(0, node.supports.length), ...(inactive.length ? { inactiveSupports: all.slice(node.supports.length) } : {}) };
  });
  return { schemaVersion: 1, ...scope, knowledge };
}
export function encodeWikiProvenance(value: WikiProvenance): string { return JSON.stringify(parseWikiProvenance(value), null, 2) + "\n"; }
export function decodeWikiProvenance(text: string): WikiProvenance {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Wiki provenance exceeds size limit");
  return parseWikiProvenance(JSON.parse(text));
}

/** Accept only supports whose bodies have already been receipt-verified by caller. */
export function verifyWikiProvenance(value: unknown, scope: Pick<WikiProvenance, "cabinetId" | "roomPath" | "pagePath">,
  evidence: readonly { source: Source; evidence: WikiEvidence }[]): WikiProvenance {
  const graph = parseWikiProvenance(value);
  if (graph.cabinetId !== scope.cabinetId || graph.roomPath !== scope.roomPath || graph.pagePath !== scope.pagePath) throw new Error("Foreign Wiki provenance scope");
  for (const node of graph.knowledge) for (const support of [...node.supports, ...(node.inactiveSupports ?? [])]) {
    const found = evidence.find((entry) => entry.source.id === support.sourceId && entry.evidence.version.id === support.versionId);
    if (!found || found.source.cabinetId !== graph.cabinetId || found.source.roomPath !== graph.roomPath || (node.supports.includes(support) && found.source.status !== "active") ||
        found.evidence.version.sourceId !== support.sourceId || found.evidence.version.cabinetId !== graph.cabinetId ||
        found.evidence.body.slice(support.start, support.end) !== support.quote) throw new Error("Unverified Wiki provenance support");
  }
  return graph;
}

export function buildWikiProvenance(request: WikiCompilationRequest, pagePath: string,
  statements: readonly { kind: KnowledgeKind; text: string; quote: string }[]): WikiProvenance {
  const current = request.evidence.find((item) => item.version.id === request.source.currentVersionId);
  if (!current || request.operation === "delete") throw new Error("Current evidence required for Wiki provenance");
  const scope = { cabinetId: request.cabinetId, roomPath: request.roomPath, pagePath };
  const nodes = new Map<string, { id: string; kind: KnowledgeKind; text: string; supports: KnowledgeSupport[] }>();
  for (const item of statements) {
    const id = identity(scope, item.kind, item.text), start = current.body.indexOf(item.quote);
    const edge = { sourceId: request.source.id, versionId: current.version.id, quote: item.quote, start, end: start + item.quote.length };
    const node = nodes.get(id) ?? { id, kind: item.kind, text: item.text, supports: [] };
    if (!node.supports.some((prior) => JSON.stringify(prior) === JSON.stringify(edge))) node.supports.push(edge);
    nodes.set(id, node);
  }
  return verifyWikiProvenance({ schemaVersion: 1, ...scope, knowledge: [...nodes.values()] }, scope, [{ source: request.source, evidence: current }]);
}

/** Status is resolved from current manifests, never copied into immutable support
 * edges. A deleted/missing Source cannot count as current alternate support. */
export async function inspectWikiSupport(root: string, value: WikiProvenance, knowledgeId: string, excludingSourceId: Source["id"]) {
  const graph = parseWikiProvenance(value), node = graph.knowledge.find((item) => item.id === knowledgeId);
  if (!node) throw new Error("Unknown Wiki knowledge identity");
  const allSupports = [...node.supports, ...(node.inactiveSupports ?? [])];
  const store = new SourceStore(root);
  const manifests = new Map(await Promise.all([...new Set(allSupports.map((edge) => edge.sourceId))].map(async (id) => [id, await store.get(id)] as const)));
  const verified = new Map<string, { source: Source; body: string }>();
  for (const edge of allSupports) {
    const manifest = manifests.get(edge.sourceId), version = manifest?.versions.find((item) => item.id === edge.versionId);
    const key = `${edge.sourceId}:${edge.versionId}`;
    if (!version || verified.has(key)) continue;
    const capture = await new RawPublicationStore(root).readCapturedFile(edge.sourceId, edge.versionId, "source.md", 2 * 1024 * 1024);
    verified.set(key, { source: capture.source, body: readEvidenceDocument(capture.bytes.toString("utf8"), { source: capture.source, version: capture.version }).body });
  }
  const supports = allSupports.map((edge) => {
    const manifest = manifests.get(edge.sourceId);
    if (manifest && (manifest.source.cabinetId !== graph.cabinetId || manifest.source.roomPath !== graph.roomPath)) throw new Error("Foreign Wiki support scope");
    const version = manifest?.versions.find((item) => item.id === edge.versionId);
    const captured = verified.get(`${edge.sourceId}:${edge.versionId}`);
    if (captured && (captured.source.cabinetId !== graph.cabinetId || captured.source.roomPath !== graph.roomPath || captured.body.slice(edge.start, edge.end) !== edge.quote)) throw new Error("Wiki support evidence verification failed");
    const sourceStatus = captured?.source.status ?? manifest?.source.status ?? "missing";
    const versionStatus = !version ? "missing" : (captured?.source ?? manifest!.source).currentVersionId === version.id ? "current" : "historical";
    const inactive = !node.supports.includes(edge);
    return { ...edge, inactive, sourceStatus, versionStatus, currentlySupported: !inactive && sourceStatus === "active" && versionStatus === "current" };
  });
  return { knowledgeId, supports, supportedElsewhere: supports.some((edge) => edge.sourceId !== excludingSourceId && edge.currentlySupported) };
}
