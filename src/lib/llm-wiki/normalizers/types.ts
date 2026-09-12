import type { ConverterProvenance } from "../types";

/** Already captured bytes. Paths are relative to an authorized capture root;
 * normalizers never resolve working paths, read disk, or fetch URLs.
 */
export interface CapturedAsset {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  /** Expected SHA-256 from the capture/queue boundary. */
  readonly contentHash: string;
  readonly assets?: readonly CapturedAsset[];
}

export interface NormalizationWarning {
  readonly code: "unresolved-asset" | "external-reference" | "unsupported-embed" | "conversion";
  readonly message: string;
}

export interface NormalizedAsset extends CapturedAsset {
  /** Safe output path under assets/, relative to the future source.md. */
  readonly path: string;
  readonly contentHash: string;
}

export interface NormalizedSource {
  readonly original: {
    /** Original capture-relative path, retained to resolve original dependencies. */
    readonly path: string;
    readonly filename: string;
    readonly format: string;
    readonly bytes: Uint8Array;
    readonly contentHash: string;
    /** Captured dependencies retain their original capture-relative names. */
    readonly assets: readonly CapturedAsset[];
  };
  /** Ordinary, inert Markdown; includes any original front matter. Not rendered HTML. */
  readonly markdown: string;
  /** Normalized content excluding front matter that was actually parsed. */
  readonly body: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly assets: readonly NormalizedAsset[];
  readonly warnings: readonly NormalizationWarning[];
  readonly converter: ConverterProvenance;
}

export interface SourceNormalizer {
  supports(file: SourceFile): boolean;
  normalize(file: SourceFile): Promise<NormalizedSource>;
}

/** Phase 7 supplies the actual xberg adapter/worker. Conversion must operate on
 * these captured bytes without executing notebook/code inputs. Result asset
 * paths resolve relative to the returned Markdown's virtual source.md.
 */
export interface DocumentConverter {
  convert(file: SourceFile): Promise<DocumentConversionResult>;
}

export interface DocumentConversionResult {
  /** Generated text may start with a Markdown rule, not YAML. Default true. */
  readonly parseFrontMatter?: boolean;
  /** Virtual path used to resolve returned assets; defaults to source.md. */
  readonly markdownPath?: string;
  readonly markdown: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly assets: readonly CapturedAsset[];
  readonly warnings: readonly string[];
  readonly converter: ConverterProvenance;
}
