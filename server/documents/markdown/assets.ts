/**
 * Extracted-image sink shared by the markdown converters. Files land in a
 * caller-owned temp dir that is created lazily on the first image (no image →
 * no folder) and returns the relative ref the document embeds.
 */
import fs from "node:fs/promises";
import path from "node:path";

export interface AssetSink {
  /**
   * Write one image; returns the document-relative ref
   * (`<relPrefix>img-01.png`). `name` overrides the generated basename (used
   * for whole-page renders: `page-01.png`).
   */
  add(data: Uint8Array, ext: "png" | "jpg" | "gif" | "webp", name?: string): Promise<string>;
  /** Basenames written so far (service reports them as created paths). */
  readonly files: string[];
}

function pad(n: number): string {
  return String(n).padStart(n >= 100 ? 3 : 2, "0");
}

export function createAssetSink(dir: string, relPrefix: string): AssetSink {
  let counter = 0;
  const files: string[] = [];
  return {
    files,
    async add(data, ext, name) {
      const file = name ?? `img-${pad(++counter)}.${ext}`;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, file), data);
      files.push(file);
      return `${relPrefix}${file}`;
    },
  };
}
