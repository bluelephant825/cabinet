import fs from "node:fs/promises";
import path from "node:path";
import { readWikiCabinet } from "./config";
import { contains, statOrNull } from "./filesystem";
/** Generic mutations cannot write Raw or move/delete an ancestor containing it.
 * Check both lexical paths and aliases through existing symlink components. */
export async function isProtectedRawPath(root: string, virtual: string): Promise<boolean> {
  if (!await statOrNull(path.join(root, ".cabinet"))) {
    if (await statOrNull(path.join(root, ".cabinet-state/llm-wiki"))) throw new Error("Raw ownership metadata is missing; review required");
    return false;
  }
  const cabinet = await readWikiCabinet(root);
  if (!cabinet) {
    if (await statOrNull(path.join(root, ".cabinet-state/llm-wiki"))) throw new Error("Raw ownership metadata is missing; review required");
    return false;
  }
  const target = path.resolve(cabinet.rootPath, virtual);
  const relative = path.relative(cabinet.rootPath, target).split(path.sep).join("/");
  if (!relative || relative.startsWith("../")) return false;
  const protects = (name: string) => contains(cabinet.config.paths.raw, name) || contains(name, cabinet.config.paths.raw);
  if (protects(relative)) return true;
  let cursor = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const resolved = path.join(await fs.realpath(cursor), ...missing);
      return protects(path.relative(cabinet.rootPath, resolved).split(path.sep).join("/"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (cursor === path.dirname(cursor)) return false;
      missing.unshift(path.basename(cursor)); cursor = path.dirname(cursor);
    }
  }
}
