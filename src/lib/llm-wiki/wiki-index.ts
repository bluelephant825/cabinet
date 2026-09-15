import path from "node:path";
import yaml from "js-yaml";
import { record, relativePath } from "./filesystem";

/** Readable lowercase-hyphen slugs; deterministic and filesystem friendly. */
export function slugify(title: string): string {
  const slug = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-{2,}/g, "-")
    .slice(0, 80).replace(/-+$/g, "");
  return slug;
}

/** Source summary pages are always `sources/<slug>.md`; unreadable titles fall
 * back to a short identity suffix, as do collisions with foreign pages. */
export function sourcePageSlug(title: string, sourceId: string): string {
  return slugify(title) || `source-${sourceId.slice(0, 8)}`;
}

export interface WikiFrontmatter {
  title?: string;
  type?: string;
  created?: string;
  updated?: string;
  sources?: string[];
  tags?: string[];
  subtype?: string;
  category?: string;
  [key: string]: unknown;
}

/** Tolerant reader: returns null when frontmatter is absent or unparsable. */
export function readWikiFrontmatter(markdown: string): WikiFrontmatter | null {
  const normalized = markdown.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return null;
  const end = normalized.indexOf("\n---", 4);
  if (end < 0 || end > 16_384) return null;
  try {
    const data = record(yaml.load(normalized.slice(4, end), { schema: yaml.JSON_SCHEMA }));
    return data as WikiFrontmatter;
  } catch {
    return null;
  }
}

const cell = (value: unknown): string => {
  const text = typeof value === "string" ? value : "";
  return text.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").trim();
};
const list = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const link = (wikiRoot: string, page: string) =>
  `[${cell(path.posix.basename(page))}](${path.posix.relative(wikiRoot, page).split("/").map(encodeURIComponent).join("/")})`;

interface IndexedPage { path: string; meta: WikiFrontmatter }

/** Deterministic `index.md` renderer in the skill's catalog format. Only file
 * state and frontmatter feed it, so identical wikis render identically. */
export function renderWikiIndex(wikiRoot: string, pages: readonly IndexedPage[]): string {
  relativePath(wikiRoot);
  const sorted = [...pages].sort((a, b) => a.path.localeCompare(b.path));
  const inArea = (area: string, type: string) =>
    sorted.filter((page) => page.path.startsWith(`${wikiRoot}/${area}/`) && (page.meta.type ?? "") === type);
  const sources = inArea("sources", "source-summary");
  const entities = inArea("entities", "entity");
  const concepts = inArea("concepts", "concept");
  const comparisons = inArea("comparisons", "comparison");
  const synthesis = inArea("synthesis", "synthesis");
  const sourcesList = (page: IndexedPage) => list(page.meta.sources).map((name) => cell(name)).join(", ");
  const row = (...values: string[]) => `| ${values.join(" | ")} |`;
  return `# Index

> This file catalogs all pages in the wiki. The LLM reads this first when answering queries.
> Updated automatically on every wiki change.

## Core Maps

| File | Purpose |
| --- | --- |
| [overview.md](overview.md) | High-level synthesis of the whole wiki |
| [concept-table.md](concept-table.md) | Maintained concept map with definitions, relationships, sources, status, and maintenance notes |

## Sources

| File | Title | Date Added | Tags |
| --- | --- | --- | --- |
${sources.map((page) => row(link(wikiRoot, page.path), cell(page.meta.title), cell(page.meta.created), list(page.meta.tags).map(cell).join(", "))).join("\n")}

## Entities

| File | Name | Type | Sources |
| --- | --- | --- | --- |
${entities.map((page) => row(link(wikiRoot, page.path), cell(page.meta.title), cell(page.meta.subtype ?? page.meta.category), sourcesList(page))).join("\n")}

## Concepts

| File | Name | Sources |
| --- | --- | --- |
${concepts.map((page) => row(link(wikiRoot, page.path), cell(page.meta.title), sourcesList(page))).join("\n")}

## Comparisons

| File | Topic | Sources |
| --- | --- | --- |
${comparisons.map((page) => row(link(wikiRoot, page.path), cell(page.meta.title), sourcesList(page))).join("\n")}

## Synthesis

| File | Topic | Sources |
| --- | --- | --- |
${synthesis.map((page) => row(link(wikiRoot, page.path), cell(page.meta.title), sourcesList(page))).join("\n")}
`;
}
