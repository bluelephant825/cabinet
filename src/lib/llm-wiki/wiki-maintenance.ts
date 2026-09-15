import { createHash } from "node:crypto";
import path from "node:path";
import yaml from "js-yaml";
import { record, relativePath } from "./filesystem";
import { WIKI_MAX_PAGES } from "./execution-limits";
import type { WikiCompilationPlanner, WikiCompilationRequest } from "./compiler";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const names = ["index", "overview", "concept-table", "log"] as const;
const areas = ["sources", "entities", "concepts", "comparisons", "synthesis"] as const;
const literal = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/([\\`*_{}[\]()#+.!|~-])/g, "\\$1").replace(/[\r\n]+/g, " ");
const encode = (value: string) => value.split("/").map((part) => encodeURIComponent(part).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join("/");
const labels = { sources: "Sources", entities: "Entities", concepts: "Concepts", comparisons: "Comparisons", synthesis: "Synthesis" };

/** The only HTML comments accepted by the compiler. They carry no executable
 * content and delimit/hash generated navigation or identify append-only log entries. */
export function isWikiMaintenanceMarker(value: string) {
  return /^<!-- cabinet-wiki:(?:(?:index|overview|concept-table):(?:start [a-f0-9]{64}|end)|log:entry [a-f0-9]{64} [a-f0-9]{64}) -->$/.test(value.trim());
}
function managed(existing: string | undefined, name: string, title: string, content: string) {
  const body = `\n${content}\n`;
  const block = `<!-- cabinet-wiki:${name}:start ${hash(body)} -->${body}<!-- cabinet-wiki:${name}:end -->`;
  if (existing === undefined) return `# ${title}\n\n${block}\n`;
  const markers = [...existing.matchAll(/<!-- cabinet-wiki:[\s\S]*?-->/g)];
  if (!markers.length) return existing + (existing.endsWith("\n") ? "\n" : "\n\n") + block + "\n";
  if (markers.length !== 2 || !markers.every((item) => isWikiMaintenanceMarker(item[0]))) throw new Error("Ambiguous Wiki maintenance boundaries");
  const start = markers[0], end = markers[1];
  const match = new RegExp(`^<!-- cabinet-wiki:${name}:start ([a-f0-9]{64}) -->$`).exec(start[0]);
  if (!match || end[0] !== `<!-- cabinet-wiki:${name}:end -->`) throw new Error("Mismatched Wiki maintenance boundaries");
  const inner = existing.slice(start.index! + start[0].length, end.index);
  if (hash(inner) !== match[1]) throw new Error("Generated Wiki section was edited; review before replacing");
  return existing.slice(0, start.index) + block + existing.slice(end.index! + end[0].length);
}
function metadata(markdown: string) {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return {};
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0 || end > 16_384) throw new Error("Invalid Wiki directory front matter");
  return record(yaml.load(normalized.slice(4, end), { schema: yaml.JSON_SCHEMA }));
}
function label(value: unknown, fallback: string) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > 500 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid Wiki directory label");
  return value;
}

/** Compose inside PlanningWikiCompiler so proposed directory/log writes receive
 * the same path, content, hash and stale-input validation as knowledge writes. */
export function withWikiMaintenance(planner: WikiCompilationPlanner, enabled = true): WikiCompilationPlanner {
  if (!enabled) return planner;
  return { async propose(request, signal) {
    const output = record(await planner.propose(structuredClone(request), signal));
    signal.throwIfAborted();
    if (Object.keys(output).join() !== "changes" || !Array.isArray(output.changes) || output.changes.length > 96) throw new Error("Invalid base Wiki maintenance proposal");
    return maintain(request, output.changes);
  } };
}
function maintain(request: WikiCompilationRequest, changes: unknown[]) {
  const projected = new Map(request.pages.map((page) => [page.path, page.markdown]));
  const reserved = new Set(names.map((name) => `${request.wikiRoot}/${name}.md`));
  const seen = new Set<string>();
  const actions = changes.map((value) => {
    const change = record(value), target = relativePath(change.path);
    const key = target.normalize("NFC").toLowerCase();
    if (seen.has(key) || [...reserved].some((item) => item.toLowerCase() === key)) throw new Error("Duplicate or reserved maintenance target");
    seen.add(key);
    if (!target.startsWith(`${request.wikiRoot}/`) || !areas.includes(target.slice(request.wikiRoot.length + 1).split("/")[0] as typeof areas[number])) throw new Error("Maintenance change is outside its Wiki scope");
    if (change.kind === "delete") projected.delete(target);
    else if (change.kind === "write" && typeof change.markdown === "string") projected.set(target, change.markdown);
    else throw new Error("Invalid maintenance write");
    return { kind: change.kind, path: target };
  });
  if (projected.size > WIKI_MAX_PAGES) throw new Error("Wiki directory exceeds maintenance limit");
  const sources = new Set<string>();
  const pages = [...projected].flatMap(([target, markdown]) => {
    if (!target.startsWith(`${request.wikiRoot}/`)) return [];
    const area = target.slice(request.wikiRoot.length + 1).split("/")[0];
    if (!areas.includes(area as typeof areas[number])) return [];
    const meta = metadata(markdown);
    if (meta.cabinet_id !== undefined && meta.cabinet_id !== request.cabinetId || meta.room_path !== undefined && meta.room_path !== request.roomPath) throw new Error("Foreign Wiki directory metadata");
    if (meta.type === "source-summary" && typeof meta.source_id === "string") {
      if (sources.has(meta.source_id)) throw new Error("Duplicate logical Source in Wiki directory");
      sources.add(meta.source_id);
    }
    const title = label(meta.title, path.posix.basename(target, ".md"));
    const status = meta.source_id === request.source.id ? request.source.status : label(meta.source_status ?? meta.status, "unspecified");
    return [{ path: target, area, title, status, category: label(meta.category, "Unspecified") }];
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const link = (page: typeof pages[number]) => `[${literal(page.title)}](${encode(path.posix.relative(request.wikiRoot, page.path))})`;
  const historical = (page: typeof pages[number]) => page.status === "deleted" || page.status === "archived";
  const directory = areas.map((area) => {
    const entries = pages.filter((page) => page.area === area && !historical(page));
    return `## ${labels[area]}\n\n${entries.map((page) => `- ${link(page)}${page.status === "unspecified" ? " (status unspecified)" : ""}`).join("\n") || "No pages yet."}`;
  }).join("\n\n") + `\n\n## Historical pages\n\n${pages.filter(historical).map((page) => `- ${link(page)} (${literal(page.status)})`).join("\n") || "No historical pages."}`;
  const overview = `## Wiki at a glance\n\nThis directory reflects Wiki pages in this ${request.roomPath === null ? "Cabinet" : "room"}. Counts describe pages, not verified facts or completed ingestion.\n\n| Area | Pages | Historical pages |\n| --- | ---: | ---: |\n` +
    areas.map((area) => `| ${labels[area]} | ${pages.filter((page) => page.area === area).length} | ${pages.filter((page) => page.area === area && historical(page)).length} |`).join("\n") +
    `\n\n[Browse the Wiki](index.md) · [Concept table](concept-table.md) · [Operation log](log.md)`;
  const concepts = pages.filter((page) => page.area === "concepts");
  const table = `## Concepts\n\n| Concept | Category | Declared status |\n| --- | --- | --- |\n` +
    (concepts.length ? concepts.map((page) => `| ${link(page)} | ${literal(page.category)} | ${literal(page.status)} |`).join("\n") : "| No concept pages yet | | |") +
    "\n\nStatus comes from page metadata; missing status is not an assertion of current evidence support.";
  const extra: unknown[] = [];
  for (const [name, title, content] of [["index", "Wiki", directory], ["overview", "Wiki overview", overview], ["concept-table", "Concept table", table]]) {
    const target = `${request.wikiRoot}/${name}.md`, old = projected.get(target);
    const markdown = managed(old, name, title, content);
    if (markdown !== old) extra.push({ kind: "write", path: target, markdown, supports: [] });
  }
  if (changes.length) {
    const target = `${request.wikiRoot}/log.md`, old = projected.get(target) ?? "# Wiki operation log\n";
    const id = hash(JSON.stringify([request.cabinetId, request.roomPath, request.operation, request.source.id, request.source.currentVersionId, request.source.lifecycle?.revision ?? 0]));
    const digest = hash(JSON.stringify(changes));
    const prefix = `<!-- cabinet-wiki:log:entry ${id} `;
    const matching = old.split("\n").filter((line) => line.startsWith(prefix));
    const marker = `${prefix}${digest} -->`;
    if (matching.length > 1 || matching.length === 1 && matching[0] !== marker) throw new Error("Conflicting Wiki log entry for this Source operation");
    if (!matching.length) {
      const operation = request.operation === "ingest" ? "ingest" : request.operation === "update" ? "source-update" : "source-delete";
      const versions = request.operation === "delete" ? "Source removed from active use" : request.evidence.map((item) => `v${item.version.version}`).join(" → ");
      const entry = `\n\n${marker}\n## [${request.source.updatedAt}] Prepared ${operation}: ${literal(request.source.title)}\n\nSource: ${request.source.id}\n\n${versions}.\n\nPrepared Wiki changes (publication is separate):\n\n${actions.map((action) => `- ${action.kind === "write" ? "Write" : "Remove"}: ${literal(action.path)}`).join("\n")}\n`;
      extra.push({ kind: "write", path: target, markdown: old + entry, supports: [] });
    }
  }
  if (!changes.length && !projected.has(`${request.wikiRoot}/log.md`)) extra.push({ kind: "write", path: `${request.wikiRoot}/log.md`, markdown: "# Wiki operation log\n", supports: [] });
  return { changes: [...changes, ...extra] };
}
