import fs from "node:fs/promises";
import { ownedPath, statOrNull } from "../../src/lib/llm-wiki/filesystem";

/** Sorted recursive listing of files under `relative`, symlinks included as
 * leaf entries so callers can reject them. */
export async function walkWikiFiles(root: string, relative: string, files: string[] = []): Promise<string[]> {
  const target = await ownedPath(root, relative);
  if (!await statOrNull(target)) return files;
  for (const item of (await fs.readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (item.name.startsWith(".")) continue;
    const child = `${relative}/${item.name}`;
    if (item.isSymbolicLink()) { files.push(child); continue; }
    if (item.isDirectory()) await walkWikiFiles(root, child, files);
    else if (item.isFile()) files.push(child);
  }
  return files;
}
