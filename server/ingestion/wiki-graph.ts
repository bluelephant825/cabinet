import fs from "node:fs/promises";
import path from "node:path";
import { readWikiCabinet, WIKI_STATE_PATH } from "../../src/lib/llm-wiki/config";
import { ownedPath } from "../../src/lib/llm-wiki/filesystem";
import { SourceStore } from "../../src/lib/llm-wiki/source-store";
import { durableText, readWikiInventory, textHash } from "../../src/lib/llm-wiki/wiki-publication";
import { commitWikiPublication } from "../../src/lib/history/engine";
import { mergeWikiGraph } from "../../src/lib/llm-wiki/graph/merge";
import { scanWikiGraph, type ScanPage, type ScanResult, type ScanSource } from "../../src/lib/llm-wiki/graph/scan";
import { graphPath, writeWikiGraph } from "../../src/lib/llm-wiki/graph/store";
import type { WikiGraphStats } from "../../src/lib/llm-wiki/graph/types";
import { analyzeWikiBatch, GRAPH_PROMPT_VERSION, type AnalysisRecord, type GraphAnalysisModel } from "../../src/lib/llm-wiki/graph/analyze";
import { walkWikiFiles } from "./wiki-files";

const MAX_PAGE_BYTES = 1024 * 1024;
const BATCH_SIZE = 10;
const BATCH_CONCURRENCY = 3;
const analysisDir = `${WIKI_STATE_PATH}/graph/analysis`;

export interface GraphRefreshResult {
  path: string | null;
  warnings: string[];
  stats: WikiGraphStats | null;
  analyzed: number;
  cached: number;
  failedBatches: number;
}
export interface GraphAnalyzeOption { model: GraphAnalysisModel; modelName: string; signal: AbortSignal }

export class WikiGraphBuilder {
  constructor(private readonly root: string) {}

  /** Rebuild the deterministic graph, optionally merging cached LLM analysis.
   * Never throws: returns warnings; a failed build leaves any prior graph.json untouched. */
  async refresh(jobId: string, options?: { analyze?: GraphAnalyzeOption }): Promise<GraphRefreshResult> {
    const empty = { analyzed: 0, cached: 0, failedBatches: 0 };
    try {
      const cabinet = await readWikiCabinet(this.root);
      if (!cabinet?.config.enabled) return { path: null, warnings: [], stats: null, ...empty };
      const wikiRoot = cabinet.config.paths.wiki;
      const warnings: string[] = [];

      const files = await walkWikiFiles(this.root, wikiRoot);
      const pages: ScanPage[] = [];
      for (const relative of files.filter((file) => file.endsWith(".md"))) {
        const target = await ownedPath(this.root, relative);
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink()) { warnings.push(`Skipped symlinked Wiki page: ${relative}`); continue; }
        if (stat.size > MAX_PAGE_BYTES) { warnings.push(`Skipped Wiki page over 1 MB: ${relative}`); continue; }
        const markdown = await fs.readFile(target, "utf8");
        pages.push({ path: relative, markdown, markdownHash: textHash(markdown) });
      }

      const inventory = await readWikiInventory(this.root);
      const provenance = new Map(inventory.map((entry) => [entry.provenance.pagePath, entry.provenance]));
      for (const page of pages) page.provenance = provenance.get(page.path) ?? null;

      const sources: ScanSource[] = (await new SourceStore(this.root).list()).map(({ source }) => ({
        id: source.id, title: source.title, rawPath: source.rawPath,
        status: source.status, currentVersionId: source.currentVersionId,
      }));

      const inventoryFingerprint = textHash(
        inventory.map((entry) => `${entry.provenance.pagePath}:${entry.markdownHash}`).sort().join("\n"));

      const explicit = scanWikiGraph({ wikiRoot, cabinetId: cabinet.cabinetId, pages, sources });
      const pageNodes = new Map(explicit.nodes.filter((node) => node.type === "page" && node.pagePath).map((node) => [node.pagePath!, node]));
      const analyzedPages = pages.filter((page) => pageNodes.has(page.path));

      // Analysis cache: one record per page keyed by content hash. A record is
      // valid only for the page whose current hash it names; stale-hash files
      // are pruned.
      const pageByHash = new Map(analyzedPages.map((page) => [page.markdownHash, page]));
      const records: AnalysisRecord[] = [];
      const cachedPaths = new Set<string>();
      const cachePath = await ownedPath(this.root, analysisDir);
      let cacheFiles: string[] = [];
      try { cacheFiles = (await fs.readdir(cachePath)).filter((file) => file.endsWith(".json")); } catch { /* No cache yet. */ }
      for (const file of cacheFiles) {
        const target = path.join(cachePath, file);
        const hash = file.slice(0, -".json".length);
        const page = pageByHash.get(hash);
        if (!page) { await fs.rm(target, { force: true }); continue; }
        try {
          const record = JSON.parse(await fs.readFile(target, "utf8")) as AnalysisRecord;
          if (record?.schemaVersion !== 1 || record.promptVersion !== GRAPH_PROMPT_VERSION ||
              record.pagePath !== page.path || record.markdownHash !== hash ||
              !Array.isArray(record.nodes) || !Array.isArray(record.edges)) continue;
          records.push(record);
          cachedPaths.add(page.path);
        } catch { /* A corrupt cache file is ignored and overwritten later. */ }
      }

      let analyzed = 0, failedBatches = 0;
      if (options?.analyze) {
        const { model, modelName, signal } = options.analyze;
        // Batches of 10 pages, grouped by wiki area, sorted by path.
        const missing = analyzedPages.filter((page) => !cachedPaths.has(page.path));
        const byArea = new Map<string, ScanPage[]>();
        for (const page of missing) {
          const area = page.path.slice(wikiRoot.length + 1).split("/")[0];
          byArea.set(area, [...(byArea.get(area) ?? []), page]);
        }
        const batches: ScanPage[][] = [];
        for (const group of [...byArea.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, group]) => group)) {
          for (let index = 0; index < group.length; index += BATCH_SIZE) batches.push(group.slice(index, index + BATCH_SIZE));
        }
        const linksByPage = new Map<string, string[]>();
        for (const edge of explicit.edges) {
          if (edge.type !== "links_to") continue;
          linksByPage.set(edge.source, [...(linksByPage.get(edge.source) ?? []), edge.target]);
        }
        const areaIds = new Map<string, string[]>();
        for (const node of pageNodes.values()) {
          const area = node.pagePath!.slice(wikiRoot.length + 1).split("/")[0];
          areaIds.set(area, [...(areaIds.get(area) ?? []), node.id]);
        }
        const topDegree = explicit.nodes.filter((node) => (node.degree ?? 0) > 0)
          .sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0) || a.id.localeCompare(b.id))
          .slice(0, 200).map((node) => node.id);
        const entityIds = [...new Set(records.flatMap((record) => record.nodes.filter((node) => node.type === "entity").map((node) => node.id)))].slice(0, 400);
        const writeRecord = async (record: AnalysisRecord) =>
          durableText(this.root, `${analysisDir}/${record.markdownHash}.json`, JSON.stringify(record));

        let next = 0;
        const worker = async () => {
          while (next < batches.length && !signal.aborted) {
            const index = next++;
            const batch = batches[index];
            try {
              const area = batch[0].path.slice(wikiRoot.length + 1).split("/")[0];
              const existingIds = [...new Set([
                ...batch.map((page) => pageNodes.get(page.path)!.id),
                ...(areaIds.get(area) ?? []).slice(0, 400), ...topDegree, ...entityIds,
              ])];
              const result = await analyzeWikiBatch(
                batch.map((page) => ({ page, node: pageNodes.get(page.path)!, links: linksByPage.get(pageNodes.get(page.path)!.id) ?? [] })),
                existingIds, model, modelName, signal);
              for (const record of result.records) { await writeRecord(record); records.push(record); }
              analyzed += result.records.length;
            } catch (error) {
              if (signal.aborted) return;
              failedBatches++;
              const message = error instanceof Error ? error.message : String(error);
              warnings.push(`Graph analysis failed for batch ${index + 1} (${batch[0].path}): ${message}`);
            }
          }
        };
        await Promise.all(Array.from({ length: Math.min(BATCH_CONCURRENCY, batches.length) }, () => worker()));
      }

      const inferred: ScanResult = {
        nodes: records.flatMap((record) => record.nodes),
        edges: records.flatMap((record) => record.edges),
        warnings: [], unresolvedLinks: 0,
      };
      const graph = mergeWikiGraph({
        explicit, inferred: records.length ? [inferred] : [], wikiRoot, cabinetId: cabinet.cabinetId,
        jobId, inventoryFingerprint,
      });
      await writeWikiGraph(this.root, wikiRoot, graph);
      await commitWikiPublication(this.root, wikiRoot, [graphPath(wikiRoot)], jobId);
      return { path: graphPath(wikiRoot), warnings: [...warnings, ...graph.warnings], stats: graph.stats,
        analyzed, cached: cachedPaths.size, failedBatches };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { path: null, warnings: [`Knowledge graph rebuild failed: ${message}`], stats: null, ...empty };
    }
  }
}
