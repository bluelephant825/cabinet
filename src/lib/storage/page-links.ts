import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import {
  findWikiLinkOccurrences,
  slugifyPageName,
} from "@/lib/markdown/wiki-links";
import { normalizeVirtualPath } from "@/lib/virtual-paths";
import { resolveContentPath, virtualPathFromFs } from "./path-utils";
import { type PageRef, resolvePageBySlug, scanCabinet } from "./references";

export interface PageLink {
  path: string;
  title: string;
}

export interface PageLinks {
  incoming: PageLink[];
  outgoing: PageLink[];
}

interface ScannedPage {
  content: string;
  title: string;
}

function markdownFilePagePath(fsPath: string): string {
  const virtualPath = virtualPathFromFs(fsPath);
  return virtualPath.endsWith("/index.md")
    ? virtualPath.slice(0, -"/index.md".length)
    : virtualPath.replace(/\.md$/, "");
}

/**
 * Resolve a Markdown destination using the editor's exact, relative, then slug
 * lookup order. External URLs, fragments, and paths outside DATA_DIR are not
 * page links.
 */
export function resolveMarkdownPageLink(
  href: string,
  currentPagePath: string,
  pages: PageRef[]
): string | null {
  let linkPath = href.trim().replace(/^<|>$/g, "");
  if (!linkPath || linkPath.startsWith("#")) return null;
  if (/^[a-z][a-z\d+.-]*:/i.test(linkPath) || linkPath.startsWith("//")) {
    return null;
  }

  linkPath = linkPath.split(/[?#]/, 1)[0];
  try {
    linkPath = decodeURIComponent(linkPath);
  } catch {
    return null;
  }

  linkPath = linkPath.replace(/\\/g, "/");
  const rootRelative = linkPath.startsWith("/");
  linkPath = linkPath
    .replace(/^\/+/, "")
    .replace(/^\.\//, "")
    .replace(/\/index\.md$/i, "")
    .replace(/\.md$/i, "");

  if (!rootRelative && !linkPath.startsWith("../")) {
    const directMatch = pages.find((page) => page.path === linkPath);
    if (directMatch) return directMatch.path;
  }

  const parentDir = currentPagePath.includes("/")
    ? currentPagePath.substring(0, currentPagePath.lastIndexOf("/"))
    : "";
  const candidate = path.posix.normalize(
    rootRelative ? linkPath : path.posix.join(parentDir, linkPath)
  );
  if (
    !candidate ||
    candidate === "." ||
    candidate === ".." ||
    candidate.startsWith("../")
  ) {
    return null;
  }

  const exactMatch = pages.find((page) => page.path === candidate);
  if (exactMatch) return exactMatch.path;

  const slug = slugifyPageName(candidate.split("/").pop() ?? candidate);
  return slug ? resolvePageBySlug(slug, currentPagePath, pages) : null;
}

/** Extract de-duplicated internal links from wiki and standard Markdown links. */
export function extractOutgoingLinks(
  markdown: string,
  currentPagePath: string,
  pages: PageRef[]
): string[] {
  const outgoing = new Set<string>();

  for (const occurrence of findWikiLinkOccurrences(markdown)) {
    const slug = slugifyPageName(occurrence.inner);
    const resolved = slug
      ? resolvePageBySlug(slug, currentPagePath, pages)
      : null;
    if (resolved && resolved !== currentPagePath) outgoing.add(resolved);
  }

  // Exclude images. Optional quoted titles are accepted, while external and
  // unsafe destinations are rejected by resolveMarkdownPageLink.
  const markdownLink = /(^|[^!])\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+["'][^)]*["'])?\s*\)/gm;
  let match: RegExpExecArray | null;
  while ((match = markdownLink.exec(markdown)) !== null) {
    const resolved = resolveMarkdownPageLink(match[2], currentPagePath, pages);
    if (resolved && resolved !== currentPagePath) outgoing.add(resolved);
  }

  return [...outgoing];
}

/** Discover incoming and outgoing links for one path-safe cabinet page. */
export async function discoverPageLinks(requestedPath: string): Promise<PageLinks> {
  // Run the canonical storage boundary check before scanning or reading files.
  resolveContentPath(requestedPath);
  const pagePath = normalizeVirtualPath(requestedPath);
  if (!pagePath) throw new Error("Page not found");

  const { pages, markdownFiles } = await scanCabinet();
  const files = new Map<string, ScannedPage>();

  for (const fsPath of markdownFiles) {
    try {
      const raw = await fs.readFile(fsPath, "utf8");
      const parsed = matter(raw);
      const virtualPagePath = markdownFilePagePath(fsPath);
      const title =
        typeof parsed.data.title === "string" && parsed.data.title.trim()
          ? parsed.data.title.trim()
          : path.basename(fsPath, ".md");
      files.set(virtualPagePath, { content: parsed.content, title });
    } catch {
      // One unreadable page must not make link inspection unavailable.
    }
  }

  const current = files.get(pagePath);
  if (!current) throw new Error(`Page not found: ${pagePath}`);

  const outgoingPaths = extractOutgoingLinks(current.content, pagePath, pages);
  const incoming: PageLink[] = [];
  for (const [otherPath, otherPage] of files) {
    if (otherPath === pagePath) continue;
    if (extractOutgoingLinks(otherPage.content, otherPath, pages).includes(pagePath)) {
      incoming.push({ path: otherPath, title: otherPage.title });
    }
  }

  const outgoing = outgoingPaths.map((targetPath) => ({
    path: targetPath,
    title: files.get(targetPath)?.title ?? targetPath.split("/").pop() ?? targetPath,
  }));

  const byPath = (a: PageLink, b: PageLink) => a.path.localeCompare(b.path);
  return { incoming: incoming.sort(byPath), outgoing: outgoing.sort(byPath) };
}
