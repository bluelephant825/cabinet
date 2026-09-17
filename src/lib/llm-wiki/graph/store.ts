import fs from "node:fs/promises";
import { ownedPath, statOrNull } from "../filesystem";
import { durableText } from "../wiki-publication";
import { parseWikiGraph } from "./schema";
import { WIKI_GRAPH_FILE, type WikiGraph } from "./types";

const MAX_GRAPH_BYTES = 64 * 1024 * 1024;

export function graphPath(wikiRoot: string): string {
  return `${wikiRoot}/${WIKI_GRAPH_FILE}`;
}

export async function writeWikiGraph(root: string, wikiRoot: string, graph: WikiGraph): Promise<void> {
  await durableText(root, graphPath(wikiRoot), JSON.stringify(graph, null, 2) + "\n");
}

export async function readWikiGraph(root: string, wikiRoot: string): Promise<WikiGraph | null> {
  const target = await ownedPath(root, graphPath(wikiRoot));
  if (!await statOrNull(target)) return null;
  const text = await fs.readFile(target, "utf8");
  if (Buffer.byteLength(text) > MAX_GRAPH_BYTES) throw new Error("Wiki graph exceeds size limit");
  return parseWikiGraph(JSON.parse(text));
}

const headerCache = new Map<string, Pick<WikiGraph, "generatedAt" | "jobId" | "stats" | "warnings">>();

/** Header fields for status surfaces; cached per file mtime/size since the
 * settings UI polls status() frequently and the file can be several MB. */
export async function readWikiGraphHeader(root: string, wikiRoot: string):
  Promise<Pick<WikiGraph, "generatedAt" | "jobId" | "stats" | "warnings"> | null> {
  const target = await ownedPath(root, graphPath(wikiRoot));
  const stat = await statOrNull(target);
  if (!stat) return null;
  const key = `${target}:${stat.mtimeMs}:${stat.size}`;
  const cached = headerCache.get(key);
  if (cached) return cached;
  const graph = await readWikiGraph(root, wikiRoot);
  if (!graph) return null;
  const header = { generatedAt: graph.generatedAt, jobId: graph.jobId, stats: graph.stats, warnings: graph.warnings };
  if (headerCache.size >= 8) headerCache.delete(headerCache.keys().next().value!);
  headerCache.set(key, header);
  return header;
}
