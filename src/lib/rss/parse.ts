import { parseFeed } from "feedsmith";
import { createHash } from "node:crypto";
import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import type { RssArticle } from "./types";
import { validateXml } from "./opml";

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => value && typeof value === "object" ? value as Obj : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const text = (value: unknown): string => typeof value === "string" ? value : typeof object(value).value === "string" ? String(object(value).value) : "";
export function publicLink(raw: string, base: string): string | null {
  try { const url = new URL(raw, base); return raw && url.toString().length <= 4000 && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.toString() : null; } catch { return null; }
}
export function articleMarkup(html: string, base: string) {
  const root = parseFragment(html.slice(0, 128000));
  function walk(node: DefaultTreeAdapterMap["childNode"] | DefaultTreeAdapterMap["documentFragment"]): string {
    if ("tagName" in node && ["script", "style", "iframe", "object", "form", "template"].includes(node.tagName)) return "";
    if ("value" in node) return node.value;
    if ("attrs" in node) node.attrs = node.attrs.filter((attr) => {
      if (attr.name !== "href") return true;
      const link = publicLink(attr.value, base);
      if (!link) return false;
      attr.value = link;
      return true;
    });
    return "childNodes" in node ? node.childNodes.map(walk).join(" ") : "";
  }
  const plain = walk(root).replace(/\s+/g, " ").trim();
  return { html: serialize(root), text: plain };
}
const date = (raw: unknown): string | null => { const value = text(raw); const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null; };
export function normalizeFeed(content: string, base: string, feedId: string, now = new Date().toISOString()) {
  validateXml(content);
  const parsed = parseFeed(content, { maxItems: 500 });
  const feed = object(parsed.feed);
  const format = parsed.format;
  const links = (value: unknown) => list(value).map(object).find((link) => !link.rel || link.rel === "alternate");
  const language = text(feed.language) || text(object(feed.xml).lang) || text(object(feed.dc).language) || null;
  const entries = list(format === "atom" ? feed.entries : feed.items);
  const unique = new Map<string, RssArticle>();
  entries.forEach((raw) => {
    const item = object(raw);
    const url = publicLink(text(item.link) || text(links(item.links)?.href) || text(item.url) || text(item.external_url), base);
    const markup = articleMarkup(text(object(item.content).encoded) || text(item.content) || text(item.content_html) || text(item.description) || text(item.summary), url || base);
    const plain = text(item.content_text) || markup.text;
    const title = articleMarkup(text(item.title), base).text || "Untitled article";
    const authors = (list(item.authors).length ? list(item.authors) : list(feed.authors)).map((author) => (text(object(author).name) || text(author)).slice(0, 500)).filter(Boolean).slice(0, 50);
    const creator = text(object(item.dc).creator);
    if (!authors.length && creator) authors.push(creator.slice(0, 500));
    const categories = [...list(item.categories).map((category) => text(object(category).name) || text(object(category).term) || text(category)), ...list(item.tags).map(text)].filter(Boolean).slice(0, 50).map((category) => category.slice(0, 500));
    const identity = text(item.id) || text(object(item.guid).value) || text(item.guid) || url || `${title}\n${plain}`;
    const id = createHash("sha256").update(`${feedId}\n${identity}`).digest("hex").slice(0, 32);
    unique.set(id, { id, feedId, title: title.slice(0, 1000), url, html: markup.html, text: plain.slice(0, 128000), authors, categories, language: (text(item.language) || text(object(item.xml).lang) || language)?.slice(0, 100) || null, publishedAt: date(item.pubDate || item.published || item.date_published || item.updated || object(item.dc).date), firstSeenAt: now, read: false });
  });
  return { name: articleMarkup(text(feed.title), base).text, format, articles: [...unique.values()] };
}
