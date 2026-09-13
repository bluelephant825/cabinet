import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import JSZip from "jszip";
import { revisionOf } from "../../src/lib/documents/revision";
import { DocumentError } from "../../src/lib/documents/errors";

/**
 * Binary-safe document persistence. Every document write flows through
 * `commitBytes`: validate → temp file in the SAME directory → fsync → atomic
 * rename. Never a string/UTF-8 write — that is the corruption bug this module
 * exists to prevent.
 */

export const DEFAULT_MAX_DOC_BYTES = 200 * 1024 * 1024;

export function maxDocumentBytes(): number {
  const raw = process.env.CABINET_DOC_MAX_BYTES;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_DOC_BYTES;
}

/**
 * Step 3 seam: invoked after the temp file is fully written + fsynced, BEFORE
 * the atomic rename over the target. Recovery copies/history snapshots hook in
 * here. Throwing aborts the commit (temp is removed, original untouched).
 */
export type BeforeCommitHook = (info: {
  absPath: string;
  /** Path of the staged temp file holding the new bytes. */
  tempPath: string;
  /** Path of the current target bytes, when the file already exists. */
  currentBytesPath?: string;
}) => Promise<void>;

let beforeCommitHook: BeforeCommitHook = async () => {};
let commitFailedHook: (info: { absPath: string }) => Promise<void> = async () => {};

export function setBeforeCommitHook(hook: BeforeCommitHook): void {
  beforeCommitHook = hook;
}

/** Invoked when the commit fails AFTER beforeCommit ran (e.g. rename threw). */
export function setCommitFailedHook(hook: (info: { absPath: string }) => Promise<void>): void {
  commitFailedHook = hook;
}

export interface CommitBytesInput {
  absPath: string;
  /** New document bytes in memory… */
  bytes?: Uint8Array;
  /** …or already staged in a temp file (must be on the same filesystem). */
  tempPath?: string;
  /**
   * `null` → create-only (file must not exist). Otherwise the stored revision
   * must equal this value, else `conflict`.
   */
  expectedRevision: string | null;
  maxBytes?: number;
}

export interface CommitResult {
  revision: string;
  size: number;
}

async function validateSignature(absPath: string, bytes: Uint8Array): Promise<void> {
  const ext = path.extname(absPath).toLowerCase();
  if (ext === ".pdf") {
    if (bytes.length < 5 || Buffer.from(bytes.subarray(0, 5)).toString("latin1") !== "%PDF-") {
      throw new DocumentError("invalid", "File does not start with a PDF signature");
    }
    return;
  }
  if (ext === ".docx") {
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 0x03 || bytes[3] !== 0x04) {
      throw new DocumentError("invalid", "File is not a ZIP container (missing PK signature)");
    }
    try {
      const zip = await JSZip.loadAsync(bytes);
      if (!zip.file("[Content_Types].xml")) {
        throw new DocumentError("invalid", "ZIP container lacks [Content_Types].xml — not a DOCX");
      }
    } catch (err) {
      if (err instanceof DocumentError) throw err;
      throw new DocumentError("invalid", "File is not a readable DOCX package");
    }
    return;
  }
  throw new DocumentError("unsupported", `Unsupported document format '${ext}'`);
}

export async function readWithRevision(
  absPath: string,
): Promise<{ bytes: Buffer; revision: string }> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(absPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new DocumentError("not-found", "Document does not exist");
    }
    throw err;
  }
  return { bytes, revision: revisionOf(bytes) };
}

function siblingTempPath(absPath: string): string {
  const dir = path.dirname(absPath);
  const name = path.basename(absPath);
  return path.join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
}

/** A sibling temp path the caller stages bytes into before `commitBytes`. */
export function stageTempPathFor(absPath: string): string {
  return siblingTempPath(absPath);
}

async function removeQuiet(p: string): Promise<void> {
  try {
    await fs.rm(p, { force: true });
  } catch {
    // already gone
  }
}

export async function commitBytes(input: CommitBytesInput): Promise<CommitResult> {
  const { absPath, expectedRevision } = input;
  const maxBytes = input.maxBytes ?? maxDocumentBytes();
  if (!input.bytes && !input.tempPath) {
    throw new DocumentError("invalid", "commitBytes requires bytes or tempPath");
  }

  // Size check (stat for tempPath input so we never buffer it all).
  let size: number;
  if (input.tempPath) {
    size = (await fs.stat(input.tempPath)).size;
  } else {
    size = input.bytes!.byteLength;
  }
  if (size > maxBytes) {
    if (input.tempPath) await removeQuiet(input.tempPath);
    throw new DocumentError("too-large", `Document exceeds the ${maxBytes}-byte limit`);
  }

  const bytes = input.bytes ? Buffer.from(input.bytes) : await fs.readFile(input.tempPath!);
  await validateSignature(absPath, bytes);

  // Revision gate against the CURRENT on-disk bytes.
  const exists = await fileExistsPath(absPath);
  if (expectedRevision === null) {
    if (exists) {
      if (input.tempPath) await removeQuiet(input.tempPath);
      const current = await readWithRevision(absPath);
      throw new DocumentError("conflict", "Document already exists", {
        currentRevision: current.revision,
      });
    }
  } else {
    if (!exists) {
      if (input.tempPath) await removeQuiet(input.tempPath);
      throw new DocumentError("not-found", "Document does not exist");
    }
    const current = await readWithRevision(absPath);
    if (current.revision !== expectedRevision) {
      if (input.tempPath) await removeQuiet(input.tempPath);
      throw new DocumentError("conflict", "Document changed since the supplied revision", {
        currentRevision: current.revision,
      });
    }
  }

  const tempPath = siblingTempPath(absPath);
  const cleanup: string[] = [tempPath];
  if (input.tempPath) cleanup.push(input.tempPath);
  try {
    if (input.tempPath) {
      // copyFile+unlink keeps the atomic-rename target in the same directory
      // even if the caller's temp lived elsewhere.
      await fs.copyFile(input.tempPath, tempPath);
    } else {
      await fs.writeFile(tempPath, bytes);
    }
    const handle = await fs.open(tempPath, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    let beforeCommitRan = false;
    try {
      await beforeCommitHook({
        absPath,
        tempPath,
        currentBytesPath: exists ? absPath : undefined,
      });
      beforeCommitRan = true;
      await fs.rename(tempPath, absPath);
    } catch (err) {
      if (beforeCommitRan) await commitFailedHook({ absPath }).catch(() => {});
      throw err;
    }
  } catch (err) {
    await Promise.all(cleanup.map(removeQuiet));
    throw err;
  }
  if (input.tempPath) await removeQuiet(input.tempPath);
  return { revision: revisionOf(bytes), size: bytes.byteLength };
}

async function fileExistsPath(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
