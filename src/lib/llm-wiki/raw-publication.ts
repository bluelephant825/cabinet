import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { randomUUID, createHash } from "node:crypto";
import { opaqueId, readWikiCabinet, WIKI_STATE_PATH, type WikiCabinet } from "./config";
import { ownedPath, relativePath, statOrNull, withRootLock } from "./filesystem";
import { decodeSourceManifest, encodeSourceManifest, type SourceManifest } from "./manifest";
import { prepareEvidenceDocument, readEvidenceDocument } from "./provenance";
import { SourceStore } from "./source-store";
import type { NormalizedSource } from "./normalizers/types";
import type { SourceId, SourceVersionId } from "./types";
import { compareEvidence, type DeltaModel } from "./version-delta";

const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
interface FileEntry { path: string; sha256: string; size: number }
interface Receipt { schemaVersion: 1; baseHash: string; manifest: string; files: FileEntry[] }
type Checkpoint = "prepared" | "staged" | "published" | "committed";

async function syncDirectory(directory: string) {
  // Node cannot open directory handles for fsync on Windows. Files are still
  // flushed there; power-loss durability additionally depends on the filesystem.
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function writeExclusive(target: string, bytes: Uint8Array | string) {
  const handle = await fs.open(target, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function mkdir(target: string) {
  const firstCreated = await fs.mkdir(target, { recursive: true });
  if (!firstCreated) return;
  // Flush newly created directories and the existing parent that names them.
  for (let cursor = target; ; cursor = path.dirname(cursor)) {
    await syncDirectory(cursor);
    if (cursor === path.dirname(firstCreated)) break;
  }
}

/** Publishes immutable versions for an already registered Source. No queue claims, conversion,
 * working-file writes, or compilation. Receipts remain as integrity/recovery records.
 */
export class RawPublicationStore {
  constructor(private readonly rootPath: string,
    private readonly checkpoint?: (point: Checkpoint) => void | Promise<void>) {}

  private async cabinet(): Promise<WikiCabinet> {
    const cabinet = await readWikiCabinet(this.rootPath);
    if (!cabinet?.config.enabled) throw new Error("LLM Wiki is not enabled");
    return cabinet;
  }

  /** Repeating with the same normalized bytes verifies/resumes the same v1.
   * A different payload is never treated as an initial-version retry. */
  async publishInitial(id: SourceId, normalized: NormalizedSource): Promise<SourceManifest> {
    return this.publish(id, normalized);
  }

  /** The expected predecessor is a durable retry key: retries cannot accidentally
   * allocate vN+2, even after another update has advanced the Source. */
  async publishUpdate(id: SourceId, expectedPreviousVersionId: SourceVersionId, normalized: NormalizedSource): Promise<SourceManifest> {
    opaqueId(expectedPreviousVersionId);
    return this.publish(id, normalized, expectedPreviousVersionId);
  }

  private async publish(id: SourceId, normalized: NormalizedSource, previousId?: SourceVersionId): Promise<SourceManifest> {
    // Snapshot caller-owned buffers before the first asynchronous boundary.
    const captured = structuredClone(normalized);
    opaqueId(id);
    const first = await this.cabinet();
    return withRootLock(first.rootPath, async () => {
      const cabinet = await this.cabinet();
      const current = await new SourceStore(cabinet.rootPath).get(id);
      if (!current || current.source.status !== "active") throw new Error("Active Source not found");
      const previous = previousId ? current.versions.find((version) => version.id === previousId) : undefined;
      if (previousId && (current.source.mode !== "managed" || !previous)) throw new Error("Managed Source predecessor not found");
      if (hash(captured.original.bytes) !== captured.original.contentHash) throw new Error("Captured content hash mismatch");
      const number = previous ? previous.version + 1 : 1;
      if (!Number.isSafeInteger(number)) throw new Error("Version number exhausted");
      const transaction = `${WIKI_STATE_PATH}/publications/${id}/v${number}`;
      const receiptPath = await ownedPath(cabinet.rootPath, `${transaction}/receipt.json`);
      let receipt: Receipt;
      let intended: SourceManifest;
      if (await statOrNull(receiptPath)) {
        ({ receipt, intended } = await this.readReceipt(cabinet, id, receiptPath, current.source.rawPath, number));
      } else {
        if (!previous && current.versions.length) throw new Error("Initial version already exists; later versions require the update workflow");
        if (await statOrNull(await ownedPath(cabinet.rootPath, `${current.source.rawPath}/v${number}`))) {
          throw new Error(`Unjournaled v${number} requires review`);
        }
        if (previous) {
          if (current.source.currentVersionId !== previousId) throw new Error("Stale predecessor; review the current version");
          // Verify the predecessor before accepting a no-op or appending history.
          const saved = await this.readReceipt(cabinet, id, await ownedPath(cabinet.rootPath,
            `${WIKI_STATE_PATH}/publications/${id}/v${previous.version}/receipt.json`), current.source.rawPath, previous.version);
          await this.finish(cabinet, id, saved.receipt, saved.intended,
            `${WIKI_STATE_PATH}/publications/${id}/v${previous.version}`);
          // The note bytes alone do not identify an illustrated capture. Changed,
          // added or removed dependencies must also create a historical version.
          const originals = (files: FileEntry[]) => files.filter((file) => file.path.startsWith("capture/") && file.path !== `capture/${captured.original.path}`);
          if (previous.contentHash === captured.original.contentHash && previous.originalFormat === captured.original.format &&
              JSON.stringify(originals(this.inventory(this.payload(captured, saved.intended)))) === JSON.stringify(originals(saved.receipt.files))) return current;
        }
        const now = new Date().toISOString();
        const base = `${current.source.rawPath}/v${number}`;
        const prepared = prepareEvidenceDocument(captured, current.source, {
          id: randomUUID() as SourceVersionId, sourceId: id, cabinetId: cabinet.cabinetId,
          version: number, contentHash: captured.original.contentHash, originalFormat: captured.original.format,
          originalPath: `${base}/original.${captured.original.format}`, markdownPath: `${base}/source.md`,
          assetsPath: `${base}/assets`, createdAt: now,
        });
        intended = { ...current, source: { ...current.source, currentVersionId: prepared.version.id, updatedAt: now }, versions: [...current.versions, prepared.version] };
        const files = this.payload(captured, intended);
        const manifestPath = await ownedPath(cabinet.rootPath, `${current.source.rawPath}/manifest.yaml`);
        receipt = { schemaVersion: 1, baseHash: hash(await fs.readFile(manifestPath)),
          manifest: encodeSourceManifest(intended, cabinet), files: this.inventory(files) };
        await mkdir(path.dirname(receiptPath));
        // A partial receipt is deliberately not auto-adopted after a crash.
        await writeExclusive(receiptPath, JSON.stringify(receipt));
        await syncDirectory(path.dirname(receiptPath));
      }
      const files = this.payload(captured, intended, receipt.files.some((file) => file.path === `capture/${captured.original.path}`));
      if (JSON.stringify(this.inventory(files)) !== JSON.stringify(receipt.files)) throw new Error("Publication retry payload differs; review required");
      await this.checkpoint?.("prepared");
      return this.finish(cabinet, id, receipt, intended, transaction, files);
    });
  }

  /** Resume complete staged/orphaned output without re-running normalization.
   * Missing staged bytes require retrying publication with the original input. */
  async recoverInitial(id: SourceId): Promise<SourceManifest> {
    return this.recoverVersion(id, 1);
  }

  /** Explicit version number only; never discover/adopt the highest directory. */
  async recoverVersion(id: SourceId, number: number): Promise<SourceManifest> {
    opaqueId(id);
    if (!Number.isSafeInteger(number) || number < 1) throw new Error("Invalid version number");
    const first = await this.cabinet();
    return withRootLock(first.rootPath, async () => {
      const cabinet = await this.cabinet();
      const current = await new SourceStore(cabinet.rootPath).get(id);
      if (!current) throw new Error("Source not found");
      const transaction = `${WIKI_STATE_PATH}/publications/${id}/v${number}`;
      const { receipt, intended } = await this.readReceipt(cabinet, id,
        await ownedPath(cabinet.rootPath, `${transaction}/receipt.json`), current.source.rawPath, number);
      return this.finish(cabinet, id, receipt, intended, transaction);
    });
  }

  /** Compare committed adjacent versions. A failed semantic analysis does not
   * undo publication; callers may retry it before later Wiki reconciliation. */
  async compareVersions(id: SourceId, fromId: SourceVersionId, toId: SourceVersionId, model?: DeltaModel) {
    opaqueId(id); opaqueId(fromId); opaqueId(toId);
    const cabinet = await this.cabinet();
    const bodies = await withRootLock(cabinet.rootPath, async () => {
      const entry = await new SourceStore(cabinet.rootPath).get(id);
      const from = entry?.versions.find((version) => version.id === fromId);
      const to = entry?.versions.find((version) => version.id === toId);
      if (!entry || !from || !to || to.version !== from.version + 1) throw new Error("Adjacent committed versions required");
      const output: string[] = [];
      for (const version of [from, to]) {
        const saved = await this.readReceipt(cabinet, id, await ownedPath(cabinet.rootPath,
          `${WIKI_STATE_PATH}/publications/${id}/v${version.version}/receipt.json`), entry.source.rawPath, version.version);
        if (!isDeepStrictEqual(saved.intended.versions, entry.versions.slice(0, version.version))) throw new Error("Receipt history mismatch");
        await this.verify(cabinet, `${entry.source.rawPath}/v${version.version}`, saved.receipt, saved.intended);
        output.push(readEvidenceDocument(await fs.readFile(await ownedPath(cabinet.rootPath, version.markdownPath), "utf8"),
          { source: entry.source, version }).body);
      }
      return output;
    });
    return compareEvidence(fromId, toId, bodies[0], bodies[1], model);
  }

  /** Read only receipt-listed captured bytes. Works while ingestion is disabled. */
  async readCapturedFile(id: SourceId, versionId: SourceVersionId, relative: string, limit = 500 * 1024 * 1024) {
    opaqueId(id); opaqueId(versionId); relativePath(relative);
    const cabinet = await readWikiCabinet(this.rootPath);
    if (!cabinet) throw new Error("Source not found");
    const entry = await new SourceStore(cabinet.rootPath).get(id);
    const version = entry?.versions.find((item) => item.id === versionId);
    if (!entry || !version) throw new Error("Source version not found");
    const saved = await this.readReceipt(cabinet, id, await ownedPath(cabinet.rootPath,
      `${WIKI_STATE_PATH}/publications/${id}/v${version.version}/receipt.json`), entry.source.rawPath, version.version);
    if (!isDeepStrictEqual(saved.intended.versions, entry.versions.slice(0, version.version))) throw new Error("Receipt history mismatch");
    const file = saved.receipt.files.find((item) => item.path === relative);
    if (!file) throw new Error("Captured file not found");
    if (file.size > limit) throw new Error("File is too large for this preview. Download the original instead.");
    const target = await ownedPath(cabinet.rootPath, `${entry.source.rawPath}/v${version.version}/${relative}`);
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size !== file.size) throw new Error("Evidence integrity mismatch");
    const bytes = await fs.readFile(target);
    if (hash(bytes) !== file.sha256) throw new Error("Evidence integrity mismatch");
    if (relative === "source.md") readEvidenceDocument(bytes.toString("utf8"), { source: entry.source, version });
    return { source: entry.source, version, bytes };
  }

  private payload(normalized: NormalizedSource, intended: SourceManifest, legacyCopy = false): Map<string, Uint8Array> {
    const version = intended.versions[intended.versions.length - 1];
    const prepared = prepareEvidenceDocument(normalized, intended.source, version);
    const files = new Map<string, Uint8Array>();
    const add = (name: string, bytes: Uint8Array | string) => {
      relativePath(name);
      if ([...files.keys()].some((key) => {
        const a = key.normalize("NFC").toLowerCase(), b = name.normalize("NFC").toLowerCase();
        return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
      })) throw new Error("Conflicting publication paths");
      files.set(name, Buffer.from(bytes));
    };
    add(`original.${version.originalFormat}`, normalized.original.bytes);
    add("source.md", prepared.markdown);
    // Preserve the original relative layout as well as the convenient original.ext.
    // This copy allows HTML/Markdown dependencies to resolve without changing bytes.
    const keepCopy = legacyCopy || !["md", "markdown"].includes(version.originalFormat);
    if (keepCopy) add(`capture/${relativePath(normalized.original.path)}`, normalized.original.bytes);
    for (const asset of normalized.original.assets) add(`capture/${relativePath(asset.path)}`, asset.bytes);
    for (const asset of normalized.assets) {
      if (!relativePath(asset.path).startsWith("assets/") || hash(asset.bytes) !== asset.contentHash) throw new Error("Invalid normalized asset");
      add(asset.path, asset.bytes);
    }
    add("capture.json", JSON.stringify({ schemaVersion: 1, original: keepCopy ? `capture/${normalized.original.path}` : `original.${version.originalFormat}` }) + "\n");
    return files;
  }

  private inventory(files: Map<string, Uint8Array>): FileEntry[] {
    return [...files].map(([name, bytes]) => ({ path: name, sha256: hash(bytes), size: bytes.length }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  private async readReceipt(cabinet: WikiCabinet, id: SourceId, target: string, rawPath: string, number: number) {
    const bytes = await fs.readFile(target);
    if (bytes.length > 10_000_000) throw new Error("Publication receipt is too large");
    const receipt = JSON.parse(bytes.toString("utf8")) as Receipt;
    if (receipt.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(receipt.baseHash) ||
        typeof receipt.manifest !== "string" || !Array.isArray(receipt.files) || receipt.files.length > 1024) throw new Error("Invalid publication receipt");
    const intended = decodeSourceManifest(receipt.manifest, cabinet, rawPath);
    if (intended.source.id !== id || intended.versions.length !== number || intended.versions.some((version, index) => version.version !== index + 1)) throw new Error("Foreign publication receipt");
    const paths: string[] = [];
    for (const file of receipt.files) {
      relativePath(file.path);
      const key = file.path.normalize("NFC").toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 500 * 1024 * 1024 ||
          paths.some((p) => p === key || p.startsWith(`${key}/`) || key.startsWith(`${p}/`))) throw new Error("Invalid receipt file");
      paths.push(key);
    }
    const original = receipt.files.find((file) => file.path === `original.${intended.versions[intended.versions.length - 1].originalFormat}`);
    if (original?.sha256 !== intended.versions[intended.versions.length - 1].contentHash || !paths.includes("source.md") || !paths.includes("capture.json")) throw new Error("Incomplete publication receipt");
    return { receipt, intended };
  }

  private async verify(cabinet: WikiCabinet, directory: string, receipt: Receipt, intended: SourceManifest) {
    if (!(await statOrNull(await ownedPath(cabinet.rootPath, `${directory}/assets`)))?.isDirectory()) {
      throw new Error("Incomplete staging: assets directory missing");
    }
    const expected = new Set(receipt.files.map((file) => file.path));
    const walk = async (relative: string) => {
      for (const entry of await fs.readdir(await ownedPath(cabinet.rootPath, relative), { withFileTypes: true })) {
        const child = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          const local = child.slice(directory.length + 1);
          if (local !== "assets" && !receipt.files.some((file) => file.path.startsWith(`${local}/`))) throw new Error("Unexpected evidence directory");
          await walk(child);
        } else if (!entry.isFile() || !expected.delete(child.slice(directory.length + 1))) throw new Error("Unexpected evidence file or symlink");
      }
    };
    await walk(directory);
    if (expected.size) throw new Error("Incomplete staging; retry publication with the same captured input");
    for (const file of receipt.files) {
      const target = await ownedPath(cabinet.rootPath, `${directory}/${file.path}`);
      if ((await fs.stat(target)).size !== file.size) throw new Error("Evidence integrity mismatch; review required");
      const bytes = await fs.readFile(target);
      if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error("Evidence integrity mismatch; review required");
    }
    readEvidenceDocument(await fs.readFile(await ownedPath(cabinet.rootPath, `${directory}/source.md`), "utf8"),
      { source: intended.source, version: intended.versions[intended.versions.length - 1] });
  }

  private async finish(cabinet: WikiCabinet, id: SourceId, receipt: Receipt, intended: SourceManifest,
    transaction: string, files?: Map<string, Uint8Array>): Promise<SourceManifest> {
    const manifestPath = await ownedPath(cabinet.rootPath, `${intended.source.rawPath}/manifest.yaml`);
    const currentBytes = await fs.readFile(manifestPath);
    const current = decodeSourceManifest(currentBytes.toString("utf8"), cabinet, intended.source.rawPath);
    const committed = current.versions.length >= intended.versions.length &&
      isDeepStrictEqual(current.versions.slice(0, intended.versions.length), intended.versions);
    if (current.source.id !== id || (!committed && hash(currentBytes) !== receipt.baseHash)) throw new Error("Manifest changed during publication; review required");
    const final = `${intended.source.rawPath}/v${intended.versions.length}`, staging = `${transaction}/staging`;
    const finalPath = await ownedPath(cabinet.rootPath, final);
    if (!await statOrNull(finalPath)) {
      if (committed) throw new Error("Committed evidence is missing; review required");
      const stagingPath = await ownedPath(cabinet.rootPath, staging);
      if (files) {
        await mkdir(stagingPath);
        await mkdir(await ownedPath(cabinet.rootPath, `${staging}/assets`));
        for (const [name, bytes] of files) {
          const target = await ownedPath(cabinet.rootPath, `${staging}/${name}`);
          if (await statOrNull(target)) continue; // Never repair a mismatching/partial file silently.
          await mkdir(path.dirname(target));
          await writeExclusive(target, bytes);
          await syncDirectory(path.dirname(target));
        }
      }
      await this.verify(cabinet, staging, receipt, intended);
      await this.checkpoint?.("staged");
      await fs.rename(stagingPath, finalPath);
      await syncDirectory(path.dirname(finalPath));
      await syncDirectory(path.dirname(stagingPath));
      await this.checkpoint?.("published");
    }
    await this.verify(cabinet, final, receipt, intended);
    if (committed) return current; // Preserve later logical metadata and compilation pointers.
    const temp = await ownedPath(cabinet.rootPath, `${transaction}/manifest-${randomUUID()}.tmp`);
    await writeExclusive(temp, receipt.manifest);
    await fs.rename(temp, manifestPath);
    await syncDirectory(path.dirname(manifestPath));
    await this.checkpoint?.("committed");
    return intended;
  }
}
