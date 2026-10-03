import { parseOpml, generateOpml, type Opml } from "feedsmith";
import { randomUUID } from "node:crypto";
import type { RssFeed } from "./types";
import { assertPublicHttpUrl } from "../net/ssrf-guard";

export function feedUrl(raw: string): string {
  const url = assertPublicHttpUrl(raw.trim());
  if (url.username || url.password) throw new Error("Feed URLs cannot contain credentials");
  url.hash = "";
  return url.toString();
}
export function validateXml(content: string, maxBytes = 5 * 1024 * 1024): void {
  if (Buffer.byteLength(content) > maxBytes) throw new Error("File is too large");
  if (/<!\s*(DOCTYPE|ENTITY)\b/i.test(content)) throw new Error("XML document types and entities are not supported");
}
export function importOpml(content: string, existing: RssFeed[]) {
  validateXml(content, 1024 * 1024);
  const tags = content.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, "").match(/<\/?outline\b[^>]*>/gi) || [];
  let depth = 0, countBeforeParse = 0;
  for (const tag of tags) {
    if (tag.startsWith("</")) depth--;
    else { countBeforeParse++; if (!/\/\s*>$/.test(tag)) depth++; }
    if (depth > 32 || countBeforeParse > 2000) throw new Error("OPML exceeds its outline depth or count limit");
  }
  const parsed = parseOpml(content);
  const seen = new Set(existing.map((feed) => feed.url));
  const added: RssFeed[] = [];
  let duplicates = 0, invalid = 0, count = 0;
  function walk(outlines: Opml.Outline<string>[], folders: string[], depth: number) {
    if (depth > 32) throw new Error("OPML folders are too deeply nested");
    for (const outline of outlines) {
      if (++count > 2000) throw new Error("OPML contains too many outlines");
      const name = (outline.title || outline.text || "Untitled feed").trim().slice(0, 200) || "Untitled feed";
      if (outline.xmlUrl) {
        try {
          const url = feedUrl(outline.xmlUrl);
          if (seen.has(url)) duplicates++;
          else { seen.add(url); added.push({ id: randomUUID(), url, name, folder: folders.join("/"), enabled: true, addedAt: new Date().toISOString() }); }
        } catch { invalid++; }
      }
      if (outline.outlines) walk(outline.outlines, outline.xmlUrl ? folders : [...folders, name], depth + 1);
    }
  }
  walk(parsed.body?.outlines ?? [], [], 0);
  if (added.length + existing.length > 500) throw new Error("A room can contain at most 500 feeds");
  return { added, duplicates, invalid };
}
export function exportOpml(feeds: RssFeed[]): string {
  const outlines: Opml.Outline<string>[] = [];
  for (const feed of feeds) {
    let group = outlines;
    for (const part of feed.folder.split("/").filter(Boolean)) {
      let folder = group.find((item) => !item.xmlUrl && item.text === part);
      if (!folder) { folder = { text: part, outlines: [] }; group.push(folder); }
      group = folder.outlines ?? (folder.outlines = []);
    }
    group.push({ text: feed.name, title: feed.name, type: "rss", xmlUrl: feed.url });
  }
  return generateOpml({ head: { title: "Cabinet RSS subscriptions" }, body: { outlines } });
}
