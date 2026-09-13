/**
 * OCR provider contract for PDF→DOCX conversion.
 *
 * Providers are platform-specific recognizers (macOS Vision helper binary,
 * Windows.Media.Ocr helper, a future Tesseract/lilbee backend) selected by
 * server/documents/ocr/registry.ts. The contract is async — providers run
 * OUTSIDE the synchronous PDFium document scope: the worker pre-renders
 * scanned pages to PNG files, awaits recognize() per page, then feeds the
 * results into the vendored pipeline through a synchronous OcrEngine shim
 * (see server/documents/worker-ops.ts convertOp).
 *
 * This file is dependency-free so both the daemon and worker can import it.
 */

/** A normalized rectangle, origin bottom-left, y up — PDF page space. */
export type OcrBounds = [x0: number, y0: number, x1: number, y1: number];

export interface OcrWordResult {
  text: string;
  confidence: number;
  bounds: OcrBounds;
}

export interface OcrLineResult {
  text: string;
  /** engine confidence, 0–1 */
  confidence: number;
  /** normalized box (0–1 of page size, origin bottom-left, y up) */
  bounds: OcrBounds;
  words?: OcrWordResult[];
}

export interface OcrRecognitionResult {
  lines: OcrLineResult[];
  /**
   * Near-white pixel share of the page render (0–1) when the engine can
   * measure it — the upstream photo-vs-scan gate uses it.
   */
  paperShare?: number;
  engine: { id: string; version: string };
}

export interface OcrCapabilities {
  available: boolean;
  reason?: string;
  /** BCP-47 tags the provider can recognize (empty = auto-detect only). */
  languages: string[];
}

export interface OcrProvider {
  id: string;
  version: string;
  capabilities(): Promise<OcrCapabilities>;
  recognize(input: {
    /** PNG-rendered page on disk (the worker owns the temp file). */
    imagePath: string;
    /** Page dimensions in PDF points. */
    width: number;
    height: number;
    languageHints?: string[];
    /** Per-page wall-clock cap; on timeout the provider must reject/return null. */
    timeoutMs: number;
  }): Promise<OcrRecognitionResult | null>;
}
