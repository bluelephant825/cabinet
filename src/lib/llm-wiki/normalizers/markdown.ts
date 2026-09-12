import path from "node:path";
import { createHash } from "node:crypto";
import yaml from "js-yaml";
import { unified } from "unified";
import remarkParse from "remark-parse";
import type { Root, RootContent } from "mdast";
import { relativePath } from "../filesystem";
import type { CapturedAsset, NormalizedAsset, NormalizationWarning } from "./types";

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const MAX_MARKDOWN_BYTES = 20 * 1024 * 1024;

/** JSON-compatible, bounded metadata; reject YAML cycles and executable tags. */
export function validateMetadata(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Metadata must be a mapping");
  let count = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++count > 10000 || depth > 30) throw new Error("Metadata exceeds normalization limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error("Invalid or cyclic metadata");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) {
      throw new Error("Metadata must contain plain values");
    }
    ancestors.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    ancestors.delete(item);
  };
  visit(value, 0);
}

export function copyAssets(assets: readonly CapturedAsset[]): CapturedAsset[] {
  if (!Array.isArray(assets) || assets.length > 256) throw new Error("Too many captured assets (maximum 256)");
  let total = 0;
  const names = new Set<string>();
  return assets.map((asset) => {
    const name = relativePath(asset.path);
    const key = name.normalize("NFC").toLowerCase();
    if (names.has(key)) throw new Error("Duplicate or ambiguous captured asset path");
    names.add(key);
    if (!(asset.bytes instanceof Uint8Array)) throw new Error("Asset bytes are required");
    total += asset.bytes.byteLength;
    if (asset.bytes.byteLength > 50 * 1024 * 1024 || total > 100 * 1024 * 1024) throw new Error("Captured assets exceed size limits");
    return { path: name, bytes: Uint8Array.from(asset.bytes) };
  });
}

/** Locate a parsed link's destination without reserializing prose or code.
 * Candidate destinations must consume the node's remainder including its title.
 * Ambiguous syntax stays unchanged with a warning rather than corrupting text.
 */
function destinationRanges(raw: string, type: string): [number, number][] {
  const prefix = type === "definition" ? /^\[[\s\S]*?\]:[ \t\n]*/ : /\]\([ \t\n]*/g;
  const matches = [...raw.matchAll(type === "definition" ? new RegExp(prefix.source, "g") : prefix)];
  const ranges: [number, number][] = [];
  for (const match of matches.reverse()) {
    const start = match.index! + match[0].length;
    const angle = raw[start] === "<";
    let cursor = start + (angle ? 1 : 0);
    let depth = 0;
    for (; cursor < raw.length; cursor++) {
      const char = raw[cursor];
      if (char === "\\") { cursor++; continue; }
      if (angle ? char === ">" : /\s/.test(char) || (char === ")" && depth === 0)) break;
      if (!angle && char === "(") depth++;
      if (!angle && char === ")") depth--;
    }
    if (angle && raw[cursor] !== ">") continue;
    const tail = raw.slice(cursor + (angle ? 1 : 0));
    const ending = type === "definition" ? /^[ \t\n]*(?:(?:"[\s\S]*"|'[\s\S]*'|\([\s\S]*\))[ \t\n]*)?$/
      : /^[ \t\n]*(?:(?:"[\s\S]*"|'[\s\S]*'|\([\s\S]*\))[ \t\n]*)?\)$/;
    if (ending.test(tail)) ranges.push([start + (angle ? 1 : 0), cursor]);
  }
  return ranges;
}

// Asset edits must change only a parsed destination, including for labels or
// titles that themselves contain link-like syntax. Compare structure without
// source positions before accepting a surgical text edit.
function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "position").map(([key, item]) => [key, shape(item)]));
  return value;
}

const parser = unified().use(remarkParse);

function sameNode(raw: string, expected: RootContent): boolean {
  const root = parser.parse(raw);
  if (root.children.length !== 1) return false;
  const first = root.children[0];
  const actual = first.type === "paragraph" && first.children.length === 1 ? first.children[0] : first;
  return JSON.stringify(shape(actual)) === JSON.stringify(shape(expected));
}

export function normalizeMarkdown(text: string, sourcePath: string, captured: readonly CapturedAsset[], parseFrontMatter = true) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_MARKDOWN_BYTES) throw new Error("Markdown exceeds the 20 MB limit");
  let markdown = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let prefix = "";
  let metadata: Record<string, unknown> = {};
  if (parseFrontMatter && markdown.startsWith("---\n")) {
    const end = /^---\n([\s\S]*?)^(?:---|\.\.\.)[ \t]*(?:\n|$)/m.exec(markdown);
    if (!end) throw new Error("Unclosed YAML front matter");
    if (end[1].length > 1024 * 1024) throw new Error("Front matter exceeds the 1 MB limit");
    const parsed = yaml.load(end[1], { schema: yaml.JSON_SCHEMA });
    metadata = parsed == null ? {} : parsed as Record<string, unknown>;
    validateMetadata(metadata);
    prefix = end[0]; markdown = markdown.slice(prefix.length);
  }
  const assets = new Map<string, NormalizedAsset>();
  const mapping = new Map<string, string>();
  for (const asset of captured) {
    const contentHash = sha256(asset.bytes);
    const extension = path.posix.extname(asset.path).slice(1).toLowerCase();
    const target = `assets/${contentHash}.${/^[a-z0-9]{1,16}$/.test(extension) ? extension : "bin"}`;
    mapping.set(asset.path, target);
    assets.set(target, { path: target, contentHash, bytes: asset.bytes });
  }
  const warnings: NormalizationWarning[] = [];
  const warningKeys = new Set<string>();
  const warn = (code: NormalizationWarning["code"], message: string) => {
    if (!warningKeys.has(message)) { warnings.push({ code, message }); warningKeys.add(message); }
  };
  const edits: { start: number; end: number; text: string }[] = [];
  const visit = (node: Root | RootContent): void => {
    if (node.type === "html") warn("unsupported-embed", "Raw HTML is preserved as inert source; its asset references are not rewritten.");
    if (node.type === "text" && /!\[\[/.test(node.value)) warn("unsupported-embed", "Wiki embeds are preserved; their asset references require later vault-aware resolution.");
    if (node.type === "link" || node.type === "image" || node.type === "definition") {
      const url = node.url;
      if (url && !url.startsWith("#")) {
        let target: string | undefined;
        const boundary = url.search(/[?#]/);
        const bare = boundary < 0 ? url : url.slice(0, boundary);
        const suffix = boundary < 0 ? "" : url.slice(boundary);
        try {
          const decoded = decodeURIComponent(bare);
          if (/^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith("/") || decoded.includes("\\")) {
            warn("external-reference", `Reference preserved without fetching: ${url}`);
          } else {
            const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), decoded));
            relativePath(resolved);
            target = mapping.get(resolved);
            if (!target) warn("unresolved-asset", `No captured asset for reference: ${url}`);
          }
        } catch { warn("unresolved-asset", `Reference is outside the capture or malformed: ${url}`); }
        if (target) {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          const raw = start !== undefined && end !== undefined ? markdown.slice(start, end) : "";
          const replacement = target + suffix;
          const range = destinationRanges(raw, node.type).find(([from, to]) =>
            sameNode(raw.slice(0, from) + replacement + raw.slice(to), { ...node, url: replacement }));
          if (range && start !== undefined) edits.push({ start: start + range[0], end: start + range[1], text: replacement });
          else warn("unresolved-asset", `Could not safely rewrite reference: ${url}`);
        }
      }
    }
    if ("children" in node) for (const child of node.children) visit(child as RootContent);
  };
  visit(parser.parse(markdown));
  const pieces = [prefix];
  let cursor = 0;
  let outputBytes = Buffer.byteLength(prefix + markdown);
  for (const edit of edits.sort((a, b) => a.start - b.start)) {
    if (edit.start < cursor) throw new Error("Overlapping asset references");
    outputBytes += Buffer.byteLength(edit.text) - Buffer.byteLength(markdown.slice(edit.start, edit.end));
    if (outputBytes > MAX_MARKDOWN_BYTES) throw new Error("Normalized Markdown exceeds the 20 MB limit");
    pieces.push(markdown.slice(cursor, edit.start), edit.text);
    cursor = edit.end;
  }
  pieces.push(markdown.slice(cursor));
  return { markdown: pieces.join(""), body: pieces.slice(1).join(""), metadata,
    assets: [...assets.values()].sort((a, b) => a.path.localeCompare(b.path)), warnings };
}
