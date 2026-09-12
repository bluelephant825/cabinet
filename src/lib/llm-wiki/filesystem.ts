import fs from "node:fs/promises";
import path from "node:path";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected an object");
  }
  return value as Record<string, unknown>;
}

export function relativePath(value: unknown): string {
  if (typeof value !== "string" || !value || /[\\:<>"|?*\x00-\x1f]/.test(value) ||
      value.split("/").some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part))) {
    throw new Error("Expected a safe relative path");
  }
  return value;
}

export function contains(parent: string, child: string): boolean {
  // Conservative across case-insensitive macOS/Windows filesystems. Generated
  // layer aliases must not bypass ownership checks by changing letter case.
  const base = parent.normalize("NFC").toLowerCase();
  const candidate = child.normalize("NFC").toLowerCase();
  return candidate === base || candidate.startsWith(`${base}/`);
}

export async function statOrNull(target: string) {
  try { return await fs.lstat(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Fail closed on symlinks, including dangling links and intermediate components.
 * The root itself must be canonicalized by the caller. This is an application
 * boundary, not protection against a hostile OS process swapping paths mid-I/O.
 */
export async function ownedPath(root: string, relative: string): Promise<string> {
  relativePath(relative);
  let cursor = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    const stat = await statOrNull(cursor);
    if (!stat) continue;
    if (stat.isSymbolicLink()) throw new Error(`Symlink is not permitted: ${relative}`);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw new Error(`Not a directory: ${relative}`);
    }
  }
  return cursor;
}

/** Advisory cross-process lock; never steal a possibly live writer's lock. */
export async function withRootLock<T>(root: string, work: () => Promise<T>): Promise<T> {
  const lockPath = await ownedPath(root, ".llm-wiki.lock");
  let handle;
  try { handle = await fs.open(lockPath, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error("LLM Wiki store is locked; if a writer crashed, inspect .llm-wiki.lock before removing it");
    }
    throw error;
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    return await work();
  } finally {
    await handle.close();
    await fs.unlink(lockPath);
  }
}
