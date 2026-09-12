import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { writeFileAtomic } from "@/lib/storage/fs-operations";
import { opaqueId, readWikiCabinet, type WikiCabinet } from "./config";
import { contains, ownedPath, relativePath, withRootLock } from "./filesystem";
import { manifestText as text, manifestLocation as location, validateBinding,
  decodeSourceManifest, encodeSourceManifest, type SourceManifest } from "./manifest";
export type { SourceManifest } from "./manifest";
import type { Source, SourceId, SourceLocation } from "./types";
import { classificationPath } from "./classification-path";
import type { ClassificationDecision, ClassificationTaxonomy } from "./classification";

export type RegisterSourceInput = {
  title: string;
  /** Relative classification directory under the configured Raw root. */
  classification: string;
  roomPath: string | null;
} & (
  | { mode: "snapshot"; managedLocation?: never }
  | { mode: "managed"; managedLocation: SourceLocation }
);

function bindingKey(input: SourceLocation): string {
  const portablePath = input.path.normalize("NFC").toLowerCase();
  return JSON.stringify(input.kind === "cabinet"
    ? [input.kind, portablePath]
    : [input.kind, input.roomPath.normalize("NFC").toLowerCase(), input.mountId, portablePath]);
}

/** Disk manifests are authoritative. No second persistent registry/cache. */
export class SourceStore {
  constructor(private readonly rootPath: string) {}

  private async cabinet(writing = false): Promise<WikiCabinet> {
    const cabinet = await readWikiCabinet(this.rootPath);
    if (!cabinet) throw new Error("LLM Wiki has not been initialized");
    if (writing && !cabinet.config.enabled) throw new Error("LLM Wiki is disabled");
    return cabinet;
  }

  private async scan(cabinet: WikiCabinet): Promise<SourceManifest[]> {
    const result: SourceManifest[] = [];
    const walk = async (relative: string): Promise<void> => {
      const directory = await ownedPath(cabinet.rootPath, relative);
      let entries;
      try { entries = await fs.readdir(directory, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && relative === cabinet.config.paths.raw) return;
        throw error;
      }
      if (entries.some((entry) => entry.name === "manifest.yaml")) {
        const target = await ownedPath(cabinet.rootPath, `${relative}/manifest.yaml`);
        const parsed = decodeSourceManifest(await fs.readFile(target, "utf8"), cabinet, relative);
        if (result.some((item) => item.source.id === parsed.source.id)) throw new Error("Duplicate Source ID");
        result.push(parsed);
        return; // Versions contain evidence, not nested logical source manifests.
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) throw new Error(`Symlink in Raw registry: ${entry.name}`);
        if (entry.isDirectory()) await walk(`${relative}/${entry.name}`);
      }
    };
    await walk(cabinet.config.paths.raw);
    const bindings = new Set<string>();
    for (const { source } of result) {
      if (source.mode !== "managed") continue;
      const key = bindingKey(location(source.managedLocation));
      if (bindings.has(key)) throw new Error("Duplicate managed source binding");
      bindings.add(key);
    }
    return result.sort((a, b) => a.source.id.localeCompare(b.source.id));
  }

  async list(): Promise<SourceManifest[]> { return this.scan(await this.cabinet()); }

  /** Current-source search/synthesis must use this projection, not audit history. */
  async listActive(roomPath: string | null = null): Promise<SourceManifest[]> {
    if (roomPath !== null) relativePath(roomPath);
    return (await this.list()).filter(({ source }) => source.status === "active" &&
      source.roomPath === roomPath);
  }

  async get(id: SourceId): Promise<SourceManifest | null> {
    opaqueId(id);
    return (await this.list()).find((item) => item.source.id === id) ?? null;
  }

  async findManaged(input: SourceLocation): Promise<Source | null> {
    const key = bindingKey(location(input));
    return (await this.list()).map((item) => item.source).find((source) =>
      source.mode === "managed" && bindingKey(location(source.managedLocation)) === key) ?? null;
  }

  private async resolveWorkingPath(cabinet: WikiCabinet, input: SourceLocation, roomPath: string | null): Promise<string> {
    validateBinding(cabinet, input, roomPath);
    let target: string;
    if (input.kind === "cabinet") {
      target = await ownedPath(cabinet.rootPath, input.path);
    } else {
      // Reuse existing mount authorization. That service is active-root scoped,
      // so refuse a different root instead of leaking the active root's mounts.
      const { DATA_DIR } = await import("@/lib/storage/path-utils");
      if (await fs.realpath(DATA_DIR) !== cabinet.rootPath) throw new Error("Mount registration requires the active Cabinet");
      const { readKnowledgeSources } = await import("@/lib/knowledge-sources/store");
      const mount = (await readKnowledgeSources(input.roomPath)).find((item) => item.id === input.mountId && item.enabled);
      if (!mount) throw new Error("Unknown or disabled knowledge mount");
      const mountRoot = await fs.realpath(mount.absPath);
      target = await ownedPath(mountRoot, input.path);
      // A mount must not provide an alias back into generated layers.
      const relative = path.relative(cabinet.rootPath, target).split(path.sep).join("/");
      if (!relative.startsWith("../") && !path.isAbsolute(relative) &&
          (relative.split("/").some((part) => part.startsWith(".")) ||
           Object.values(cabinet.config.paths).some((layer) => contains(layer, relative)))) {
        throw new Error("Mount points into a generated or internal layer");
      }
    }
    return target;
  }

  private async validateWorkingFile(cabinet: WikiCabinet, input: SourceLocation, roomPath: string | null): Promise<void> {
    const target = await this.resolveWorkingPath(cabinet, input, roomPath);
    if (!(await fs.stat(target)).isFile()) throw new Error("Managed input must be an existing file");
  }

  /** Resolve an authorized binding, allowing a missing working file for deletion detection.
   * An unavailable/disabled mount still throws: loss of access is not deletion.
   */
  async resolveManagedPath(source: Extract<Source, { mode: "managed" }>): Promise<string> {
    const cabinet = await this.cabinet();
    if (source.cabinetId !== cabinet.cabinetId) throw new Error("Foreign Source");
    return this.resolveWorkingPath(cabinet, location(source.managedLocation), source.roomPath);
  }

  /** A classification plan can be consumed under the registration lock so stale
   * or review-only decisions cannot create a source/category. */
  async register(input: RegisterSourceInput, plan?: {
    taxonomy: ClassificationTaxonomy; decision: ClassificationDecision;
  }): Promise<SourceManifest> {
    const first = await this.cabinet(true);
    return withRootLock(first.rootPath, async () => {
      const cabinet = await this.cabinet(true);
      if (plan) {
        const { readClassificationTaxonomy, validateClassificationDecision } = await import("./classification");
        const fresh = await readClassificationTaxonomy(cabinet.rootPath, input.roomPath);
        if (fresh.fingerprint !== plan.taxonomy.fingerprint || fresh.cabinetId !== plan.taxonomy.cabinetId ||
            fresh.roomPath !== plan.taxonomy.roomPath) throw new Error("Taxonomy changed; classify again");
        const decision = validateClassificationDecision(plan.decision, fresh, plan.decision.kind === "new");
        if (decision.kind === "review" || decision.category !== input.classification) throw new Error("Classification requires review or does not match registration");
      }
      const title = text(input.title).trim();
      const classification = relativePath(input.classification);
      if (classification.split("/").some((part) => part.startsWith("."))) throw new Error("Hidden classification is not permitted");
      if (classification.split("/").some((part) => part.toLowerCase() === "manifest.yaml")) {
        throw new Error("Classification conflicts with the source manifest filename");
      }
      classificationPath(classification);
      const roomPath = input.roomPath === null ? null : relativePath(input.roomPath);
      if (roomPath !== null) {
        await fs.access(await ownedPath(cabinet.rootPath, `${roomPath}/.cabinet`));
      }
      const entries = await this.scan(cabinet);
      let managed: SourceLocation | undefined;
      if (input.mode === "managed") {
        managed = location(input.managedLocation);
        await this.validateWorkingFile(cabinet, managed, roomPath);
        if (entries.some(({ source }) => source.mode === "managed" &&
            bindingKey(location(source.managedLocation)) === bindingKey(managed!))) {
          throw new Error("Working file is already registered");
        }
      } else if (input.mode !== "snapshot" || input.managedLocation !== undefined) {
        throw new Error("Invalid source mode");
      }
      const id = randomUUID() as SourceId;
      const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "source";
      const rawPath = managed?.kind === "cabinet"
        ? `${cabinet.config.paths.raw}/${managed.path.replace(/\.(md|markdown)$/i, "")}`
        : `${cabinet.config.paths.raw}/${classification}/${slug}-${id}`;
      if (entries.some(({ source }) => contains(source.rawPath, rawPath) || contains(rawPath, source.rawPath))) throw new Error("Source directory conflicts with an existing Source");
      const now = new Date().toISOString();
      const base = {
        id, cabinetId: cabinet.cabinetId, roomPath, title, slug, rawPath, classification,
        ...(managed?.kind === "cabinet" ? { mirroredFrom: managed.path } : {}),
        status: "active" as const, currentVersionId: null, lastCompiledVersionId: null,
        createdAt: now, updatedAt: now,
      };
      const source: Source = managed
        ? { ...base, mode: "managed", managedLocation: managed }
        : { ...base, mode: "snapshot" };
      const output: SourceManifest = { schemaVersion: 1, source, versions: [] };
      const directory = await ownedPath(cabinet.rootPath, rawPath);
      await fs.mkdir(path.dirname(directory), { recursive: true });
      await fs.mkdir(directory); // No reuse or overwrite of an existing Source.
      await writeFileAtomic(path.join(directory, "manifest.yaml"), encodeSourceManifest(output, cabinet, rawPath));
      return output;
    });
  }

  /** Explicit rename/move rebinding; does not move files or create a version. */
  async rebind(id: SourceId, input: SourceLocation): Promise<SourceManifest> {
    opaqueId(id);
    const first = await this.cabinet(true);
    return withRootLock(first.rootPath, async () => {
      const cabinet = await this.cabinet(true);
      const entries = await this.scan(cabinet);
      const entry = entries.find((item) => item.source.id === id);
      if (!entry || entry.source.mode !== "managed") throw new Error("Managed Source not found");
      const managed = location(input);
      await this.validateWorkingFile(cabinet, managed, entry.source.roomPath);
      if (entries.some(({ source }) => source.id !== id && source.mode === "managed" &&
          bindingKey(location(source.managedLocation)) === bindingKey(managed))) throw new Error("Working file is already registered");
      entry.source.managedLocation = managed;
      entry.source.updatedAt = new Date().toISOString();
      const target = await ownedPath(cabinet.rootPath, `${entry.source.rawPath}/manifest.yaml`);
      await writeFileAtomic(target, encodeSourceManifest(entry, cabinet, entry.source.rawPath));
      return entry;
    });
  }

  /** Explicit logical reclassification. An expected prior category prevents a
   * stale decision from replacing a newer one. Never relocates Raw history. */
  async reclassify(id: SourceId, category: string, expectedCategory: string): Promise<SourceManifest> {
    opaqueId(id);
    const classification = classificationPath(category);
    const first = await this.cabinet(true);
    return withRootLock(first.rootPath, async () => {
      const cabinet = await this.cabinet(true);
      const entries = await this.scan(cabinet);
      const entry = entries.find(({ source }) => source.id === id);
      if (!entry) throw new Error("Source not found");
      if (entry.source.status !== "active") throw new Error("Only active Sources can be reclassified");
      const previous = entry.source.classification ?? path.posix.dirname(entry.source.rawPath.slice(cabinet.config.paths.raw.length + 1));
      if (previous !== expectedCategory) throw new Error("Source classification changed; review the new category");
      const known = entries.flatMap(({ source }) => [source.classification,
        path.posix.dirname(source.rawPath.slice(cabinet.config.paths.raw.length + 1))]).filter((value): value is string => !!value);
      entry.source.classification = known.find((value) => value.normalize("NFC").toLowerCase() === classification.normalize("NFC").toLowerCase()) ?? classification;
      entry.source.updatedAt = new Date().toISOString();
      const target = await ownedPath(cabinet.rootPath, `${entry.source.rawPath}/manifest.yaml`);
      await writeFileAtomic(target, encodeSourceManifest(entry, cabinet));
      return entry;
    });
  }
}
