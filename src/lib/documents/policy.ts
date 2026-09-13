import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, resolveContentPath } from "@/lib/storage/path-utils";
import { fileExists } from "@/lib/storage/fs-operations";
import { decodeDrivePath } from "@/lib/google-drive/paths";
import {
  resolveAuthorizedMountPaths,
  readKnowledgeSources,
  assertWritablePath,
  ReadOnlySourceError,
} from "@/lib/knowledge-sources/store";
import { storageOverCap } from "@/lib/cloud/tier";
import { ROOT_CABINET_PATH, normalizeCabinetPath } from "@/lib/cabinets/paths";
import { DocumentError } from "./errors";
import type { DocumentFormat } from "./types";

export interface AuthorizedDocumentPath {
  virtualPath: string;
  absPath: string;
  format: DocumentFormat;
  readOnlyReason?: string;
}

const GDRIVE_READ_ONLY_REASON = "Connected cloud source is read-only";

const BINARY_DOCUMENT_CONTENT_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/zip",
]);

/**
 * Should a /api/assets PUT body be rejected as a binary document write?
 * True for .docx/.pdf targets regardless of declared type, or for bodies that
 * declare a binary document/container content type. Text-ish saves
 * (image/svg+xml, text/*, application/json, application/xml, missing) pass
 * through unchanged.
 */
export function isBinaryDocumentWrite(ext: string, contentType: string | null): boolean {
  if (ext === ".docx" || ext === ".pdf") return true;
  const ct = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  if (!ct) return false;
  return (
    BINARY_DOCUMENT_CONTENT_TYPES.has(ct) ||
    ct.startsWith("application/vnd.openxmlformats-officedocument")
  );
}

function formatForPath(absPath: string): DocumentFormat {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".docx") return "docx";
  if (ext === ".pdf") return "pdf";
  throw new DocumentError(
    "unsupported",
    `Unsupported document format '${ext || "(none)"}' — only .docx and .pdf are supported`,
  );
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

async function realpathSafe(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * Resolves the canonical (symlink-resolved) path for an existing file, or for a
 * not-yet-created file: realpath of the nearest existing ancestor plus the
 * remaining suffix. Catches symlink escapes even when the leaf doesn't exist.
 */
async function canonicalPath(resolved: string): Promise<string> {
  let dir = resolved;
  const suffix: string[] = [];
  // Walk up until an existing directory is found.
  for (;;) {
    const real = await realpathSafe(dir);
    if (real !== null) {
      const stat = await fs.stat(real).catch(() => null);
      if (stat?.isDirectory()) {
        return path.join(real, ...suffix.reverse());
      }
      if (suffix.length === 0) return real; // existing file
      // Existing non-dir with a suffix beneath it — invalid, but keep the
      // canonical form so the caller fails cleanly downstream.
      return path.join(real, ...suffix.reverse());
    }
    suffix.push(path.basename(dir));
    const parent = path.dirname(dir);
    if (parent === dir) return dir; // filesystem root — give up
    dir = parent;
  }
}

/**
 * Outside-DATA_DIR realpaths that are still legitimate: registered "browser"
 * mounts (resolveAuthorizedMountPaths) and "inline" source roots (their
 * symlinks live inside DATA_DIR but point at the provider's real folder).
 */
async function authorizedOutsideRoots(cabinetPath: string): Promise<string[]> {
  const cabinet = normalizeCabinetPath(cabinetPath, true) || ROOT_CABINET_PATH;
  const roots: string[] = [];
  try {
    roots.push(...(await resolveAuthorizedMountPaths(cabinet)));
  } catch {
    // mount table unreadable — treat as none
  }
  try {
    for (const source of await readKnowledgeSources(cabinet)) {
      if (source.enabled && source.surface === "inline" && source.absPath) {
        roots.push(source.absPath);
      }
    }
  } catch {
    // sources file unreadable — treat as none
  }
  const real: string[] = [];
  for (const root of roots) {
    const r = await realpathSafe(root);
    if (r) real.push(r);
  }
  return real;
}

/**
 * Authorize a document path for reading or writing.
 *
 * - `virtualPath` is a cabinet tree path (e.g. "docs/report.docx") or a
 *   Drive-encoded `gdrive:<id>/<name>` path (always read-only).
 * - Traversal (`..`) → `unauthorized`.
 * - Symlinks must resolve inside `realpath(DATA_DIR)` or inside a registered
 *   mount/inline-source root → otherwise `unauthorized`.
 * - Only `.docx` / `.pdf` (case-insensitive) → else `unsupported`.
 * - `write: true` additionally enforces read-only source policy
 *   (`assertWritablePath` → `read-only`) and storage cap
 *   (`storageOverCap` → `storage`, HTTP 402).
 */
export async function authorizeDocumentPath(
  virtualPath: string,
  opts: { write: boolean; cabinetPath?: string },
): Promise<AuthorizedDocumentPath> {
  if (!virtualPath || typeof virtualPath !== "string") {
    throw new DocumentError("invalid", "Missing document path");
  }
  const cabinetPath = normalizeCabinetPath(opts.cabinetPath ?? ROOT_CABINET_PATH, true) || ROOT_CABINET_PATH;
  const format = formatForPath(virtualPath);

  const driveTarget = decodeDrivePath(virtualPath);
  if (driveTarget) {
    // gdrive:-encoded paths address connected "browser" mounts: readable when
    // the real path sits inside an authorized mount, never writable.
    const real = await realpathSafe(driveTarget);
    if (!real || !(await fileExists(real))) {
      throw new DocumentError("not-found", `Document not found: ${virtualPath}`);
    }
    const mounts = await resolveAuthorizedMountPaths(cabinetPath).catch(() => [] as string[]);
    let allowed = false;
    for (const mount of mounts) {
      const mReal = await realpathSafe(mount);
      if (mReal && isInside(real, mReal)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      throw new DocumentError("unauthorized", `Document is outside authorized mounts: ${virtualPath}`);
    }
    if (opts.write) {
      throw new DocumentError("read-only", GDRIVE_READ_ONLY_REASON);
    }
    return { virtualPath, absPath: real, format, readOnlyReason: GDRIVE_READ_ONLY_REASON };
  }

  return authorizeFsPath(virtualPath, opts, format) as Promise<AuthorizedDocumentPath>;
}

/**
 * Same policy as authorizeDocumentPath but without the .docx/.pdf format gate —
 * used for `.pdf.source.json` composition sources and their referenced assets,
 * which are arbitrary text/media files inside the same authorized roots.
 */
export async function authorizeCompositionPath(
  virtualPath: string,
  opts: { write: boolean; cabinetPath?: string },
): Promise<Omit<AuthorizedDocumentPath, "format">> {
  if (!virtualPath || typeof virtualPath !== "string") {
    throw new DocumentError("invalid", "Missing document path");
  }
  if (decodeDrivePath(virtualPath)) {
    throw new DocumentError("read-only", GDRIVE_READ_ONLY_REASON);
  }
  return authorizeFsPath(virtualPath, opts, undefined);
}

async function authorizeFsPath(
  virtualPath: string,
  opts: { write: boolean; cabinetPath?: string },
  format?: DocumentFormat,
): Promise<Omit<AuthorizedDocumentPath, "format"> & { format?: DocumentFormat }> {
  const cabinetPath = normalizeCabinetPath(opts.cabinetPath ?? ROOT_CABINET_PATH, true) || ROOT_CABINET_PATH;
  let resolved: string;
  try {
    resolved = resolveContentPath(virtualPath);
  } catch {
    throw new DocumentError("unauthorized", `Path is not allowed: ${virtualPath}`);
  }

  const real = await canonicalPath(resolved);
  const dataRoot = (await realpathSafe(DATA_DIR)) ?? path.resolve(DATA_DIR);
  if (!isInside(real, dataRoot)) {
    const outside = await authorizedOutsideRoots(cabinetPath);
    if (!outside.some((root) => isInside(real, root))) {
      throw new DocumentError("unauthorized", `Document path escapes the data directory: ${virtualPath}`);
    }
  }

  if (opts.write) {
    try {
      await assertWritablePath(virtualPath);
    } catch (err) {
      if (err instanceof ReadOnlySourceError) {
        throw new DocumentError("read-only", `Source is read-only: ${virtualPath}`);
      }
      throw err;
    }
    if (await storageOverCap()) {
      throw new DocumentError("storage", "Storage limit reached — free space or raise the limit before saving");
    }
  } else {
    let readOnlyReason: string | undefined;
    try {
      await assertWritablePath(virtualPath);
    } catch (err) {
      if (err instanceof ReadOnlySourceError) {
        readOnlyReason = `Source is read-only: ${virtualPath}`;
      } else {
        throw err;
      }
    }
    return { virtualPath, absPath: real, format, readOnlyReason };
  }

  return { virtualPath, absPath: real, format };
}
