import { withWikiMaintenance } from "./wiki-maintenance";
import yaml from "js-yaml";
import { record } from "./filesystem";
import { PlanningWikiCompiler, type WikiSupport } from "./compiler";
import { parseWikiProvenance, verifyWikiProvenance } from "./wiki-provenance";
import type { ProvenancePageSnapshot } from "./update-reconciliation";

const literal = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_{}[\]()#+.!|~-])/g, "\\$1").replace(/[\r\n]+/g, " ");
function frontMatter(markdown: string) {
  if (!markdown.startsWith("---\n")) return { metadata: null, body: markdown };
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0 || end > 16_384) throw new Error("Invalid deletion page front matter");
  return { metadata: record(yaml.load(markdown.slice(4, end), { schema: yaml.JSON_SCHEMA })), body: markdown.slice(end + 5) };
}

/** No inference, publication or lifecycle acknowledgment. The caller supplies a
 * complete provenance inventory; proposals cannot authorize permanent deletion. */
export function createDeletionReconciliationCompiler(root: string, snapshots: readonly ProvenancePageSnapshot[], timeoutMs = 60_000, maintainNavigation = false): PlanningWikiCompiler {
  if (snapshots.length > 100) throw new Error("Too many deletion reconciliation pages");
  const captured = structuredClone(snapshots).map((item) => ({ ...item, provenance: parseWikiProvenance(item.provenance) }));
  if (new Set(captured.map((item) => item.provenance.pagePath)).size !== captured.length) throw new Error("Duplicate deletion page");
  const references = [...new Map(captured.flatMap((item) => item.provenance.knowledge.flatMap((node) => [...node.supports, ...(node.inactiveSupports ?? [])]))
    .map((edge) => [`${edge.sourceId}:${edge.versionId}`, { sourceId: edge.sourceId, versionId: edge.versionId }])).values()];
  return new PlanningWikiCompiler(root, withWikiMaintenance({ async propose(request, signal) {
    if (request.operation !== "delete" || request.source.status !== "deleted") throw new Error("Deletion reconciliation requires a deleted Source");
    signal.throwIfAborted();
    const available = [...request.evidence.map((evidence) => ({ source: request.source, evidence })), ...(request.supportingEvidence ?? [])];
    // A known Source-summary cannot silently disappear from an incomplete inventory.
    for (const page of request.pages.filter((item) => item.path.startsWith(`${request.wikiRoot}/sources/`))) {
      const { metadata } = frontMatter(page.markdown);
      if (metadata?.type === "source-summary" && metadata.source_id === request.source.id && !captured.some((item) => item.provenance.pagePath === page.path)) throw new Error("Source summary is missing from deletion provenance inventory");
    }
    const changes = [];
    for (const snapshot of captured) {
      const graph = snapshot.provenance;
      const page = request.pages.find((item) => item.path === graph.pagePath);
      if (graph.cabinetId !== request.cabinetId || graph.roomPath !== request.roomPath || !page || page.sha256 !== snapshot.markdownHash) throw new Error("Deletion provenance/page snapshot is stale or foreign");
      const parsed = frontMatter(page.markdown);
      const summary = parsed.metadata?.type === "source-summary" && parsed.metadata.source_id === request.source.id;
      if (!summary && !graph.knowledge.some((node) => [...node.supports, ...(node.inactiveSupports ?? [])].some((edge) => edge.sourceId === request.source.id))) continue;
      const notes: string[] = [];
      const knowledge = graph.knowledge.map((node) => {
        const all = [...node.supports, ...(node.inactiveSupports ?? [])];
        const affected = all.some((edge) => edge.sourceId === request.source.id);
        if (!affected) return node;
        const supports = node.supports.filter((edge) => edge.sourceId !== request.source.id && available.some((entry) => entry.source.id === edge.sourceId && entry.source.status === "active" && entry.source.currentVersionId === edge.versionId && entry.evidence.version.id === edge.versionId));
        const inactiveSupports = all.filter((edge) => !supports.includes(edge));
        notes.push(`- ${supports.length ? "Retained with independent current support" : "HISTORICAL ONLY: excluded from current synthesis"}: ${literal(node.text)} (knowledge ${node.id}).`);
        return { ...node, supports, inactiveSupports };
      });
      const provenance = verifyWikiProvenance({ ...graph, knowledge }, graph, available);
      const supportMap = new Map<string, WikiSupport>();
      for (const node of knowledge) for (const edge of node.supports) supportMap.set(`${edge.sourceId}:${edge.versionId}`, { sourceId: edge.sourceId, versionId: edge.versionId });
      const revision = request.source.lifecycle?.revision ?? 0;
      const heading = `## Deleted Source review (${request.source.id}, revision ${revision})`;
      const metadata = summary ? { ...parsed.metadata, source_status: "deleted" } : parsed.metadata;
      const header = metadata ? `---\n${yaml.dump(metadata, { noRefs: true, lineWidth: -1 })}---\n\n` : "";
      // Do not duplicate a same-revision notice in a persisted/retried plan.
      if (parsed.body.includes(heading)) {
        if (JSON.stringify(graph) !== JSON.stringify(provenance) || (summary && parsed.metadata?.source_status !== "deleted")) throw new Error("Deletion notice and provenance disagree; review changed support");
        continue;
      }
      const notice = `${heading}\n\nSource ${request.source.id} is deleted and contributes no current support. This review supersedes earlier support notices for this Source. Historical evidence is retained.\n\n${notes.join("\n")}\n\n---\n\n`;
      changes.push({ kind: "write" as const, path: page.path, markdown: header + notice + parsed.body, provenance, supports: [...supportMap.values()] });
    }
    return { changes };
  } }, maintainNavigation), timeoutMs, references, true);
}
