/**
 * Document recovery copies. Lives under
 *   <CABINET_INTERNAL_DIR>/documents/recovery/<sha256(absPath).slice(0,32)>/
 *     manifest.json            { version:1, virtualPath, absPath, entries:[…] }
 *     <sha256hex>.bin          content-addressed blobs (deduped by revision)
 *     draft.bin                single autosave slot per document
 *
 * CABINET_INTERNAL_DIR sits OUTSIDE DATA_DIR — recovery bytes are never in the
 * tree, never served by /api/assets, never indexed.
 *
 * Semantics: before every commitBytes over an existing file, the beforeCommit
 * hook copies the CURRENT on-disk bytes into a blob and records a `previous`
 * entry; the first commit of an open session also records that blob as the
 * session `baseline`. If the copy fails the hook throws `storage`, aborting
 * the commit with the original intact. Entries can be flagged `protected`
 * (commit failed after the copy — the user's pre-failure state is precious).
 * Retention is a byte cap (CABINET_DOC_RECOVERY_MAX_MB, default 512) enforced
 * by evicting oldest entries across documents, outside the commit hot path.
 */
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { CABINET_INTERNAL_DIR } from "../../src/lib/storage/path-utils";
import { DocumentError } from "../../src/lib/documents/errors";
import { revisionOf } from "../../src/lib/documents/revision";
import { maxDocumentBytes } from "./persistence";

const RECOVERY_ROOT = () => path.join(CABINET_INTERNAL_DIR, "documents", "recovery");
const DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RecoveryEntry {
  kind: "baseline" | "previous" | "draft";
  revision: string;
  size: number;
  createdAt: string;
  sessionId?: string;
  protected?: boolean;
  /** Revision the draft was written against (editors' autosave base). */
  baseRevision?: string;
}

interface RecoveryManifest {
  version: 1;
  virtualPath: string;
  absPath: string;
  entries: RecoveryEntry[];
}

function dirFor(absPath: string): string {
  const key = createHash("sha256").update(absPath).digest("hex").slice(0, 32);
  return path.join(RECOVERY_ROOT(), key);
}

function manifestPath(dir: string): string {
  return path.join(dir, "manifest.json");
}

function blobName(revision: string): string {
  return `${revision.replace(/^sha256:/, "")}.bin`;
}

async function readManifest(dir: string): Promise<RecoveryManifest | null> {
  try {
    return JSON.parse(await fs.readFile(manifestPath(dir), "utf-8")) as RecoveryManifest;
  } catch {
    return null;
  }
}

async function writeManifest(dir: string, m: RecoveryManifest): Promise<void> {
  // Plain write — the manifest is bookkeeping; a torn write at worst loses a
  // recovery pointer while the blobs survive. Deliberately avoids fs.rename
  // so it can't be caught up in commit-path rename failures.
  await fs.writeFile(manifestPath(dir), JSON.stringify(m, null, 2), "utf-8");
}

function blobPath(dir: string, revision: string): string {
  return path.join(dir, blobName(revision));
}

/** copyFile + fsync, so the blob is durable BEFORE the commit rename lands. */
async function copyBlob(srcPath: string, destPath: string): Promise<void> {
  await fs.copyFile(srcPath, destPath);
  const h = await fs.open(destPath, "r");
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}

async function removeBlobIfUnreferenced(dir: string, revision: string, m: RecoveryManifest): Promise<void> {
  if (m.entries.some((e) => e.revision === revision)) return;
  await fs.rm(blobPath(dir, revision), { force: true }).catch(() => {});
}

// ── session tracking (fed by the service) ────────────────────────────────────

const openSessions = new Map<string, Map<string, { baselineTaken: boolean }>>();

export function noteSessionOpened(absPath: string, sessionId: string): void {
  let set = openSessions.get(absPath);
  if (!set) openSessions.set(absPath, (set = new Map()));
  set.set(sessionId, { baselineTaken: false });
}

export async function noteSessionClosed(absPath: string, sessionId: string): Promise<void> {
  openSessions.get(absPath)?.delete(sessionId);
  if (openSessions.get(absPath)?.size === 0) openSessions.delete(absPath);
  // Downgrade this session's baseline to a regular evictable entry.
  const dir = dirFor(absPath);
  const m = await readManifest(dir);
  if (m) {
    let changed = false;
    for (const e of m.entries) {
      if (e.kind === "baseline" && e.sessionId === sessionId) {
        delete e.sessionId;
        changed = true;
      }
    }
    if (changed) await writeManifest(dir, m).catch(() => {});
  }
}

// ── commit hooks ─────────────────────────────────────────────────────────────

/**
 * persistence.ts beforeCommit hook. Copies current bytes → blob, records
 * `previous` (+ `baseline` on an open session's first commit). Throws `storage`
 * when the copy cannot be retained — aborting the commit intact.
 */
export async function recoveryBeforeCommit(info: {
  absPath: string;
  tempPath: string;
  currentBytesPath?: string;
}): Promise<void> {
  if (!info.currentBytesPath) return; // create-only commit — nothing to recover
  const { absPath } = info;
  const dir = dirFor(absPath);
  const current = await fs.readFile(info.currentBytesPath);
  const revision = revisionOf(current);
  const manifest: RecoveryManifest = (await readManifest(dir)) ?? {
    version: 1,
    virtualPath: "",
    absPath,
    entries: [],
  };
  manifest.absPath = absPath;

  try {
    await fs.mkdir(dir, { recursive: true });
    const dest = blobPath(dir, revision);
    if (!(await exists(dest))) await copyBlob(info.currentBytesPath, dest);
  } catch {
    throw new DocumentError(
      "storage",
      "Could not retain a recovery copy; use Save a copy or free space",
    );
  }

  const now = new Date().toISOString();
  // Replace the previous `previous` entry (its blob goes away unless shared).
  const oldPrevious = manifest.entries.find((e) => e.kind === "previous");
  manifest.entries = manifest.entries.filter((e) => e.kind !== "previous");
  manifest.entries.push({ kind: "previous", revision, size: current.byteLength, createdAt: now });
  if (oldPrevious) await removeBlobIfUnreferenced(dir, oldPrevious.revision, manifest);

  const sessions = openSessions.get(absPath);
  if (sessions) {
    for (const [sessionId, st] of sessions) {
      if (!st.baselineTaken) {
        st.baselineTaken = true;
        manifest.entries.push({
          kind: "baseline",
          revision,
          size: current.byteLength,
          createdAt: now,
          sessionId,
        });
      }
    }
  }
  await writeManifest(dir, manifest).catch(() => {});
}

/** persistence.ts commitFailed hook — the copy we just took becomes protected. */
export async function recoveryCommitFailed(info: { absPath: string }): Promise<void> {
  const dir = dirFor(info.absPath);
  const m = await readManifest(dir);
  if (!m) return;
  let changed = false;
  for (const e of m.entries) {
    if ((e.kind === "previous" || e.kind === "baseline") && !e.protected) {
      e.protected = true;
      changed = true;
    }
  }
  if (changed) await writeManifest(dir, m).catch(() => {});
}

// ── drafts ───────────────────────────────────────────────────────────────────

export async function saveDraft(input: {
  absPath: string;
  virtualPath: string;
  tempPath: string;
  sessionId?: string;
  baseRevision?: string;
}): Promise<{ revision: string; size: number }> {
  const cap = maxDocumentBytes();
  const stat = await fs.stat(input.tempPath);
  if (stat.size > cap) {
    await fs.rm(input.tempPath, { force: true }).catch(() => {});
    throw new DocumentError("too-large", `Draft exceeds the ${cap}-byte limit`);
  }
  const bytes = await fs.readFile(input.tempPath);
  const revision = revisionOf(bytes);
  const dir = dirFor(input.absPath);
  await fs.mkdir(dir, { recursive: true });
  const draftPath = path.join(dir, "draft.bin");
  const tmp = `${draftPath}.tmp`;
  const stream = createWriteStream(tmp);
  stream.write(bytes);
  await new Promise<void>((resolve, reject) => {
    stream.end((err: Error | null) => (err ? reject(err) : resolve()));
  });
  await fs.rename(tmp, draftPath);
  await fs.rm(input.tempPath, { force: true }).catch(() => {});

  const m: RecoveryManifest = (await readManifest(dir)) ?? {
    version: 1,
    virtualPath: input.virtualPath,
    absPath: input.absPath,
    entries: [],
  };
  m.virtualPath = input.virtualPath;
  m.entries = m.entries.filter((e) => e.kind !== "draft");
  m.entries.push({
    kind: "draft",
    revision,
    size: bytes.byteLength,
    createdAt: new Date().toISOString(),
    sessionId: input.sessionId,
    baseRevision: input.baseRevision,
  });
  await writeManifest(dir, m);
  return { revision, size: bytes.byteLength };
}

export async function clearDraft(absPath: string): Promise<void> {
  const dir = dirFor(absPath);
  await fs.rm(path.join(dir, "draft.bin"), { force: true });
  const m = await readManifest(dir);
  if (m) {
    m.entries = m.entries.filter((e) => e.kind !== "draft");
    await writeManifest(dir, m).catch(() => {});
  }
}

// ── queries ──────────────────────────────────────────────────────────────────

export async function listRecovery(
  absPath: string,
): Promise<{ entries: RecoveryEntry[]; draft?: RecoveryEntry }> {
  const dir = dirFor(absPath);
  const m = await readManifest(dir);
  if (!m) return { entries: [] };
  const draft = m.entries.find((e) => e.kind === "draft");
  return { entries: m.entries.filter((e) => e.kind !== "draft"), draft };
}

export async function readRecoveryBlob(
  absPath: string,
  revision: string,
): Promise<Buffer> {
  const dir = dirFor(absPath);
  const m = await readManifest(dir);
  const entry = m?.entries.find((e) => e.revision === revision);
  const isDraft = m?.entries.some((e) => e.kind === "draft" && e.revision === revision);
  const p = isDraft ? path.join(dir, "draft.bin") : blobPath(dir, revision);
  if (!entry) throw new DocumentError("not-found", "Recovery entry not found");
  try {
    return await fs.readFile(p);
  } catch {
    throw new DocumentError("not-found", "Recovery blob is gone");
  }
}

export async function recoveryUsage(): Promise<{ bytes: number; documents: number }> {
  let bytes = 0;
  let documents = 0;
  try {
    for (const d of await fs.readdir(RECOVERY_ROOT())) {
      const dir = path.join(RECOVERY_ROOT(), d);
      const stat = await fs.stat(dir).catch(() => null);
      if (!stat?.isDirectory()) continue;
      documents++;
      for (const f of await fs.readdir(dir)) {
        if (f.endsWith(".bin")) bytes += (await fs.stat(path.join(dir, f))).size;
      }
    }
  } catch {
    /* no recovery dir yet */
  }
  return { bytes, documents };
}

// ── eviction ─────────────────────────────────────────────────────────────────

export function recoveryMaxBytes(): number {
  const raw = process.env.CABINET_DOC_RECOVERY_MAX_MB;
  const mb = raw ? Number.parseFloat(raw) : Number.NaN;
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : 512 * 1024 * 1024;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Evict oldest entries across all documents while total bytes exceed the cap.
 * Never evicts: entries for paths with an open session, baseline entries of
 * open sessions, drafts younger than 7 days, `protected` entries.
 */
export async function evictIfNeeded(): Promise<void> {
  const cap = recoveryMaxBytes();
  const usage = await recoveryUsage();
  if (usage.bytes <= cap) return;

  interface Cand {
    dir: string;
    manifest: RecoveryManifest;
    entry: RecoveryEntry;
  }
  const candidates: Cand[] = [];
  const root = RECOVERY_ROOT();
  for (const d of await fs.readdir(root).catch(() => [] as string[])) {
    const dir = path.join(root, d);
    const m = await readManifest(dir);
    if (!m) continue;
    const hasOpenSession = openSessions.has(m.absPath);
    for (const e of m.entries) {
      if (e.protected) continue;
      if (hasOpenSession) continue; // any entry for an in-use document
      if (e.kind === "draft" && Date.now() - Date.parse(e.createdAt) < DRAFT_MAX_AGE_MS) continue;
      candidates.push({ dir, manifest: m, entry: e });
    }
  }
  candidates.sort((a, b) => Date.parse(a.entry.createdAt) - Date.parse(b.entry.createdAt));

  for (const c of candidates) {
    if (usage.bytes <= cap) break;
    const fresh = (await readManifest(c.dir)) ?? c.manifest;
    // Match by identity fields, not object reference — the manifest may have
    // been rewritten since candidates were collected.
    const idx = fresh.entries.findIndex(
      (e) => e.kind === c.entry.kind && e.revision === c.entry.revision && e.createdAt === c.entry.createdAt,
    );
    if (idx < 0) continue;
    fresh.entries.splice(idx, 1);
    if (c.entry.kind === "draft") {
      await fs.rm(path.join(c.dir, "draft.bin"), { force: true }).catch(() => {});
    } else {
      await removeBlobIfUnreferenced(c.dir, c.entry.revision, fresh);
    }
    await writeManifest(c.dir, fresh).catch(() => {});
    usage.bytes -= c.entry.size;
  }
}

/** Test hook: reset in-memory session tracking. */
export function resetRecoverySessions(): void {
  openSessions.clear();
}
