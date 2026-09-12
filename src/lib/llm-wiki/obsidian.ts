import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readWikiCabinet } from "./config";
import { contains, ownedPath, relativePath, statOrNull } from "./filesystem";
import { SourceStore } from "./source-store";
import { RawPublicationStore } from "./raw-publication";
import { SourceNormalizationService } from "./normalizers";
import type { CabinetId, SourceVersionId } from "./types";

const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export interface ObsidianInventory {
  readonly cabinetId: CabinetId;
  readonly fingerprint: string;
  readonly notes: readonly { path: string; contentHash: string; bytes: number }[];
  readonly skipped: readonly { path: string; reason: string }[];
}
const signature = (stat: Awaited<ReturnType<typeof fs.stat>>) => `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;

/** An already imported vault occupies one initialized Cabinet root. This service
 * never moves a vault, creates a room per folder, or writes to original notes. */
export class ObsidianManagedSourceService {
  constructor(private readonly root: string, private readonly folders?: readonly string[]) {}
  private async cabinet() {
    const cabinet = await readWikiCabinet(this.root);
    if (!cabinet?.config.enabled) throw new Error("Obsidian integration requires an enabled Wiki Cabinet");
    if (this.folders) {
      if (!this.folders.length || this.folders.length > 20) throw new Error("Select 1 to 20 source folders");
      for (const folder of this.folders) {
        relativePath(folder);
        if (folder.split("/").some((part) => part.startsWith(".")) || Object.values(cabinet.config.paths).some((layer) => contains(layer, folder) || contains(folder, layer))) throw new Error("Source folder overlaps a generated layer");
        if (!(await statOrNull(await ownedPath(cabinet.rootPath, folder)))?.isDirectory()) throw new Error(`Source folder is unavailable: ${folder}`);
      }
      return cabinet;
    }
    const marker = await ownedPath(cabinet.rootPath, ".obsidian");
    if (!(await statOrNull(marker))?.isDirectory()) throw new Error("The Cabinet root must be the imported Obsidian vault (.obsidian directory required)");
    return cabinet;
  }
  private async capture(relative: string): Promise<Buffer> {
    relativePath(relative);
    const cabinet = await this.cabinet();
    if (relative.split("/").some((part) => part.startsWith(".")) || Object.values(cabinet.config.paths).some((layer) => contains(layer, relative))) throw new Error("Obsidian note is in an excluded layer");
    if (this.folders && !this.folders.some((folder) => contains(folder, relative))) throw new Error("Note is outside selected folders");
    const components = relative.split("/");
    for (let i = 1; i < components.length; i++) {
      const folder = components.slice(0, i).join("/");
      if (await statOrNull(await ownedPath(cabinet.rootPath, `${folder}/.cabinet`)) || (!this.folders && await statOrNull(await ownedPath(cabinet.rootPath, `${folder}/.obsidian`)))) throw new Error("Nested Cabinets and vaults require separate integration");
    }
    if (!/\.(md|markdown)$/i.test(relative)) throw new Error("Only Markdown vault notes can be registered");
    const target = await ownedPath(cabinet.rootPath, relative);
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > 20 * 1024 * 1024) throw new Error("Invalid or oversized Obsidian note");
      const bytes = await handle.readFile();
      if (bytes.length !== before.size || signature(before) !== signature(await handle.stat()) || signature(before) !== signature(await fs.stat(await ownedPath(cabinet.rootPath, relative)))) throw new Error("Obsidian note changed during capture");
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return bytes;
    } finally { await handle.close(); }
  }
  async inspect(): Promise<ObsidianInventory> {
    const cabinet = await this.cabinet();
    const notes: { path: string; contentHash: string; bytes: number }[] = [];
    const skipped: { path: string; reason: string }[] = [];
    let entries = 0, total = 0;
    const walk = async (folder: string, depth: number) => {
      if (depth > 16) throw new Error("Vault nesting exceeds inspection limit");
      const directory = folder ? await ownedPath(cabinet.rootPath, folder) : cabinet.rootPath;
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
        if (++entries > 5000) throw new Error("Vault exceeds inspection entry limit");
        const relative = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.name.startsWith(".") || Object.values(cabinet.config.paths).some((layer) => contains(layer, relative))) { skipped.push({ path: relative, reason: "Settings, internal or generated layer" }); continue; }
        try { relativePath(relative); } catch { skipped.push({ path: relative, reason: "Filename is not supported by the portable source registry (for example ?, *, or a trailing space). Original retained." }); continue; }
        if (entry.isSymbolicLink()) { skipped.push({ path: relative, reason: "Symlink is not imported" }); continue; }
        if (entry.isDirectory()) {
          if (await statOrNull(await ownedPath(cabinet.rootPath, `${relative}/.cabinet`)) || (!this.folders && await statOrNull(await ownedPath(cabinet.rootPath, `${relative}/.obsidian`)))) { skipped.push({ path: relative, reason: "Separate Cabinet or nested vault" }); continue; }
          await walk(relative, depth + 1);
        } else if (entry.isFile() && /\.(md|markdown)$/i.test(relative)) {
          if (notes.length >= 500) throw new Error("Vault exceeds 500-note integration limit");
          const bytes = await this.capture(relative);
          total += bytes.length;
          if (total > 100 * 1024 * 1024) throw new Error("Vault note inventory exceeds 100 MB");
          notes.push({ path: relative, contentHash: hash(bytes), bytes: bytes.length });
        } else skipped.push({ path: relative, reason: "Non-Markdown file retained in vault" });
      }
    };
    for (const folder of this.folders ?? [""]) await walk(folder, 0);
    const aliases = notes.map((note) => note.path.normalize("NFC").toLowerCase());
    if (new Set(aliases).size !== aliases.length) throw new Error("Ambiguous vault note paths");
    return { cabinetId: cabinet.cabinetId, notes, skipped, fingerprint: hash(JSON.stringify({ cabinetId: cabinet.cabinetId, config: cabinet.config, notes })) };
  }

  /** Selection is explicit. A batch may partially finish; successful immutable
   * captures are retained and registration/publication retries reuse their IDs. */
  async importNotes(inventory: ObsidianInventory, selectedPaths: readonly string[], classification = "obsidian") {
    const selection = [...selectedPaths];
    if (!selection.length || selection.length > 500 || new Set(selection).size !== selection.length) throw new Error("Invalid Obsidian selection");
    const fresh = await this.inspect();
    if (inventory.cabinetId !== fresh.cabinetId || inventory.fingerprint !== fresh.fingerprint) throw new Error("Vault inventory changed; inspect again before import");
    for (const selected of selection) if (!fresh.notes.some((note) => note.path === selected)) throw new Error("Selected note is outside the inspected vault inventory");
    const results = [];
    for (const selected of selection) {
      const note = fresh.notes.find((item) => item.path === selected)!;
      const { manifest, warnings } = await this.captureNote(selected, note.contentHash, classification);
      results.push({ path: selected, sourceId: manifest.source.id, versionId: manifest.source.currentVersionId, warnings });
    }
    return results;
  }

  /** Explicit current-byte capture for queue integration. Later saves also use
   * this existing managed binding; no second watcher or automatic restore exists. */
  async captureNote(relative: string, expectedHash: string, classification = "obsidian", expectedVersionId?: SourceVersionId) {
    const bytes = await this.capture(relative);
    if (!/^[a-f0-9]{64}$/.test(expectedHash) || hash(bytes) !== expectedHash) throw new Error("Obsidian note changed since inspection");
    const normalized = await new SourceNormalizationService().normalize({ path: relative, bytes, contentHash: expectedHash });
    const store = new SourceStore(this.root);
    const location = { kind: "cabinet" as const, path: relative };
    let source = await store.findManaged(location);
    if (!source) {
      if (expectedVersionId) throw new Error("Expected managed Source is missing");
      source = (await store.register({ mode: "managed", title: path.posix.basename(relative, path.posix.extname(relative)), classification, roomPath: null, managedLocation: location })).source;
    }
    if (source.status !== "active" || source.lifecycle?.reconciliation === "pending") throw new Error("Source lifecycle requires explicit reconciliation before capture");
    if (source.roomPath !== null || source.mode !== "managed") throw new Error("Vault note has a conflicting Source binding");
    const publisher = new RawPublicationStore(this.root);
    if (expectedVersionId && expectedVersionId !== source.currentVersionId) throw new Error("Obsidian predecessor changed; reload Source");
    if (!source.currentVersionId) return { manifest: await publisher.publishInitial(source.id, normalized), warnings: normalized.warnings };
    const manifest = await store.get(source.id);
    const current = manifest!.versions.find((version) => version.id === source.currentVersionId)!;
    if (current.contentHash === expectedHash) {
      await publisher.readCapturedFile(source.id, current.id, "source.md");
      await publisher.readCapturedFile(source.id, current.id, `original.${current.originalFormat}`);
      return { manifest: manifest!, warnings: normalized.warnings };
    }
    if (!expectedVersionId) throw new Error("Changed registered note requires an explicit predecessor version");
    return { manifest: await publisher.publishUpdate(source.id, expectedVersionId, normalized), warnings: normalized.warnings };
  }
}
