import path from "node:path";
import yaml from "js-yaml";
import { opaqueId, type WikiCabinet } from "./config";
import { contains, record, relativePath } from "./filesystem";
import type { Source, SourceLocation, SourceVersion, SourceVersionId } from "./types";
import { parseDocumentMetadata } from "./provenance";
import { classificationPath } from "./classification-path";

export interface SourceManifest {
  schemaVersion: 1;
  source: Source;
  versions: readonly SourceVersion[];
}

export function manifestText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Expected nonempty text");
  return value;
}

export function manifestTimestamp(value: unknown): string {
  const result = manifestText(value);
  if (!Number.isFinite(Date.parse(result)) || new Date(result).toISOString() !== result) {
    throw new Error("Expected canonical ISO timestamp");
  }
  return result;
}

export function manifestLocation(value: unknown): SourceLocation {
  const data = record(value);
  const inputPath = relativePath(data.path);
  if (data.kind === "cabinet") return { kind: "cabinet", path: inputPath };
  if (data.kind !== "knowledge-mount") throw new Error("Invalid source location");
  return {
    kind: "knowledge-mount", path: inputPath, mountId: manifestText(data.mountId),
    roomPath: data.roomPath === "." ? "." : relativePath(data.roomPath),
  };
}

function versionPointer(value: unknown): SourceVersionId | null {
  return value === null ? null : opaqueId(value) as SourceVersionId;
}

export function validateBinding(cabinet: WikiCabinet, input: SourceLocation, roomPath: string | null): void {
  if (input.kind === "knowledge-mount") {
    if (input.roomPath !== (roomPath ?? ".")) throw new Error("Mount room mismatch");
    return;
  }
  if (input.path.split("/").some((part) => part.startsWith(".")) ||
      Object.values(cabinet.config.paths).some((layer) => contains(layer, input.path))) {
    throw new Error("Managed inputs cannot be Cabinet state, Inbox, Raw or Wiki");
  }
  if (roomPath !== null && !contains(roomPath, input.path)) throw new Error("Working file is outside its room");
}

export function parseSourceManifest(value: unknown, cabinet: WikiCabinet, rawPath: string): SourceManifest {
  validatePlainManifest(value);
  relativePath(rawPath);
  const data = record(value);
  if (data.schemaVersion !== 1 || !Array.isArray(data.versions)) throw new Error("Invalid source manifest schema");
  const source = record(data.source);
  if (source.cabinetId !== cabinet.cabinetId || source.rawPath !== rawPath) {
    throw new Error("Source manifest ownership/path mismatch");
  }
  opaqueId(source.id);
  if (source.mirroredFrom !== undefined) relativePath(source.mirroredFrom);
  if (!rawPath.startsWith(`${cabinet.config.paths.raw}/`) ||
      (source.mirroredFrom === undefined && rawPath.slice(cabinet.config.paths.raw.length + 1).split("/").length < 2) ||
      (!path.basename(rawPath).endsWith(`-${source.id}`) && !(source.mode === "managed" && typeof source.mirroredFrom === "string" && rawPath === `${cabinet.config.paths.raw}/${source.mirroredFrom.replace(/\.(md|markdown)$/i, "")}`))) throw new Error("Invalid Source directory layout");
  manifestText(source.title);
  if (source.classification !== undefined) classificationPath(source.classification);
  relativePath(source.slug);
  if ((source.slug as string).includes("/")) throw new Error("Invalid source slug");
  if (source.roomPath !== null) relativePath(source.roomPath);
  manifestTimestamp(source.createdAt);
  manifestTimestamp(source.updatedAt);
  if (!["active", "deleted", "archived"].includes(String(source.status))) throw new Error("Invalid source status");
  if (source.status === "deleted") manifestTimestamp(source.deletedAt);
  else if (source.deletedAt !== undefined) throw new Error("Unexpected deletion timestamp");
  if (source.deletionReason !== undefined && (source.status !== "deleted" || !["missing", "user"].includes(String(source.deletionReason)))) throw new Error("Invalid deletion reason");
  if (source.lifecycle !== undefined) {
    const lifecycle = record(source.lifecycle);
    if (!Number.isSafeInteger(lifecycle.revision) || Number(lifecycle.revision) < 1 ||
        !["remove", "restore", "purge"].includes(String(lifecycle.action)) ||
        !["pending", "complete"].includes(String(lifecycle.reconciliation)) ||
        (lifecycle.action === "restore" ? source.status !== "active" : source.status !== "deleted")) throw new Error("Invalid lifecycle state");
  }
  if (source.mode === "managed") validateBinding(cabinet, manifestLocation(source.managedLocation), source.roomPath as string | null);
  else if (source.mode !== "snapshot" || source.managedLocation !== undefined) throw new Error("Invalid source mode");
  const ids = new Set<string>();
  const numbers = new Set<number>();
  let latestVersion = 0;
  for (const item of data.versions) {
    const version = record(item);
    const id = opaqueId(version.id);
    if (ids.has(id) || version.sourceId !== source.id || version.cabinetId !== source.cabinetId) {
      throw new Error("Duplicate or foreign SourceVersion");
    }
    if (!Number.isSafeInteger(version.version) || (version.version as number) < 1 || numbers.has(version.version as number)) {
      throw new Error("Invalid or duplicate version number");
    }
    ids.add(id);
    numbers.add(version.version as number);
    latestVersion = Math.max(latestVersion, version.version as number);
    if (typeof version.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(version.contentHash)) throw new Error("Invalid SHA-256");
    if (typeof version.originalFormat !== "string" || !/^[a-z0-9]+$/.test(version.originalFormat)) throw new Error("Invalid original format");
    const base = `${rawPath}/v${version.version}`;
    if (version.originalPath !== `${base}/original.${version.originalFormat}` ||
        version.markdownPath !== `${base}/source.md` ||
        (version.assetsPath !== undefined && version.assetsPath !== `${base}/assets`)) {
      throw new Error("SourceVersion paths do not match its immutable directory");
    }
    if (version.status !== undefined) throw new Error("Mutable version status belongs in a projection");
    manifestTimestamp(version.createdAt);
    if (version.converter !== undefined) {
      const converter = record(version.converter);
      manifestText(converter.name);
      manifestText(converter.version);
    }
    if (version.document !== undefined) {
      parseDocumentMetadata(version.document, version.originalFormat as string);
      if (version.converter === undefined) throw new Error("Document provenance requires converter metadata");
    }
  }
  const current = versionPointer(source.currentVersionId);
  const compiled = versionPointer(source.lastCompiledVersionId);
  if ((current !== null && !ids.has(current)) || (compiled !== null && !ids.has(compiled)) ||
      (ids.size > 0 && current === null)) throw new Error("Invalid source version pointer");
  if (current !== null && record(data.versions.find((item) => record(item).id === current)).version !== latestVersion) {
    throw new Error("Current version must be the latest captured version");
  }
  // Preserve unknown metadata on read/rebind for forward-compatible round trips.
  return data as unknown as SourceManifest;
}

const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

/** Preserve bounded plain extension metadata without admitting cycles/tags.
 * This limit allows long version histories; document metadata itself stays small.
 */
function validatePlainManifest(value: unknown): void {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 500000 || depth > 32) throw new Error("Manifest exceeds structural limits");
    if (item === null || typeof item === "string" || typeof item === "boolean") return;
    if (typeof item === "number" && Number.isFinite(item)) return;
    if (!item || typeof item !== "object" || ancestors.has(item)) throw new Error("Invalid or cyclic manifest metadata");
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new Error("Manifest metadata must be plain values");
    ancestors.add(item);
    for (const child of Object.values(item)) visit(child, depth + 1);
    ancestors.delete(item);
  };
  visit(value, 0);
}

export function decodeSourceManifest(markdown: string, cabinet: WikiCabinet, rawPath: string): SourceManifest {
  if (Buffer.byteLength(markdown) > MAX_MANIFEST_BYTES) throw new Error("Manifest exceeds size limit");
  return parseSourceManifest(yaml.load(markdown, { schema: yaml.JSON_SCHEMA }), cabinet, rawPath);
}

export function encodeSourceManifest(manifest: SourceManifest, cabinet: WikiCabinet, rawPath = manifest.source.rawPath): string {
  parseSourceManifest(manifest, cabinet, rawPath);
  const serialized = yaml.dump(manifest, { schema: yaml.JSON_SCHEMA, lineWidth: -1, noRefs: true });
  if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) throw new Error("Manifest exceeds size limit");
  return serialized;
}
