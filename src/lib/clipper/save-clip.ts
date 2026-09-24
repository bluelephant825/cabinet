/**
 * Saves a clipped markdown document as a cabinet page: parses frontmatter,
 * uniquifies the target path, writes via the normal page I/O path (so the
 * sibling/index convention applies), then refreshes the tree and commits.
 */

import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { resolveContentPath } from "@/lib/storage/path-utils";
import { writePage } from "@/lib/storage/page-io";
import { invalidateTreeCache } from "@/lib/storage/tree-builder";
import { autoCommit } from "@/lib/git/git-service";
import { assertWritablePath } from "@/lib/knowledge-sources/store";
import { storageOverCap } from "@/lib/cloud/tier";

export class StorageFullError extends Error {
  readonly errorKind = "storage";
  constructor() {
    super("Storage full: the free plan is capped. Upgrade for more room.");
  }
}

async function pathExists(fsPath: string): Promise<boolean> {
  try {
    await fs.stat(fsPath);
    return true;
  } catch {
    return false;
  }
}

async function pageExists(virtualPath: string): Promise<boolean> {
  const resolved = resolveContentPath(virtualPath);
  return (
    (await pathExists(`${resolved}.md`)) ||
    (await pathExists(`${resolved}.mdx`)) ||
    (await pathExists(path.join(resolved, "index.md")))
  );
}

/** `Name`, else `Name 1`, `Name 2`, ... until nothing occupies the path. */
export async function uniquePagePath(virtualPath: string): Promise<string> {
  if (!(await pageExists(virtualPath))) return virtualPath;
  for (let i = 1; ; i++) {
    const candidate = `${virtualPath} ${i}`;
    if (!(await pageExists(candidate))) return candidate;
  }
}

export async function saveClip(input: {
  file: string;
  markdown: string;
}): Promise<{ path: string; title: string }> {
  const { data, content } = matter(input.markdown);
  const title =
    typeof data.title === "string" && data.title.trim()
      ? data.title
      : path.posix.basename(input.file);
  const frontmatter = {
    ...data,
    title,
    created: data.created ?? new Date().toISOString(),
  };
  await assertWritablePath(input.file);
  if (await storageOverCap()) throw new StorageFullError();
  const target = await uniquePagePath(input.file);
  await writePage(target, content, frontmatter);
  invalidateTreeCache();
  autoCommit(target, "Add");
  return { path: target, title };
}
