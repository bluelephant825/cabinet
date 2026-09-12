import path from "node:path";
import { relativePath } from "../filesystem";
import { copyAssets, MAX_MARKDOWN_BYTES, normalizeMarkdown, sha256, validateMetadata } from "./markdown";
import type { DocumentConverter, NormalizedSource, SourceFile, SourceNormalizer } from "./types";
export type * from "./types";

const MARKDOWN = new Set(["md", "markdown"]);
export const CONVERSION_FORMATS = ["html", "htm", "pdf", "doc", "docx", "odt", "ppt", "pptx", "tex", "latex", "typ", "typst", "ipynb"] as const;
const CONVERTED = new Set<string>(CONVERSION_FORMATS);
const format = (file: SourceFile) => path.posix.extname(file.path).slice(1).toLowerCase();

function capture(file: SourceFile): SourceFile {
  relativePath(file.path);
  if (!(file.bytes instanceof Uint8Array) || file.bytes.byteLength > 500 * 1024 * 1024) throw new Error("Original exceeds the 500 MB limit or has invalid bytes");
  const bytes = Uint8Array.from(file.bytes);
  if (!/^[a-f0-9]{64}$/.test(file.contentHash) || sha256(bytes) !== file.contentHash) throw new Error("Captured original hash mismatch");
  return { path: file.path, bytes, contentHash: file.contentHash, assets: copyAssets(file.assets ?? []) };
}

function original(file: SourceFile): NormalizedSource["original"] {
  return { path: file.path, filename: path.posix.basename(file.path), format: format(file), bytes: file.bytes,
    contentHash: file.contentHash, assets: file.assets ?? [] };
}

export class MarkdownNormalizer implements SourceNormalizer {
  supports(file: SourceFile): boolean { return MARKDOWN.has(format(file)); }

  async normalize(input: SourceFile): Promise<NormalizedSource> {
    if (!this.supports(input)) throw new Error("Unsupported Markdown format");
    if (input.bytes.byteLength > MAX_MARKDOWN_BYTES) throw new Error("Markdown exceeds the 20 MB limit");
    const file = capture(input);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    return { original: original(file), ...normalizeMarkdown(text, file.path, file.assets!),
      converter: { name: "cabinet-markdown", version: "1" } };
  }
}

export class DocumentNormalizer implements SourceNormalizer {
  constructor(private readonly converter?: DocumentConverter) {}
  supports(file: SourceFile): boolean { return CONVERTED.has(format(file)); }

  async normalize(input: SourceFile): Promise<NormalizedSource> {
    if (!this.supports(input)) throw new Error("Unsupported document format");
    if (!this.converter) throw new Error("Document converter unavailable: configure the xberg adapter");
    const file = capture(input);
    // Keep evidence separate even if an adapter mutates its input buffers.
    const result = await this.converter.convert({ ...file, bytes: Uint8Array.from(file.bytes), assets: copyAssets(file.assets!) });
    if (!result.converter || typeof result.converter.name !== "string" || !result.converter.name.trim() ||
        typeof result.converter.version !== "string" || !result.converter.version.trim()) throw new Error("Converter name and version are required");
    validateMetadata(result.metadata);
    if (!Array.isArray(result.warnings) || result.warnings.some((warning) => typeof warning !== "string")) throw new Error("Invalid converter warnings");
    const normalized = normalizeMarkdown(result.markdown, relativePath(result.markdownPath ?? "source.md"),
      copyAssets(result.assets), result.parseFrontMatter ?? true);
    return { original: original(file), ...normalized,
      metadata: { ...structuredClone(result.metadata), ...normalized.metadata },
      converter: { ...result.converter },
      warnings: [...result.warnings.map((message) => ({ code: "conversion" as const, message })), ...normalized.warnings] };
  }
}

/** Explicit dependency injection; constructing this service starts no workers. */
export class SourceNormalizationService implements SourceNormalizer {
  private readonly normalizers: readonly SourceNormalizer[];
  constructor(converter?: DocumentConverter) {
    this.normalizers = [new MarkdownNormalizer(), new DocumentNormalizer(converter)];
  }
  supports(file: SourceFile): boolean { return this.normalizers.some((normalizer) => normalizer.supports(file)); }
  async normalize(file: SourceFile): Promise<NormalizedSource> {
    const normalizer = this.normalizers.find((item) => item.supports(file));
    if (!normalizer) throw new Error(`Unsupported source format: ${format(file) || "(none)"}`);
    return normalizer.normalize(file);
  }
}
