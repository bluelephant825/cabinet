import type { DocumentErrorCode } from "./errors";

/**
 * Wire contracts shared between the daemon document service, the Next.js API
 * proxy routes, and (later) editor UI + agent tools. Everything here is plain
 * JSON-serializable data — document bytes NEVER travel through these payloads
 * (they go through temp files / streaming bodies).
 *
 * The PDF op shapes below intentionally mirror the vendored GenOffice
 * `TextEditInput` / `ImageEditInput` unions so the worker layer can pass them
 * straight through, while keeping this module free of vendor imports.
 */

export type DocumentFormat = "docx" | "pdf";

export type DocumentActor =
  | { kind: "user" }
  | { kind: "agent"; id: string; runId?: string };

export interface OpenRequest {
  virtualPath: string;
  actor?: DocumentActor;
}

export interface OpenResult {
  sessionId: string;
  virtualPath: string;
  format: DocumentFormat;
  revision: string;
  size: number;
  capabilities: { edit: boolean; convert: boolean };
  readOnlyReason?: string;
}

export type DocxParagraph = {
  /** Stable identity for patches — currently `p<docxIndex>` (see worker-ops). */
  id: string;
  index: number;
  text: string;
  style?: string;
  kind: string;
};

export interface DocxInspectResult {
  format: "docx";
  paragraphs: DocxParagraph[];
  images: number;
  tables: number;
  truncated?: boolean;
}

export interface PdfTextLine {
  /** Stable within one inspection: `p<pageIndex>l<lineIndex>`. */
  id: string;
  text: string;
  bounds: [number, number, number, number];
}

export interface PdfPageInspect {
  index: number;
  width: number;
  height: number;
  rotation: number;
  textLines: PdfTextLine[];
  imageCount: number;
}

export interface PdfInspectResult {
  format: "pdf";
  pageCount: number;
  pages: PdfPageInspect[];
  truncated?: boolean;
}

export type InspectResult = DocxInspectResult | PdfInspectResult;

export interface InspectRequest {
  sessionId?: string;
  virtualPath?: string;
}

export interface ReadRequest {
  sessionId?: string;
  virtualPath?: string;
  page?: number;
  paragraphRange?: [number, number];
}

export interface ReadResult {
  text: string;
}

export interface SearchRequest {
  sessionId?: string;
  virtualPath?: string;
  query: string;
}

export interface SearchMatch {
  id: string;
  page?: number;
  snippet: string;
  bounds?: [number, number, number, number];
}

export interface SearchResult {
  matches: SearchMatch[];
}

export type Rect4 = [number, number, number, number];
export type Rgb = [number, number, number];

/** Mirrors vendored `TextEditInput` (apps/pdf/shared/ipc.ts). */
export interface PdfTextEdit {
  pageIndex: number;
  rect: Rect4;
  oldText: string;
  newText: string;
  fontSize: number;
  newFontSize?: number;
  newColor?: Rgb;
  colorRuns?: { start: number; end: number; color: Rgb }[];
  styleRuns?: {
    start: number;
    end: number;
    color?: Rgb;
    font?: string;
    size?: number;
    bold?: boolean;
    italic?: boolean;
  }[];
  newFont?: string;
}

export type PdfImageLayer = "belowText" | "aboveText";

/** Mirrors vendored `ImageEditInput` (apps/pdf/shared/ipc.ts). */
export type PdfImageEdit =
  | { kind: "insertImage"; pageIndex: number; image: string; rect: Rect4; layer: PdfImageLayer; rotate?: number }
  | {
      kind: "transformImage";
      pageIndex: number;
      oldRect: Rect4;
      rect: Rect4;
      layer?: PdfImageLayer;
      quarterTurns?: number;
    }
  | {
      kind: "replaceImage";
      pageIndex: number;
      oldRect: Rect4;
      rect: Rect4;
      image: string;
      layer?: PdfImageLayer;
      quarterTurns?: number;
    }
  | { kind: "deleteImage"; pageIndex: number; oldRect: Rect4 };

export type DocumentPatchOp =
  | {
      kind: "replaceParagraphText";
      /** DocxParagraph.id from inspect (currently `p<docxIndex>`). */
      paragraphId: string;
      expectedText: string;
      newText: string;
    }
  | { kind: "pdfTextEdit"; edit: PdfTextEdit }
  | { kind: "pdfImageOp"; op: PdfImageEdit };

export interface PatchDiagnostic {
  index: number;
  code: string;
  message: string;
}

export interface PatchRequest {
  sessionId: string;
  baseRevision: string;
  ops: DocumentPatchOp[];
  actor?: DocumentActor;
}

export interface PatchResult {
  revision: string;
  applied: number;
  diagnostics: PatchDiagnostic[];
  /** The mutated file — the request carries only sessionId, so the response
      reports it back for callers that need to attribute the change. */
  virtualPath: string;
}

export interface SaveCopyRequest {
  virtualPath: string;
  destinationVirtualPath: string;
  baseRevision: string;
  actor?: DocumentActor;
}

export interface SaveCopyResult {
  virtualPath: string;
  revision: string;
  size: number;
}

export interface ConvertRequest {
  virtualPath: string;
  baseRevision: string;
  destinationVirtualPath?: string;
  actor?: DocumentActor;
}

export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";

export interface JobResult {
  virtualPath?: string;
  revision?: string;
  size?: number;
  pageCount?: number;
  scannedDocument?: boolean;
  warnings?: string[];
  /** Set once the Next route has recorded the history mutation for this job. */
  mutationRecorded?: boolean;
}

export interface JobInfo {
  jobId: string;
  kind: string;
  status: JobStatus;
  progress?: number;
  result?: JobResult;
  error?: { code: DocumentErrorCode; message: string };
  createdAt: string;
}

export interface DocumentErrorPayload {
  code: DocumentErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

// ── DOCX editor model / save plan (Step 4) ─────────────────────────────────
//
// The vendored renderer works directly on the engine's parsed model. `blocks`,
// `sections`, `themeFonts` and `themeColors` are already plain JSON; `styles`
// and `numbering` are Maps upstream and ship here as entry arrays so the model
// crosses the worker → daemon → Next → iframe boundary with JSON.stringify.

export interface DocxDocumentModel {
  format: "docx";
  /** engine `Block[]` — plain JSON objects (imageDataUrl is a data URL). */
  blocks: unknown[];
  /** engine `SectionInfo[]` from readSections(). */
  sections: unknown[];
  /** `styles` Map entries: [styleId, StyleInfo]. */
  styles: [string, unknown][];
  /** `numbering` Map entries: [numId, NumberingDef]. */
  numbering: [string, unknown][];
  themeFonts: unknown | null;
  themeColors: unknown | null;
  /** `fontTable` (word/fontTable.xml entries) — drives text-run font factors. */
  fontTable?: unknown[] | null;
  /** `docDefaults` (w:docDefaults display defaults) — list-numbering storage. */
  docDefaults?: unknown | null;
  /** Count of images whose data URL exceeded the per-image cap and were
   *  replaced with a placeholder flag on the block (`imageOversized: true`). */
  oversizedImages: number;
}

/**
 * Structural copy of the vendored `SaveBlock` union
 * (src/vendor/genoffice/packages/docx-engine/src/patch.ts). The frame builds
 * real `SaveBlock[]` via the vendored `pmDocToSavePlan`; this shape is what
 * crosses the wire, so nested engine payloads (GeneratedBlock, NewImage,
 * NewChart) are typed `unknown` here but carry their verbatim JSON form.
 */
export type DocxSaveBlock = (
  | { kind: "original"; docxIndex: number }
  | { kind: "generated"; block: unknown }
  | {
      kind: "xml";
      xml: string;
      docxIndex?: number;
      replaceImage?: { base64: string; mime: "image/png" | "image/jpeg" | "image/gif" };
    }
  | { kind: "image"; image: unknown }
  | { kind: "chart"; chart: unknown; extentPx?: { w: number; h: number } }
) & {
  revision?: { kind: "ins" | "del"; author: string; date?: string; id?: string };
};

export interface DocxSavePlan {
  saveBlocks: DocxSaveBlock[];
  /**
   * Chart data edits from `pmDocToSavePlan().chartPatches`: each entry patches
   * a chart's own zip part (the body paragraph stays byte-identical). The
   * worker applies them into `options.partXml`.
   */
  chartPatches?: { partPath: string; patch: unknown }[];
  /** Optional engine `SaveOptions` subset (JSON-serializable fields only). */
  options?: Record<string, unknown>;
}

export interface DocxLoadRequest {
  sessionId: string;
}

export interface DocxSaveRequest {
  sessionId: string;
  baseRevision: string;
  plan: DocxSavePlan;
  actor?: DocumentActor;
}

export interface DocxSaveResult {
  revision: string;
  virtualPath: string;
}
