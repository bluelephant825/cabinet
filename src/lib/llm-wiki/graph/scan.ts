import path from "node:path";
import { findWikiLinkOccurrences, slugifyPageName } from "../../markdown/wiki-links";
import { readWikiFrontmatter } from "../wiki-index";
import type { WikiProvenance } from "../wiki-provenance";
import { slugify } from "../wiki-index";
import type { GraphEdge, GraphEvidence, GraphNode, PageKind } from "./types";
import { pageKinds } from "./types";

export interface ScanPage { path: string; markdown: string; markdownHash: string; provenance?: WikiProvenance | null }
export interface ScanSource { id: string; title: string; rawPath: string; status: string; currentVersionId: string | null }
export interface ScanInput { wikiRoot: string; cabinetId: string; pages: ScanPage[]; sources: ScanSource[] }
export interface ScanResult { nodes: GraphNode[]; edges: GraphEdge[]; warnings: string[]; unresolvedLinks: number }

const SKIPPED_ROOT_FILES = new Set(["index.md", "log.md", "SCHEMA.md", "graph.json"]);
const CLAIM_KINDS = new Set(["claim", "relationship", "qualification"]);
const areaKind: Record<string, PageKind> = { sources: "source-summary", entities: "entity", concepts: "concept", comparisons: "comparison", synthesis: "synthesis" };

/** First plain paragraph after the H1: skip headings, tables, lists, quotes. */
function firstParagraph(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let sawH1 = false;
  const collected: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!sawH1) { if (/^#\s+/.test(trimmed)) sawH1 = true; continue; }
    if (!collected.length) {
      if (!trimmed || /^#{1,6}\s/.test(trimmed) || trimmed.startsWith("|") || trimmed.startsWith("-") ||
          trimmed.startsWith("*") || /^\d+[.)]\s/.test(trimmed) || trimmed.startsWith(">")) continue;
    }
    if (collected.length && (!trimmed || /^#{1,6}\s/.test(trimmed) || trimmed.startsWith("|"))) break;
    if (trimmed) collected.push(trimmed);
  }
  const text = collected.join(" ").replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, "$2").replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`]/g, "").trim();
  return text.length > 400 ? `${text.slice(0, 397)}...` : text;
}

function firstHeading(markdown: string): string | null {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return match ? match[1].trim() : null;
}

/** Human-readable topic label: "global-overshoot" -> "Global overshoot". */
function topicLabel(raw: string): string {
  const label = raw.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : raw;
}

/** Deterministic scan of wiki pages, sources and provenance into graph nodes
 * and explicit edges. Pure: all inputs are supplied by the caller. */
export function scanWikiGraph(input: ScanInput): ScanResult {
  const warnings: string[] = [];
  const nodes = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();
  let unresolvedLinks = 0;
  const prefix = `${input.wikiRoot}/`;

  const pages = input.pages
    .filter((page) => page.path.endsWith(".md") && page.path.startsWith(prefix))
    .filter((page) => {
      const rest = page.path.slice(prefix.length);
      return rest.includes("/") || !SKIPPED_ROOT_FILES.has(rest);
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  // Resolution indexes for [[wikilinks]]: exact relative stem, stem basename,
  // and slugified stem (all case-insensitive for the last two).
  const byStem = new Map<string, string[]>();      // full "dir/name" -> page paths
  const byBase = new Map<string, string[]>();      // basename stem -> page paths
  const bySlug = new Map<string, string[]>();      // slugifyPageName(basename) -> page paths
  const stemOf = (page: ScanPage) => page.path.slice(prefix.length, -".md".length);
  for (const page of pages) {
    const stem = stemOf(page);
    const base = path.posix.basename(stem);
    for (const [map, key] of [[byStem, stem.toLowerCase()], [byBase, base.toLowerCase()], [bySlug, slugifyPageName(base)]] as const) {
      map.set(key, [...(map.get(key) ?? []), page.path]);
    }
  }

  const pageId = (page: ScanPage) => `page:${stemOf(page)}`;
  const addEdge = (edge: GraphEdge) => {
    const key = `${edge.source}	${edge.target}	${edge.type}`;
    if (!edgeMap.has(key)) edgeMap.set(key, edge);
  };
  const topic = (id: string, name: string) => {
    if (!nodes.has(id)) nodes.set(id, { id, type: "topic", name, summary: "", tags: [] });
    return id;
  };

  const sourceIds = new Map(input.sources.map((source) => [source.id, source]));
  for (const source of input.sources) {
    nodes.set(`source:${source.id}`, {
      id: `source:${source.id}`, type: "source", name: source.title,
      summary: `Raw source (${source.status})`, tags: [], pagePath: source.rawPath,
    });
  }

  const resolveWikiLink = (target: string): string | null | "ambiguous" => {
    const cleaned = target.replace(/\.md$/i, "").replace(/^\.\//, "").replace(/^\//, "");
    const lower = cleaned.toLowerCase();
    const exact = byStem.get(lower);
    if (exact?.length) return exact[0];
    const base = path.posix.basename(lower);
    const stem = byBase.get(base);
    if (stem?.length === 1) return stem[0];
    if (stem && stem.length > 1) return "ambiguous";
    const slugged = bySlug.get(slugifyPageName(base));
    if (slugged?.length === 1) return slugged[0];
    if (slugged && slugged.length > 1) return "ambiguous";
    return null;
  };

  const pageByPath = new Map(pages.map((page) => [page.path, page]));
  const conceptTable = pages.find((page) => page.path === `${input.wikiRoot}/concept-table.md`);

  const pageName = (page: ScanPage, meta: ReturnType<typeof readWikiFrontmatter>, stem: string) =>
    (typeof meta?.title === "string" && meta.title.trim()) || firstHeading(page.markdown) || path.posix.basename(stem);

  // Page names and file stems by slug: a tag or classification label that is
  // really a page (e.g. tag "global-overshoot" on a wiki with a "Global
  // Overshoot" page) categorizes under that page instead of a duplicate topic.
  const pageNameSlugs = new Map<string, string>();
  for (const page of pages) {
    const stem = stemOf(page);
    const meta = readWikiFrontmatter(page.markdown);
    for (const key of [slugify(pageName(page, meta, stem)), slugify(path.posix.basename(stem))]) {
      if (key && !pageNameSlugs.has(key)) pageNameSlugs.set(key, pageId(page));
    }
  }

  for (const page of pages) {
    const meta = readWikiFrontmatter(page.markdown) ?? {};
    const stem = stemOf(page);
    const rest = stem.split("/");
    const id = pageId(page);
    const kind = (pageKinds as string[]).includes(meta.type as string) ? meta.type as PageKind
      : areaKind[rest[0]] ?? "concept";
    const tags = Array.isArray(meta.tags) ? meta.tags.filter((item): item is string => typeof item === "string").slice(0, 32) : [];
    nodes.set(id, {
      id, type: "page", name: pageName(page, meta, stem),
      summary: firstParagraph(page.markdown), tags, pagePath: page.path, pageKind: kind,
      ...(typeof meta.category === "string" && meta.category ? { category: meta.category }
        : typeof meta.subtype === "string" && meta.subtype ? { category: meta.subtype } : {}),
    });

    // [[wikilinks]] and relative markdown links to pages inside the wiki.
    const linkTargets = new Set<string>();
    const unresolved = (label: string) => {
      unresolvedLinks++;
      warnings.push(`Unresolved wikilink "${label}" in ${page.path}`);
    };
    for (const occurrence of findWikiLinkOccurrences(page.markdown)) {
      const target = occurrence.inner.split("|")[0].trim();
      if (!target) continue;
      const found = resolveWikiLink(target);
      if (found === "ambiguous" || found === null) { unresolved(target); continue; }
      linkTargets.add(found);
    }
    const dir = path.posix.dirname(page.path);
    for (const match of page.markdown.matchAll(/\[[^\]]*\]\(([^)\s]+\.md)\)/g)) {
      let href: string;
      try { href = decodeURIComponent(match[1]); } catch { continue; }
      if (/^[a-z]+:/i.test(href) || href.startsWith("#")) continue;
      const resolved = path.posix.normalize(path.posix.join(dir, href));
      if (resolved !== input.wikiRoot && !resolved.startsWith(prefix)) continue;
      if (pageByPath.has(resolved)) linkTargets.add(resolved);
      else if (!SKIPPED_ROOT_FILES.has(resolved.slice(prefix.length))) { unresolved(match[1]); }
    }
    for (const target of linkTargets) {
      if (target === page.path) continue;
      addEdge({ source: id, target: pageId(pageByPath.get(target)!), type: "links_to",
        direction: "forward", provenance: "explicit", extractor: "wikilink", confidence: 1 });
    }

    // Frontmatter citations.
    const cited = Array.isArray(meta.sources) ? meta.sources.filter((item): item is string => typeof item === "string") : [];
    for (const slug of cited) {
      const target = pages.find((item) => stemOf(item) === `sources/${slug}`);
      if (target) addEdge({ source: id, target: pageId(target), type: "cites",
        direction: "forward", provenance: "explicit", extractor: "frontmatter", confidence: 1 });
      else warnings.push(`Unresolved frontmatter source "${slug}" in ${page.path}`);
    }
    if (kind === "source-summary" && typeof meta.source_id === "string" && meta.source_id) {
      const source = sourceIds.get(meta.source_id);
      if (source) addEdge({ source: id, target: `source:${source.id}`, type: "cites",
        direction: "forward", provenance: "explicit", extractor: "source-manifest", confidence: 1 });
      else warnings.push(`Unresolved source_id "${meta.source_id}" in ${page.path}`);
    }

    // Tags and entity classification -> topic nodes.
    const topicSlugs = new Map<string, string>();
    for (const tag of tags) { const slug = slugify(tag); if (slug && !topicSlugs.has(slug)) topicSlugs.set(slug, tag); }
    if (kind === "entity") {
      for (const label of [meta.subtype, meta.category]) {
        if (typeof label === "string" && label.trim()) { const slug = slugify(label); if (slug && !topicSlugs.has(slug)) topicSlugs.set(slug, label); }
      }
    }
    for (const [slug, label] of topicSlugs) {
      const target = pageNameSlugs.get(slug) ?? topic(`topic:${slug}`, topicLabel(label));
      if (target === id) continue;
      addEdge({ source: id, target, type: "categorized_under",
        direction: "forward", provenance: "explicit", extractor: "frontmatter", confidence: 1 });
    }

    // Provenance knowledge -> claim nodes with evidence-carrying supports.
    const knowledge = page.provenance?.knowledge ?? [];
    for (const item of knowledge.slice(0, 256)) {
      if (!CLAIM_KINDS.has(item.kind)) continue;
      const claimId = `claim:${item.id}`;
      if (!nodes.has(claimId)) nodes.set(claimId, {
        id: claimId, type: "claim",
        name: item.text.length > 120 ? `${item.text.slice(0, 117)}...` : item.text,
        summary: item.text, tags: [], pagePath: page.path,
      });
      addEdge({ source: id, target: claimId, type: "asserts",
        direction: "forward", provenance: "explicit", extractor: "provenance", confidence: 1 });
      const evidence: GraphEvidence[] = [];
      const targets: string[] = [];
      for (const support of item.supports) {
        if (!sourceIds.has(support.sourceId)) continue;
        targets.push(`source:${support.sourceId}`);
        evidence.push({ sourceId: support.sourceId, versionId: support.versionId, quote: support.quote, start: support.start, end: support.end });
      }
      for (const target of targets) {
        addEdge({ source: claimId, target, type: "supported_by",
          direction: "forward", provenance: "explicit", extractor: "provenance", confidence: 1,
          evidence: evidence.filter((entry) => `source:${entry.sourceId}` === target) });
      }
    }
  }

  // Concept-table clusters -> part_of edges.
  if (conceptTable) {
    const lines = conceptTable.markdown.replace(/\r\n/g, "\n").split("\n");
    let inCluster = false;
    for (const line of lines) {
      const heading = /^#{1,6}\s+(.+)$/.exec(line.trim());
      if (heading) { inCluster = /cluster/i.test(heading[1]); continue; }
      const trimmed = line.trim();
      if (!trimmed.startsWith("|")) { if (trimmed) inCluster = inCluster; continue; }
      if (!inCluster) continue;
      const cells = trimmed.split("|").slice(1, -1).map((cell) => cell.trim());
      if (cells.length < 2 || !cells[0] || /^-+$/.test(cells[0]) || /^cluster$/i.test(cells[0])) continue;
      const clusterId = topic(`topic:cluster-${slugify(cells[0])}`, cells[0]);
      for (const item of cells[1].split(",")) {
        const text = item.trim();
        if (!text) continue;
        const wikilink = /^\[\[([^\]|]+)(?:\|[^\]]+)?\]\]$/.exec(text);
        const mdlink = /^\[[^\]]*\]\(([^)\s]+)\)$/.exec(text);
        let label = text;
        let resolved: string | null | "ambiguous" = null;
        if (wikilink) { label = wikilink[1].trim(); resolved = resolveWikiLink(label); }
        else if (mdlink) {
          try { resolved = path.posix.normalize(path.posix.join(input.wikiRoot, decodeURIComponent(mdlink[1]))); } catch { resolved = null; }
          if (resolved && !pageByPath.has(resolved)) resolved = null;
        }
        else resolved = resolveWikiLink(text);
        if (resolved === "ambiguous" || resolved === null) {
          warnings.push(`Unresolved cluster member "${label}" in ${conceptTable.path}`);
          unresolvedLinks++;
          continue;
        }
        addEdge({ source: pageId(pageByPath.get(resolved)!), target: clusterId, type: "part_of",
          direction: "forward", provenance: "explicit", extractor: "concept-table", confidence: 1 });
      }
    }
  }

  const edges = [...edgeMap.values()];
  for (const edge of edges) {
    const source = nodes.get(edge.source), target = nodes.get(edge.target);
    if (source) source.degree = (source.degree ?? 0) + 1;
    if (target) target.degree = (target.degree ?? 0) + 1;
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges: edges.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.type.localeCompare(b.type)),
    warnings, unresolvedLinks,
  };
}
