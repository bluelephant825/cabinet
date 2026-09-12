import path from "node:path";
import yaml from "js-yaml";
import { createHash } from "node:crypto";
import { record } from "./filesystem";
import type { WikiCompilationPlanner, WikiCompilationRequest, WikiProposedChange } from "./compiler";
import type { ProvenancePageSnapshot } from "./update-reconciliation";
import type { WikiKnowledge, WikiProvenance } from "./wiki-provenance";

const literal = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_{}[\]()#+.!|~-])/g, "\\$1").replace(/[\r\n]+/g, " ");
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const link = (from: string, to: string) => path.posix.relative(path.posix.dirname(from), to).split("/").map(encodeURIComponent).join("/");

/** Publication-owned source summaries and shared-mention pages are regenerated
 * from verified evidence. Human edits invalidate inventory hashes for review.
 * Matching a concept label groups attributed mentions, never asserts identity or
 * combines independently worded claims into an unsupported synthesis. */
export class ConnectedWikiPlanner implements WikiCompilationPlanner {
  constructor(private readonly summary: WikiCompilationPlanner, private readonly inventory: readonly ProvenancePageSnapshot[]) {}
  async propose(request: WikiCompilationRequest, signal: AbortSignal) {
    const graphs = new Map<string, WikiProvenance>();
    for (const item of this.inventory) {
      if (item.provenance.roomPath !== request.roomPath) continue;
      const page = request.pages.find((page) => page.path === item.provenance.pagePath);
      if (!page || page.sha256 !== item.markdownHash) throw new Error("A generated Wiki page was edited or removed. Review it before rebuilding.");
      if (!page.path.startsWith(`${request.wikiRoot}/sources/`) && !page.path.startsWith(`${request.wikiRoot}/concepts/shared-`) && item.provenance.knowledge.some((node) => [...node.supports, ...(node.inactiveSupports ?? [])].some((edge) => edge.sourceId === request.source.id))) throw new Error("A custom Wiki page depends on this Source. Reconcile that page before completing this operation.");
      graphs.set(page.path, item.provenance);
    }
    const target = `${request.wikiRoot}/sources/source-${request.source.id}.md`;
    let changes: WikiProposedChange[] = [];
    if (request.operation === "delete") {
      const graph = graphs.get(target);
      const page = request.pages.find((item) => item.path === target);
      if (page && !graph) throw new Error("Source summary provenance is missing");
      if (graph && page) {
        const provenance: WikiProvenance = { ...graph, knowledge: graph.knowledge.map((node) => ({ ...node, supports: [], inactiveSupports: [...node.supports, ...(node.inactiveSupports ?? [])] })) };
        const end = page.markdown.indexOf("\n---\n", 4);
        if (end < 0) throw new Error("Invalid source summary");
        const metadata = record(yaml.load(page.markdown.slice(4, end), { schema: yaml.JSON_SCHEMA }));
        const markdown = `---\n${yaml.dump({ ...metadata, source_status: "deleted" }, { lineWidth: -1 })}---\n\n> Historical source. Removed from current knowledge; captured evidence is preserved.\n\n${page.markdown.slice(end + 5)}`;
        changes.push({ kind: "write", path: target, markdown, provenance, supports: [] });
        graphs.set(target, provenance);
      }
    } else {
      const result = record(await this.summary.propose(request, signal));
      if (!Array.isArray(result.changes)) throw new Error("Invalid source summary proposal");
      changes = result.changes as WikiProposedChange[];
      for (const change of changes) if (change.kind === "write" && change.provenance) graphs.set(change.path, change.provenance);
    }
    const available = [...request.evidence.map((evidence) => ({ source: request.source, evidence })), ...(request.supportingEvidence ?? [])];
    const current = (node: WikiKnowledge) => node.supports.filter((edge) => available.some((item) => item.source.status === "active" && item.source.id === edge.sourceId && item.source.currentVersionId === edge.versionId));
    const groups = new Map<string, { name: string; mentions: { page: string; node: WikiKnowledge }[] }>();
    for (const [page, graph] of graphs) if (page.startsWith(`${request.wikiRoot}/sources/`)) {
      for (const node of graph.knowledge) {
        if (node.kind !== "concept" || !current(node).length) continue;
        const name = node.text.split(": ")[0];
        const key = name.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
        const group = groups.get(key) ?? { name, mentions: [] };
        group.mentions.push({ page, node }); groups.set(key, group);
      }
    }
    const shared = new Set<string>();
    for (const [key, group] of groups) {
      const sourceIds = new Set(group.mentions.flatMap((item) => current(item.node).map((edge) => edge.sourceId)));
      if (sourceIds.size < 2) continue;
      const pagePath = `${request.wikiRoot}/concepts/shared-${digest(key).slice(0, 24)}.md`;
      shared.add(pagePath);
      const scope = { cabinetId: request.cabinetId, roomPath: request.roomPath, pagePath };
      const nodes = new Map<string, WikiKnowledge>();
      for (const { node } of group.mentions) {
        const id = digest([scope.cabinetId, scope.roomPath, pagePath, node.kind, node.text]);
        const prior = nodes.get(id);
        nodes.set(id, { id, kind: node.kind, text: node.text, supports: [...(prior?.supports ?? []), ...current(node)] });
      }
      const knowledge = [...nodes.values()];
      const provenance: WikiProvenance = { schemaVersion: 1, ...scope, knowledge };
      const markdown = `---\n${yaml.dump({ title: group.name, type: "concept", category: "topic", generated_by: "llm-wiki-shared-mentions" })}---\n\n# ${literal(group.name)}\n\nRelated mentions across notes. Each description remains attributed to its own evidence.\n\n${group.mentions.map(({ page, node }) => `- ${literal(node.text)} ([Source summary](${link(pagePath, page)}))`).join("\n")}\n`;
      changes.push({ kind: "write", path: pagePath, markdown, provenance, supports: [...new Map(knowledge.flatMap((node) => node.supports).map((edge) => [`${edge.sourceId}:${edge.versionId}`, { sourceId: edge.sourceId, versionId: edge.versionId }])).values()] });
    }
    for (const page of request.pages) if (page.path.startsWith(`${request.wikiRoot}/concepts/shared-`) && graphs.has(page.path) && !shared.has(page.path)) changes.push({ kind: "delete", path: page.path });
    return { changes };
  }
}
