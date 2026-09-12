import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";

export function signature(stat: Awaited<ReturnType<typeof fs.stat>>): string {
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
}

/** Hash only stable regular files. Null means changed/cancelled; callers retry. */
export async function stableHash(file: string, expected: string, current: () => boolean): Promise<string | null> {
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw new Error("Input is not a regular file");
    if (initial.size > 500 * 1024 * 1024) throw new Error("File exceeds the 500 MB ingestion limit");
    if (signature(initial) !== expected) return null;
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < initial.size) {
      if (!current()) return null;
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, initial.size - offset), offset);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    if (!current() || offset !== initial.size || signature(await handle.stat()) !== expected ||
        signature(await fs.stat(file)) !== expected) return null;
    return hash.digest("hex");
  } finally { await handle.close(); }
}
