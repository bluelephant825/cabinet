import yaml from "js-yaml";
import { record, relativePath } from "./filesystem";
import type { WikiCompilationRequest } from "./compiler";
import type { SemanticExtraction } from "./semantic-extraction";
import type { DurabilityContext } from "./durability";

export interface ExistingWikiTarget { readonly path: string; readonly sha256: string; readonly title: string }
export interface ExistingWikiMatch {
  readonly candidateId: string;
  readonly status: "linked" | "review" | "unmatched";
  readonly targets: readonly ExistingWikiTarget[];
}
const normalize = (value: string) => value.normalize("NFC").toLowerCase().replace(/\s+/g, " ").trim();
function label(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("Invalid Wiki identity label");
  return value.trim();
}

/** Local lexical matching, not global identity resolution. Uses only the compiler
 * read set. Ambiguity never selects a winner by page order or model preference. */
export function matchExistingWikiPages(request: WikiCompilationRequest, extraction: SemanticExtraction,
  trusted: NonNullable<DurabilityContext["existingPages"]> = []): ExistingWikiMatch[] {
  if (request.operation === "delete" || request.source.status !== "active" || extraction.sourceId !== request.source.id ||
      extraction.versionId !== request.source.currentVersionId || extraction.cabinetId !== request.cabinetId ||
      extraction.roomPath !== request.roomPath || extraction.candidates.length > 64 || trusted.length > 64) throw new Error("Wiki linking requires current scoped candidates");
  const pages = request.pages.flatMap((page) => {
    const area = page.path.startsWith(`${request.wikiRoot}/entities/`) ? "entity" : page.path.startsWith(`${request.wikiRoot}/concepts/`) ? "concept" : null;
    if (!area) return [];
    relativePath(page.path);
    const markdown = page.markdown.replace(/\r\n/g, "\n");
    if (!markdown.startsWith("---\n")) return []; // No filename/heading inference.
    const end = markdown.indexOf("\n---\n", 4);
    if (end < 0 || end > 16_384) throw new Error("Invalid Wiki identity front matter");
    const metadata = record(yaml.load(markdown.slice(4, end), { schema: yaml.JSON_SCHEMA }));
    if (metadata.type !== area) return [];
    if (metadata.cabinet_id !== undefined && metadata.cabinet_id !== request.cabinetId) return [];
    if (metadata.room_path !== undefined && metadata.room_path !== request.roomPath) return [];
    if (metadata.status !== undefined && metadata.status !== "active") return [];
    const title = label(metadata.title);
    if (metadata.aliases !== undefined && (!Array.isArray(metadata.aliases) || metadata.aliases.length > 32)) throw new Error("Invalid Wiki aliases");
    const aliases = (metadata.aliases as unknown[] | undefined ?? []).map(label);
    const category = metadata.category === undefined ? null : label(metadata.category);
    return [{ path: page.path, sha256: page.sha256, title, area, category, names: new Set([title, ...aliases].map(normalize)) }];
  });
  const overrides = new Map<string, ExistingWikiTarget>();
  for (const match of trusted) {
    const candidate = extraction.candidates.find((item) => item.id === match.candidateId);
    if (!candidate || overrides.has(match.candidateId)) throw new Error("Unknown or duplicate trusted Wiki match");
    const area = candidate.kind === "entity" ? "entities" : "concepts";
    relativePath(match.path);
    const page = request.pages.find((item) => item.path === match.path && item.sha256 === match.sha256);
    if (!page || !match.path.startsWith(`${request.wikiRoot}/${area}/`)) throw new Error("Trusted Wiki match is outside the current read set");
    overrides.set(candidate.id, { path: page.path, sha256: page.sha256, title: pages.find((item) => item.path === page.path)?.title ?? candidate.name });
  }
  return extraction.candidates.map((candidate) => {
    const override = overrides.get(candidate.id);
    if (override) return { candidateId: candidate.id, status: "linked", targets: [override] };
    const matches = pages.filter((page) => page.area === candidate.kind && page.names.has(normalize(candidate.name)) &&
      (page.category === null || page.category === candidate.category));
    const targets = matches.map(({ path, sha256, title }) => ({ path, sha256, title })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { candidateId: candidate.id, status: matches.length === 0 ? "unmatched" : matches.length === 1 && matches[0].category !== null ? "linked" : "review", targets };
  });
}
