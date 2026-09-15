import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ownedPath, statOrNull, withRootLock } from "./filesystem";
import { WIKI_MAX_PAGES } from "./execution-limits";
import { opaqueId, readWikiCabinet, WIKI_STATE_PATH } from "./config";
import { SourceStore } from "./source-store";
import { encodeSourceManifest } from "./manifest";
import type { PlanningWikiCompiler, WikiCompilationResult } from "./compiler";
import { parseWikiProvenance } from "./wiki-provenance";
import type { ProvenancePageSnapshot } from "./update-reconciliation";

export const textHash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const inventoryPath = `${WIKI_STATE_PATH}/wiki-inventory.json`;
interface Entry { path: string; before: string | null; after: string | null }
interface Receipt { schemaVersion: 1; jobId: string; cabinetId: string; planHash: string; wikiRoot: string; readPaths: string[]; status: "prepared" | "complete"; entries: Entry[]; checks: { path: string; hash: string | null }[] }

export async function durableText(root: string, relative: string, text: string) {
  const target = await ownedPath(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${randomUUID()}.tmp`;
  const handle = await fs.open(temp, "wx", 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  await fs.rename(temp, target);
  if (process.platform !== "win32") {
    for (let directory = path.dirname(target); ; directory = path.dirname(directory)) {
      const fd = await fs.open(directory, "r");
      try { await fd.sync(); } finally { await fd.close(); }
      if (directory === root) break;
    }
  }
}
async function read(root: string, relative: string) {
  const target = await ownedPath(root, relative);
  if (!await statOrNull(target)) return null;
  return fs.readFile(target, "utf8");
}
export async function readWikiInventory(root: string): Promise<ProvenancePageSnapshot[]> {
  const text = await read(root, inventoryPath);
  if (text === null) return [];
  if (text.length > 16 * 1024 * 1024) throw new Error("Wiki inventory exceeds limit");
  const values = JSON.parse(text);
  if (!Array.isArray(values) || values.length > 1000) throw new Error("Invalid Wiki inventory");
  return values.map((value) => ({ markdownHash: value.markdownHash, provenance: parseWikiProvenance(value.provenance) }));
}

/** After the tool-enabled Wiki agent edits Cabinet-published pages, refresh the
 * stored markdown hashes so later Cabinet operations see the accepted content
 * as current rather than as a foreign human edit. Returns the page paths whose
 * inventory entries could not be refreshed because the file is gone. */
export async function refreshWikiInventoryHashes(root: string, changedPaths: readonly string[]): Promise<string[]> {
  const text = await read(root, inventoryPath);
  if (text === null || !changedPaths.length) return [];
  const values = JSON.parse(text);
  if (!Array.isArray(values)) throw new Error("Invalid Wiki inventory");
  const changed = new Set(changedPaths);
  const missing: string[] = [];
  let touched = false;
  for (const value of values) {
    const pagePath = value?.provenance?.pagePath;
    if (typeof pagePath !== "string" || !changed.has(pagePath)) continue;
    const current = await read(root, pagePath);
    if (current === null) { missing.push(pagePath); continue; }
    value.markdownHash = textHash(current);
    touched = true;
  }
  if (touched) await durableText(root, inventoryPath, JSON.stringify(values));
  return missing;
}

/** Journaled roll-forward: all preconditions are checked before any page changes.
 * Readers may see partial files during recovery, but no completion marker, pointer
 * or job acknowledgment precedes the full page + provenance publication. */
export class WikiPublicationStore {
  constructor(private readonly root: string, private readonly checkpoint?: (index: number) => Promise<void>) {}
  private receiptPath(jobId: string) { opaqueId(jobId); return `${WIKI_STATE_PATH}/wiki-publications/${jobId}.json`; }
  async publishedPaths(jobId: string): Promise<{ wikiRoot: string; paths: string[] } | null> {
    const text = await read(this.root, this.receiptPath(jobId));
    if (!text) return null;
    const receipt = JSON.parse(text) as Receipt;
    if (receipt.status !== "complete" || typeof receipt.wikiRoot !== "string" || !Array.isArray(receipt.entries)) return null;
    return { wikiRoot: receipt.wikiRoot, paths: receipt.entries.map((entry) => entry.path).filter((entry) => entry === receipt.wikiRoot || entry.startsWith(`${receipt.wikiRoot}/`)) };
  }
  async recover(jobId: string): Promise<boolean> {
    return withRootLock(this.root, async () => {
      const text = await read(this.root, this.receiptPath(jobId));
      if (!text) return false;
      await this.apply(JSON.parse(text));
      return true;
    });
  }
  async publish(jobId: string, plan: WikiCompilationResult, compiler: PlanningWikiCompiler) {
    return withRootLock(this.root, async () => {
      const existing = await read(this.root, this.receiptPath(jobId));
      if (existing) { await this.apply(JSON.parse(existing)); return; }
      const cabinet = await readWikiCabinet(this.root);
      if (!cabinet?.config.enabled || cabinet.cabinetId !== plan.cabinetId) throw new Error("Wiki Cabinet changed");
      // A pending journal must be recovered before starting any other publication.
      const directory = await ownedPath(this.root, `${WIKI_STATE_PATH}/wiki-publications`);
      if (await statOrNull(directory)) for (const file of await fs.readdir(directory)) {
        if (!file.endsWith(".json")) continue;
        const prior = JSON.parse((await read(this.root, `${WIKI_STATE_PATH}/wiki-publications/${file}`))!);
        if (prior.status !== "complete") throw new Error("Recover the interrupted Wiki publication first");
      }
      await compiler.verifyPublication(plan);
      const manifest = await new SourceStore(this.root).get(plan.sourceId);
      if (!manifest) throw new Error("Missing publication Source");
      const sourcePath = `${manifest.source.rawPath}/manifest.yaml`;
      const beforeManifest = await read(this.root, sourcePath);
      if (manifest.source.status === "active") manifest.source.lastCompiledVersionId = manifest.source.currentVersionId;
      if (manifest.source.lifecycle?.reconciliation === "pending") manifest.source.lifecycle.reconciliation = "complete";
      const inventory = await readWikiInventory(this.root);
      const changed = new Set(plan.changes.map((item) => item.path));
      const nextInventory = inventory.filter((item) => !changed.has(item.provenance.pagePath));
      const entries: Entry[] = [];
      for (const change of plan.changes) {
        entries.push({ path: change.path, before: change.expectedHash, after: change.kind === "write" ? change.markdown : null });
        if (change.kind === "write" && change.provenance) nextInventory.push({ provenance: change.provenance, markdownHash: textHash(change.markdown) });
      }
      const beforeInventory = await read(this.root, inventoryPath);
      entries.push({ path: inventoryPath, before: beforeInventory === null ? null : textHash(beforeInventory), after: JSON.stringify(nextInventory) });
      entries.push({ path: sourcePath, before: textHash(beforeManifest!), after: encodeSourceManifest(manifest, cabinet) });
      // All other manifests and unread targets are checked again on recovery.
      const checks: Receipt["checks"] = plan.readSet.filter((item) => !changed.has(item.path)).map((item) => ({ path: item.path, hash: item.sha256 }));
      for (const entry of await new SourceStore(this.root).list()) {
        const file = `${entry.source.rawPath}/manifest.yaml`;
        if (file !== sourcePath) checks.push({ path: file, hash: textHash((await read(this.root, file))!) });
      }
      checks.push({ path: ".cabinet", hash: textHash((await read(this.root, ".cabinet"))!) });
      const receipt: Receipt = { schemaVersion: 1, jobId, cabinetId: cabinet.cabinetId, planHash: plan.planHash, wikiRoot: plan.wikiRoot, readPaths: plan.readSet.map((item) => item.path), status: "prepared", entries, checks };
      await durableText(this.root, this.receiptPath(jobId), JSON.stringify(receipt));
      await this.apply(receipt);
    });
  }
  private async apply(receipt: Receipt) {
    const cabinet = await readWikiCabinet(this.root);
    if (!cabinet?.config.enabled || receipt.schemaVersion !== 1 || receipt.cabinetId !== cabinet.cabinetId || !Array.isArray(receipt.entries)) throw new Error("Invalid publication receipt");
    if (receipt.status === "complete") return;
    if (receipt.status !== "prepared") throw new Error("Invalid publication state");
    const currentPaths: string[] = [];
    const scan = async (relative: string) => {
      const directory = await ownedPath(this.root, relative);
      if (!await statOrNull(directory)) return;
      for (const item of await fs.readdir(directory, { withFileTypes: true })) {
        if (item.name.startsWith(".")) continue;
        if (relative === receipt.wikiRoot && item.isDirectory() && !["sources", "entities", "concepts", "comparisons", "synthesis"].includes(item.name)) continue;
        const child = `${relative}/${item.name}`;
        if (item.isSymbolicLink()) throw new Error("Symlink appeared during Wiki recovery");
        if (item.isDirectory()) await scan(child);
        else if (item.name.endsWith(".md") && (relative !== receipt.wikiRoot || ["index.md", "overview.md", "log.md", "concept-table.md"].includes(item.name))) currentPaths.push(child);
        if (currentPaths.length > WIKI_MAX_PAGES) throw new Error("Wiki recovery scope exceeds limit");
      }
    };
    await scan(receipt.wikiRoot);
    const targets = new Set(receipt.entries.map((entry) => entry.path));
    const unchanged = (paths: string[]) => JSON.stringify(paths.filter((item) => !targets.has(item)).sort());
    if (unchanged(currentPaths) !== unchanged(receipt.readPaths)) throw new Error("Wiki inventory changed during publication; review required");
    for (const check of receipt.checks) {
      const text = await read(this.root, check.path);
      if ((text === null ? null : textHash(text)) !== check.hash) throw new Error("Publication context changed; review required");
    }
    for (const entry of receipt.entries) {
      const text = await read(this.root, entry.path);
      const hash = text === null ? null : textHash(text);
      if (hash !== entry.before && hash !== (entry.after === null ? null : textHash(entry.after))) throw new Error("Publication target changed; review required");
    }
    for (const [index, entry] of receipt.entries.entries()) {
      if (entry.after === null) {
        const target = await ownedPath(this.root, entry.path);
        await fs.rm(target, { force: true });
        if (process.platform !== "win32") { const fd = await fs.open(path.dirname(target), "r"); try { await fd.sync(); } finally { await fd.close(); } }
      }
      else await durableText(this.root, entry.path, entry.after);
      await this.checkpoint?.(index);
    }
    receipt.status = "complete";
    await durableText(this.root, this.receiptPath(receipt.jobId), JSON.stringify(receipt));
  }
}
