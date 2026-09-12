import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, RootContent } from "mdast";
import { contains, ownedPath, relativePath } from "./filesystem";
import { SourceNormalizationService } from "./normalizers";
import { normalizeMarkdown } from "./normalizers/markdown";
import { textHash } from "./wiki-publication";
import type { CapturedAsset, NormalizationWarning } from "./normalizers/types";

async function stableRead(root: string, relative: string, limit: number) {
  const target = await ownedPath(root, relative);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > limit) throw new Error("Invalid or oversized source file");
    const bytes = await handle.readFile();
    const after = await handle.stat(), named = await fs.stat(await ownedPath(root, relative));
    if (bytes.length !== before.size || [after, named].some((stat) => stat.ino !== before.ino || stat.size !== before.size || stat.mtimeMs !== before.mtimeMs || stat.ctimeMs !== before.ctimeMs)) throw new Error("Source changed during capture; retry after saving");
    return bytes;
  } finally { await handle.close(); }
}

/** Dependency reads stay inside the explicitly selected folder; no symlink,
 * external URL, hidden file or recursive note embed is followed. */
export async function captureNote(root: string, relative: string, folder: string) {
  relativePath(relative); relativePath(folder);
  if (!contains(folder, relative) || !/\.(md|markdown)$/i.test(relative)) throw new Error("Note is outside the selected Markdown folder");
  const bytes = await stableRead(root, relative, 2 * 1024 * 1024);
  const original = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const warnings: NormalizationWarning[] = [];
  const assets: CapturedAsset[] = [];
  const urls = new Set<string>();
  // Obsidian embeds of images with explicit paths can be safely normalized.
  const text = original.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (whole, embed: string, raw: string) => {
    const [destination, alias] = raw.split("|");
    if (embed && /\.(png|jpe?g|gif|webp|avif)$/i.test(destination)) return `![${(alias ?? "").replace(/[\[\]]/g, "")}](${encodeURI(destination).replace(/[()]/g, (c) => c === "(" ? "%28" : "%29")})`;
    warnings.push({ code: embed ? "unsupported-embed" : "external-reference", message: embed ? `Note embed retained without recursive expansion: ${destination}` : `Obsidian link retained as text: ${destination}` });
    return whole;
  });
  const tree = unified().use(remarkParse).parse(text);
  const walk = (node: Root | RootContent) => {
    if ("url" in node && ["image", "link", "definition"].includes(node.type)) urls.add(node.url);
    if ("children" in node) for (const child of node.children) walk(child as RootContent);
  };
  walk(tree);
  let total = 0;
  for (const url of urls) {
    if (/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(url)) continue;
    try {
      const dependency = path.posix.normalize(path.posix.join(path.posix.dirname(relative), decodeURIComponent(url.split(/[?#]/)[0])));
      relativePath(dependency);
      if (!contains(folder, dependency) || dependency.split("/").some((part) => part.startsWith("."))) throw new Error("Reference is outside the selected folder");
      if (/\.(md|markdown)$/i.test(dependency)) continue;
      if (assets.some((item) => item.path === dependency)) continue;
      if (assets.length >= 128) throw new Error("Too many attachments");
      const captured = await stableRead(root, dependency, 20 * 1024 * 1024);
      total += captured.length;
      if (total > 50 * 1024 * 1024) throw new Error("Attachments exceed 50 MB");
      assets.push({ path: dependency, bytes: captured });
    } catch (error) { warnings.push({ code: "unresolved-asset", message: `${url}: ${error instanceof Error ? error.message : String(error)}` }); }
  }
  const contentHash = textHash(bytes);
  const normalized = await new SourceNormalizationService().normalize({ path: relative, bytes, contentHash, assets });
  const rendered = normalizeMarkdown(text, relative, assets);
  return { normalized: { ...normalized, ...rendered, warnings: [...rendered.warnings, ...warnings] }, contentHash,
    fingerprint: textHash(JSON.stringify([contentHash, assets.map((item) => [item.path, textHash(item.bytes)]), warnings])) };
}
