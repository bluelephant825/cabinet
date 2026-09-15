/**
 * Document-engine operations that run INSIDE the worker child process.
 *
 * This is the only layer allowed to import `src/vendor/genoffice/**` — the
 * engines (PDFium WASM, docx-engine, pdf2docx) are heavy and must stay out of
 * the daemon/Next address spaces.
 *
 * All ops take file paths, not bytes: the broker owns temp files, the worker
 * reads `inputPath` and writes `outputPath`, returning metadata only.
 */
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import {
  parseDocx,
  saveDocx,
  readSections,
  patchChartPartXml,
  type SaveBlock,
  type Block,
} from "../../src/vendor/genoffice/packages/docx-engine/src/index";
import {
  loadPdfium,
  withDocument,
  chainPdfium,
  listEditFonts,
  type Pdfium,
} from "../../src/vendor/genoffice/apps/pdf/main/text-edit";
import { savePdfToPath } from "../../src/vendor/genoffice/apps/pdf/main/save-pdf";
import {
  extractIrDocument,
  isScannedDocument,
  type ConvertOptions,
  type IrDocument,
} from "../../src/vendor/genoffice/packages/pdf2docx/src/pipeline";
import { rebuild } from "../../src/vendor/genoffice/packages/pdf2docx/src/index";
import type { OcrRecognition } from "../../src/vendor/genoffice/packages/pdf2docx/src/ocr";
import { selectOcrProvider } from "./ocr/registry";
import { createAssetSink } from "./markdown/assets";
import { frontmatterBlock } from "./markdown/frontmatter";
import { docxToMarkdown } from "./markdown/from-docx";
import { irToMarkdown } from "./markdown/from-ir";
import type { JobProgress } from "../../src/lib/documents/types";
import type {
  SavePdfRequest,
  TextEditInput,
  TextInsertInput,
  ImageEditInput,
} from "../../src/vendor/genoffice/apps/pdf/shared/ipc";
import { DocumentError } from "../../src/lib/documents/errors";
import type {
  DocumentFormat,
  DocumentPatchOp,
  DocxDocumentModel,
  DocxInspectResult,
  DocxSavePlan,
  PdfInspectResult,
  PatchDiagnostic,
  PdfGeometryResult,
} from "../../src/lib/documents/types";

const INSPECT_LINE_CAP = 5000;
const SEARCH_MATCH_CAP = 500;
const FPDF_PAGEOBJ_TEXT = 1;
const FPDF_PAGEOBJ_IMAGE = 3;

// PDFium loads lazily once per worker process.
let pdfiumPromise: Promise<Pdfium> | null = null;
const pdfium = (): Promise<Pdfium> => (pdfiumPromise ??= loadPdfium());

// ── helpers ─────────────────────────────────────────────────────────────────

function blockText(block: Block): string {
  return (block.runs ?? []).map((r) => r.text).join("") || block.previewText || "";
}

interface PdfChar {
  ch: string;
  /** Character index inside the text page (for FPDFText_GetFontInfo). */
  index: number;
  originY: number;
  bounds: [number, number, number, number];
}

function readPageChars(m: PdfiumExt, textPage: number): PdfChar[] {
  const n = m._FPDFText_CountChars(textPage);
  const chars: PdfChar[] = [];
  if (n <= 0) return chars;
  const rect = m._malloc(16); // float[4]
  const px = m._malloc(8); // double
  const py = m._malloc(8);
  try {
    for (let i = 0; i < n; i++) {
      const ch = String.fromCodePoint(m._FPDFText_GetUnicode(textPage, i));
      m._FPDFText_GetLooseCharBox(textPage, i, rect);
      m._FPDFText_GetCharOrigin(textPage, i, px, py);
      // On rotated pages the loose box comes back with the y slots swapped —
      // normalize to [minX, minY, maxX, maxY] so bounds are always ordered.
      const x1 = m.HEAPF32[rect >> 2]!;
      const y1 = m.HEAPF32[(rect >> 2) + 1]!;
      const x2 = m.HEAPF32[(rect >> 2) + 2]!;
      const y2 = m.HEAPF32[(rect >> 2) + 3]!;
      chars.push({
        ch,
        index: i,
        originY: m.HEAPF64[py >> 3]!,
        bounds: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
      });
    }
  } finally {
    for (const p of [rect, px, py]) m._free(p);
  }
  return chars;
}

interface PdfLine {
  text: string;
  bounds: [number, number, number, number];
  chars: PdfChar[];
}

/** Group chars into lines by baseline origin (2 pt tolerance), top-to-bottom. */
function groupLines(chars: PdfChar[]): PdfLine[] {
  const lines: { originY: number; chars: PdfChar[] }[] = [];
  const sorted = [...chars].sort((a, b) => b.originY - a.originY);
  for (const c of sorted) {
    const line = lines.find((l) => Math.abs(l.originY - c.originY) <= 2);
    if (line) line.chars.push(c);
    else lines.push({ originY: c.originY, chars: [c] });
  }
  return lines.map(({ chars: cs }) => {
    const inOrder = [...cs].sort((a, b) => a.bounds[0] - b.bounds[0]);
    const bounds: [number, number, number, number] = [
      Math.min(...inOrder.map((c) => c.bounds[0])),
      Math.min(...inOrder.map((c) => c.bounds[1])),
      Math.max(...inOrder.map((c) => c.bounds[2])),
      Math.max(...inOrder.map((c) => c.bounds[3])),
    ];
    return { text: inOrder.map((c) => c.ch).join(""), bounds, chars: inOrder };
  });
}

// The vendored `Pdfium` interface omits a few FPDF exports the wasm module
// actually provides; extend it locally rather than editing vendored code.
type PdfiumExt = Pdfium & {
  _FPDFText_GetUnicode(textPage: number, index: number): number;
  _FPDFPage_GetRotation?(page: number): number;
  _FPDF_GetLastError?(): number;
  _FPDF_GetDocPermissions?(doc: number): number;
  _FPDFPage_GetCropBox?(page: number, l: number, b: number, r: number, t: number): number;
  _FPDFImageObj_GetImagePixelSize?(obj: number, w: number, h: number): number;
  _FPDFText_GetFontInfo?(
    textPage: number,
    index: number,
    buffer: number,
    buflen: number,
    flags: number,
  ): number;
};

// ── inspect ─────────────────────────────────────────────────────────────────

async function inspectDocx(inputPath: string): Promise<DocxInspectResult> {
  const doc = await parseDocx(new Uint8Array(await readFile(inputPath)));
  const visible = doc.blocks.filter((b) => !b.hidden);
  const paragraphs: DocxInspectResult["paragraphs"] = [];
  let images = 0;
  let tables = 0;
  let index = 0;
  for (const block of visible) {
    if (block.type === "image") images++;
    else if (block.type === "table") tables++;
    else if (block.type === "paragraph" || block.type === "heading" || block.type === "listItem") {
      // Patch identity = the engine's `docxIndex` (documented in Block as "the
      // patch anchor"); `p<docxIndex>` is stable across re-parses of unchanged
      // bytes and lets applyPatch re-locate the exact original element.
      if (block.docxIndex === null) continue;
      paragraphs.push({
        id: `p${block.docxIndex}`,
        index: index++,
        text: blockText(block),
        style: block.styleId,
        kind: block.type,
      });
      if (paragraphs.length >= INSPECT_LINE_CAP) break;
    }
  }
  const result: DocxInspectResult = {
    format: "docx",
    paragraphs,
    images,
    tables,
  };
  if (paragraphs.length >= INSPECT_LINE_CAP) result.truncated = true;
  return result;
}

async function inspectPdf(inputPath: string): Promise<PdfInspectResult> {
  const bytes = new Uint8Array(await readFile(inputPath));
  const m = (await pdfium()) as PdfiumExt;
  return chainPdfium(() =>
    withDocument(m, bytes, async (doc) => {
      const pageCount = m._FPDF_GetPageCount(doc);
      const pages: PdfInspectResult["pages"] = [];
      let totalLines = 0;
      let truncated = false;
      for (let i = 0; i < pageCount; i++) {
        const page = m._FPDF_LoadPage(doc, i);
        if (!page) continue;
        const textPage = m._FPDFText_LoadPage(page);
        try {
          const width = m._FPDF_GetPageWidthF(page);
          const height = m._FPDF_GetPageHeightF(page);
          const rotation = (m._FPDFPage_GetRotation?.(page) ?? 0) * 90;
          let imageCount = 0;
          const objCount = m._FPDFPage_CountObjects(page);
          for (let o = 0; o < objCount; o++) {
            const obj = m._FPDFPage_GetObject(page, o);
            if (obj && m._FPDFPageObj_GetType(obj) === FPDF_PAGEOBJ_IMAGE) imageCount++;
          }
          const lines = textPage ? groupLines(readPageChars(m, textPage)) : [];
          const textLines = [];
          for (let l = 0; l < lines.length; l++) {
            if (totalLines >= INSPECT_LINE_CAP) {
              truncated = true;
              break;
            }
            textLines.push({ id: `p${i}l${l}`, text: lines[l]!.text, bounds: lines[l]!.bounds });
            totalLines++;
          }
          pages.push({ index: i, width, height, rotation, textLines, imageCount });
          if (truncated) break;
        } finally {
          if (textPage) m._FPDFText_ClosePage(textPage);
          m._FPDF_ClosePage(page);
        }
      }
      const result: PdfInspectResult = { format: "pdf", pageCount, pages };
      if (truncated) result.truncated = true;
      return result;
    }),
  );
}

// ── pdf page geometry (Step 5 editor overlay) ──────────────────────────────

interface PageObject {
  index: number;
  type: number;
  bounds: [number, number, number, number];
}

/** Top-level page objects (position index + type + bounds) — mirrors the
    enumeration the vendored engines use for matching. */
function listPageObjects(m: PdfiumExt, page: number): PageObject[] {
  const out: PageObject[] = [];
  const bl = m._malloc(4);
  const bb = m._malloc(4);
  const br = m._malloc(4);
  const bt = m._malloc(4);
  try {
    const count = m._FPDFPage_CountObjects(page);
    for (let i = 0; i < count; i++) {
      const obj = m._FPDFPage_GetObject(page, i);
      if (!obj) continue;
      const type = m._FPDFPageObj_GetType(obj);
      if (!m._FPDFPageObj_GetBounds(obj, bl, bb, br, bt)) continue;
      out.push({
        index: i,
        type,
        bounds: [
          m.HEAPF32[bl >> 2]!,
          m.HEAPF32[bb >> 2]!,
          m.HEAPF32[br >> 2]!,
          m.HEAPF32[bt >> 2]!,
        ],
      });
    }
  } finally {
    for (const p of [bl, bb, br, bt]) m._free(p);
  }
  return out;
}

function rectOverlapArea(
  a: readonly number[],
  b: readonly number[],
): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/** UTF-16LE font name for one text-page char (null when unavailable). */
function charFontName(m: PdfiumExt, textPage: number, index: number): string | null {
  if (!m._FPDFText_GetFontInfo) return null;
  const buflen = 256;
  const buf = m._malloc(buflen);
  const flags = m._malloc(4);
  try {
    const len = m._FPDFText_GetFontInfo(textPage, index, buf, buflen, flags);
    if (len <= 2) return null;
    return Buffer.from(m.HEAPU8.buffer, buf, Math.min(len - 2, buflen - 2)).toString("utf16le");
  } catch {
    return null;
  } finally {
    m._free(buf);
    m._free(flags);
  }
}

function pageCropBox(
  m: PdfiumExt,
  page: number,
): [number, number, number, number] {
  const l = m._malloc(4);
  const b = m._malloc(4);
  const r = m._malloc(4);
  const t = m._malloc(4);
  try {
    if (
      m._FPDFPage_GetCropBox &&
      m._FPDFPage_GetCropBox(page, l, b, r, t)
    ) {
      return [
        m.HEAPF32[l >> 2]!,
        m.HEAPF32[b >> 2]!,
        m.HEAPF32[r >> 2]!,
        m.HEAPF32[t >> 2]!,
      ];
    }
    // No explicit crop box — the media box is the effective one.
    return [0, 0, m._FPDF_GetPageWidthF(page), m._FPDF_GetPageHeightF(page)];
  } finally {
    for (const p of [l, b, r, t]) m._free(p);
  }
}

function imagePixelSize(m: PdfiumExt, obj: number): [number, number] {
  if (!m._FPDFImageObj_GetImagePixelSize) return [0, 0];
  const w = m._malloc(4);
  const h = m._malloc(4);
  try {
    if (!m._FPDFImageObj_GetImagePixelSize(obj, w, h)) return [0, 0];
    return [m.HEAP32[w >> 2]!, m.HEAP32[h >> 2]!];
  } finally {
    m._free(w);
    m._free(h);
  }
}

/** pdf-lib AcroForm scan for signature fields — cheap enough for a
    read-side op, and the frame needs it before the first save anyway. */
async function pdfHasSignature(bytes: Uint8Array): Promise<boolean> {
  try {
    const { PDFDocument, PDFSignature } = await import("pdf-lib");
    const doc = await PDFDocument.load(bytes, {
      ignoreEncryption: true,
      updateMetadata: false,
    });
    const form = doc.getForm();
    return form.getFields().some((f) => f instanceof PDFSignature);
  } catch {
    // Malformed/odd files: a raw /Sig scan is better than nothing.
    return /\/Sig\b/.test(Buffer.from(bytes).toString("latin1"));
  }
}

async function pdfPageGeometryOp(args: {
  inputPath: string;
  pages?: number[];
}): Promise<PdfGeometryResult> {
  const bytes = new Uint8Array(await readFile(args.inputPath));
  const m = (await pdfium()) as PdfiumExt;
  const encrypted = /\/Encrypt\b/.test(
    Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString("latin1"),
  ) || /\/Encrypt\b/.test(
    Buffer.from(bytes.subarray(Math.max(0, bytes.length - 64 * 1024))).toString("latin1"),
  );
  let result: PdfGeometryResult;
  try {
    result = await chainPdfium(() =>
      withDocument(m, bytes, async (doc) => {
        const pageCount = m._FPDF_GetPageCount(doc);
        const wanted = args.pages ? new Set(args.pages) : null;
        const pages: PdfGeometryResult["pages"] = [];
        for (let i = 0; i < pageCount; i++) {
          if (wanted && !wanted.has(i)) continue;
          const page = m._FPDF_LoadPage(doc, i);
          if (!page) continue;
          const textPage = m._FPDFText_LoadPage(page);
          try {
            const objects = listPageObjects(m, page);
            const textObjects = objects.filter((o) => o.type === FPDF_PAGEOBJ_TEXT);
            const firstTextIdx = objects.find((o) => o.type === FPDF_PAGEOBJ_TEXT)?.index;
            const chars = textPage ? readPageChars(m, textPage) : [];
            const lines = groupLines(chars);
            const textLines: PdfGeometryResult["pages"][number]["textLines"] = [];
            for (let l = 0; l < lines.length; l++) {
              const line = lines[l]!;
              const lineArea = Math.max(
                (line.bounds[2] - line.bounds[0]) * (line.bounds[3] - line.bounds[1]),
                1e-6,
              );
              const covered = Math.min(
                textObjects.reduce(
                  (sum, o) => sum + rectOverlapArea(line.bounds, o.bounds),
                  0,
                ) / lineArea,
                1,
              );
              const editable = covered >= 0.5;
              const fontName =
                textPage && line.chars.length
                  ? (charFontName(m, textPage, line.chars[0]!.index) ?? undefined)
                  : undefined;
              textLines.push({
                id: `p${i}l${l}`,
                text: line.text,
                bounds: line.bounds,
                ...(fontName ? { fontName } : {}),
                ...(line.chars.length
                  ? {
                      fontSize:
                        Math.round(
                          Math.max(...line.chars.map((c) => c.bounds[3] - c.bounds[1])) * 10,
                        ) / 10,
                    }
                  : {}),
                editable,
                ...(editable
                  ? {}
                  : { reason: "Text is inside a Form XObject or unsupported container" }),
              });
            }
            const images: PdfGeometryResult["pages"][number]["images"] = [];
            for (const o of objects) {
              if (o.type !== FPDF_PAGEOBJ_IMAGE) continue;
              if (o.bounds[2] - o.bounds[0] < 3 || o.bounds[3] - o.bounds[1] < 3) continue;
              const obj = m._FPDFPage_GetObject(page, o.index);
              const [w, h] = obj ? imagePixelSize(m, obj) : [0, 0];
              images.push({
                id: `p${i}i${o.index}`,
                bounds: o.bounds,
                width: w,
                height: h,
                objectIndex: o.index,
                aboveText: firstTextIdx !== undefined && o.index > firstTextIdx,
              });
            }
            pages.push({
              index: i,
              width: m._FPDF_GetPageWidthF(page),
              height: m._FPDF_GetPageHeightF(page),
              rotation: (m._FPDFPage_GetRotation?.(page) ?? 0) * 90,
              cropBox: pageCropBox(m, page),
              textLines,
              images,
            });
          } finally {
            if (textPage) m._FPDFText_ClosePage(textPage);
            m._FPDF_ClosePage(page);
          }
        }
        return {
          format: "pdf" as const,
          pages,
          encrypted,
          signed: false,
          // Machine-dependent subset of EDIT_FONTS — the renderer needs it
          // to populate the draft format bar's font select.
          editFonts: listEditFonts(),
        };
      }),
    );
  } catch (err) {
    // FPDF_LoadMemDocument failure: lastError 4 = password required,
    // 5 = unsupported security handler — both mean "not editable here".
    const lastError = m._FPDF_GetLastError?.() ?? 0;
    if (lastError === 4 || lastError === 5) {
      throw new DocumentError(
        "read-only",
        lastError === 4
          ? "PDF is password-protected"
          : "PDF uses an unsupported security handler",
      );
    }
    throw new DocumentError(
      "invalid",
      `Could not read PDF geometry: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  result.signed = await pdfHasSignature(bytes);
  result.encrypted = encrypted;
  return result;
}

// ── read ────────────────────────────────────────────────────────────────────

async function readOp(args: {
  inputPath: string;
  format: DocumentFormat;
  page?: number;
  paragraphRange?: [number, number];
}): Promise<{ text: string }> {
  if (args.format === "docx") {
    const doc = await parseDocx(new Uint8Array(await readFile(args.inputPath)));
    const paras = doc.blocks.filter(
      (b) => !b.hidden && (b.type === "paragraph" || b.type === "heading" || b.type === "listItem"),
    );
    const range = args.paragraphRange;
    const slice = range ? paras.slice(range[0], range[1]) : paras;
    return { text: slice.map(blockText).join("\n") };
  }
  const bytes = new Uint8Array(await readFile(args.inputPath));
  const m = (await pdfium()) as PdfiumExt;
  return chainPdfium(() =>
    withDocument(m, bytes, async (doc) => {
      const pageCount = m._FPDF_GetPageCount(doc);
      const out: string[] = [];
      const indexes = args.page !== undefined ? [args.page] : Array.from({ length: pageCount }, (_, i) => i);
      for (const i of indexes) {
        if (i < 0 || i >= pageCount) continue;
        const page = m._FPDF_LoadPage(doc, i);
        if (!page) continue;
        const textPage = m._FPDFText_LoadPage(page);
        try {
          const lines = textPage ? groupLines(readPageChars(m, textPage)) : [];
          out.push(lines.map((l) => l.text).join("\n"));
        } finally {
          if (textPage) m._FPDFText_ClosePage(textPage);
          m._FPDF_ClosePage(page);
        }
      }
      return { text: out.join("\n\n") };
    }),
  );
}

// ── search ──────────────────────────────────────────────────────────────────

async function searchOp(args: {
  inputPath: string;
  format: DocumentFormat;
  query: string;
}): Promise<{ matches: { id: string; page?: number; snippet: string; bounds?: [number, number, number, number] }[] }> {
  const query = args.query?.toLowerCase();
  if (!query) return { matches: [] };
  const matches: { id: string; page?: number; snippet: string; bounds?: [number, number, number, number] }[] = [];
  const pushMatch = (id: string, text: string, page?: number, bounds?: [number, number, number, number]) => {
    const at = text.toLowerCase().indexOf(query);
    if (at < 0 || matches.length >= SEARCH_MATCH_CAP) return;
    const start = Math.max(0, at - 40);
    const end = Math.min(text.length, at + query.length + 40);
    matches.push({
      id,
      page,
      snippet: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
      bounds,
    });
  };
  if (args.format === "docx") {
    const doc = await parseDocx(new Uint8Array(await readFile(args.inputPath)));
    for (const block of doc.blocks) {
      if (block.hidden || block.docxIndex === null) continue;
      if (block.type === "paragraph" || block.type === "heading" || block.type === "listItem") {
        pushMatch(`p${block.docxIndex}`, blockText(block));
      }
      if (matches.length >= SEARCH_MATCH_CAP) break;
    }
    return { matches };
  }
  const bytes = new Uint8Array(await readFile(args.inputPath));
  const m = (await pdfium()) as PdfiumExt;
  return chainPdfium(() =>
    withDocument(m, bytes, async (doc) => {
      const pageCount = m._FPDF_GetPageCount(doc);
      for (let i = 0; i < pageCount && matches.length < SEARCH_MATCH_CAP; i++) {
        const page = m._FPDF_LoadPage(doc, i);
        if (!page) continue;
        const textPage = m._FPDFText_LoadPage(page);
        try {
          const lines = textPage ? groupLines(readPageChars(m, textPage)) : [];
          lines.forEach((l, li) => pushMatch(`p${i}l${li}`, l.text, i, l.bounds));
        } finally {
          if (textPage) m._FPDFText_ClosePage(textPage);
          m._FPDF_ClosePage(page);
        }
      }
      return { matches };
    }),
  );
}

// ── applyPatch ──────────────────────────────────────────────────────────────

async function patchDocx(
  inputPath: string,
  outputPath: string,
  ops: DocumentPatchOp[],
): Promise<{ applied: number; diagnostics: PatchDiagnostic[] }> {
  const doc = await parseDocx(new Uint8Array(await readFile(inputPath)));
  const byIndex = new Map<number, Block>();
  for (const b of doc.blocks) {
    if (b.docxIndex !== null) byIndex.set(b.docxIndex, b);
  }
  const diagnostics: PatchDiagnostic[] = [];
  const edits = new Map<number, string>();
  ops.forEach((op, i) => {
    if (op.kind !== "replaceParagraphText") {
      diagnostics.push({ index: i, code: "invalid", message: `Unsupported DOCX op '${op.kind}'` });
      throw new DocumentError("invalid", `Unsupported DOCX op '${op.kind}'`);
    }
    const docxIndex = Number.parseInt(op.paragraphId.replace(/^p/, ""), 10);
    const block = Number.isFinite(docxIndex) ? byIndex.get(docxIndex) : undefined;
    if (!block) {
      throw new DocumentError("invalid", `Paragraph '${op.paragraphId}' not found`);
    }
    const actual = blockText(block);
    if (actual !== op.expectedText) {
      throw new DocumentError(
        "conflict",
        `Paragraph '${op.paragraphId}' text no longer matches expectedText`,
        { expected: op.expectedText, actual },
      );
    }
    edits.set(docxIndex, op.newText);
  });

  const visible = doc.blocks.filter((b) => !b.hidden);
  const saveBlocks: SaveBlock[] = visible.map((b) => {
    if (b.docxIndex !== null && edits.has(b.docxIndex)) {
      return {
        kind: "generated",
        block: {
          type: (b.type === "heading" || b.type === "listItem" ? b.type : "paragraph") as
            | "paragraph"
            | "heading"
            | "listItem",
          level: b.level,
          styleId: b.styleId,
          list: b.list,
          rawPPr: b.rawPPr,
          bookmarks: b.bookmarks,
          hiddenBookmarks: b.hiddenBookmarks,
          commentStarts: b.commentStarts,
          commentEnds: b.commentEnds,
          sdtShell: b.sdtShell,
          runs: [{ text: edits.get(b.docxIndex)! }],
        },
      };
    }
    if (b.docxIndex !== null) return { kind: "original", docxIndex: b.docxIndex };
    throw new DocumentError("invalid", "Document contains a block that cannot be re-anchored");
  });

  const bytes = await saveDocx(doc, saveBlocks);
  // Re-read the produced bytes so a silently-dropped edit fails the op.
  const verify = await parseDocx(bytes);
  for (const [docxIndex, newText] of edits) {
    const block = verify.blocks.find((b) => b.docxIndex === docxIndex);
    if (!block || blockText(block) !== newText) {
      throw new DocumentError("verification-failed", `Edit to paragraph p${docxIndex} did not verify after save`);
    }
  }
  await writeFile(outputPath, bytes);
  return { applied: edits.size, diagnostics };
}

async function patchPdf(
  inputPath: string,
  outputPath: string,
  ops: DocumentPatchOp[],
): Promise<{ applied: number; diagnostics: PatchDiagnostic[] }> {
  const textEdits: TextEditInput[] = [];
  const textInserts: TextInsertInput[] = [];
  const imageEdits: ImageEditInput[] = [];
  ops.forEach((op) => {
    if (op.kind === "pdfTextEdit") textEdits.push(op.edit as TextEditInput);
    else if (op.kind === "pdfTextInsert") textInserts.push(op.insert as TextInsertInput);
    else if (op.kind === "pdfImageOp") imageEdits.push(op.op as ImageEditInput);
    else throw new DocumentError("invalid", `Unsupported PDF op '${op.kind}'`);
  });
  if (textEdits.length + textInserts.length + imageEdits.length === 0) {
    throw new DocumentError("invalid", "No applicable edits");
  }
  const request: SavePdfRequest = {
    path: inputPath,
    targetPath: outputPath,
    markups: [],
    drawings: [],
    formValues: [],
    stamps: [],
    textEdits,
    textInserts,
    imageEdits,
  };
  let skips;
  try {
    skips = await savePdfToPath(inputPath, outputPath, request);
  } catch (err) {
    throw new DocumentError(
      "verification-failed",
      `PDF save verification failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const skipped =
    skips.skippedTextEdits.length + skips.skippedTextInserts.length + skips.skippedImageEdits.length;
  if (skipped > 0) {
    // savePdfToPath wrote a partially-applied file — remove it so callers see
    // "no output" for a failed patch.
    await rm(outputPath, { force: true }).catch(() => {});
    throw new DocumentError("invalid", `${skipped} edit(s) could not be matched to the document`, {
      skippedTextEdits: skips.skippedTextEdits,
      skippedTextInserts: skips.skippedTextInserts,
      skippedImageEdits: skips.skippedImageEdits,
    });
  }
  return { applied: textEdits.length + textInserts.length + imageEdits.length, diagnostics: [] };
}

async function applyPatchOp(args: {
  inputPath: string;
  outputPath: string;
  format: DocumentFormat;
  ops: DocumentPatchOp[];
}): Promise<{ applied: number; diagnostics: PatchDiagnostic[] }> {
  if (!args.ops?.length) throw new DocumentError("invalid", "Patch contains no operations");
  return args.format === "docx"
    ? patchDocx(args.inputPath, args.outputPath, args.ops)
    : patchPdf(args.inputPath, args.outputPath, args.ops);
}

// ── convert ─────────────────────────────────────────────────────────────────

/**
 * PDF→DOCX with replaceable OCR. The vendored pipeline's OcrEngine hook is
 * synchronous (it runs inside a sync PDFium document scope), while our
 * OcrProvider contract is async — so conversion runs in two passes:
 *
 *   1. 'scan'   — extractIrDocument with a RECORDER engine: upstream calls it
 *                 once per scanned page (in page order) with the hi-res render;
 *                 recording those PNGs and returning null yields the same
 *                 bitmap fallback as a no-OCR run plus the exact inputs the
 *                 provider will see.
 *   2. 'ocr'    — provider.recognize() per recorded page (PNG temp file,
 *                 per-page timeout; failures → null → bitmap fallback).
 *   3. 'convert'— a second extractIrDocument, this time with a FIFO engine
 *                 serving the recognitions in the same call order; upstream's
 *                 confidence/coverage gates then decide OCR vs bitmap per page.
 *   4. 'write'  — rebuildDocx + output file.
 *
 * Pass 3 is skipped when no page was recognized (the pass-1 result is already
 * the correct output).
 */
/**
 * PDF → `IrDocument` with replaceable OCR, shared by the DOCX and Markdown
 * converters. Runs the three passes documented on `convertOp` below and
 * applies the degraded rule, so callers only differ in how they render the
 * resulting IR.
 */
async function extractPdfWithOcr(
  args: {
    inputPath: string;
    languageHints?: string[];
    acknowledgeDegraded?: boolean;
    /** CABINET_DOC_TEST_OPS only: drop fallback renders to simulate failures. */
    dropRenders?: boolean;
  },
  emit: (p: JobProgress) => void,
): Promise<{
  doc: IrDocument;
  warnings: string[];
  ocrMeta: { provider: string; version: string } | null;
  dropped: number[];
}> {
  const pdf = new Uint8Array(await readFile(args.inputPath));
  const pdfiumModule = (await pdfium()) as unknown as ConvertOptions["pdfium"];
  const provider = selectOcrProvider();
  const caps = await provider.capabilities().catch(() => ({
    available: false,
    reason: "OCR provider failed to report capabilities",
    languages: [] as string[],
  }));

  emit({ phase: "scan", page: 0, pageCount: 0 });
  const recorded: { png: Uint8Array; widthPt: number; heightPt: number }[] = [];
  const first = extractIrDocument(pdf, {
    pdfium: pdfiumModule,
    ocr: (png, page) => {
      recorded.push({ png, widthPt: page.widthPt, heightPt: page.heightPt });
      return null;
    },
    onProgress: (page, pageCount) => emit({ phase: "scan", page, pageCount }),
  });

  const scannedPages = first.pageResults
    .filter((r) => r.status === "scanned")
    .map((r) => r.page);
  let doc = first;
  let warnings = [...first.warnings];
  let ocrMeta: { provider: string; version: string } | null = null;

  if (scannedPages.length > 0) {
    if (!caps.available) {
      warnings.push(`scanned pages kept as images — ${caps.reason ?? "no OCR provider"}`);
    } else if (recorded.length > 0) {
      const results: (OcrRecognition | null)[] = [];
      const temps: string[] = [];
      try {
        for (let i = 0; i < recorded.length; i++) {
          const r = recorded[i]!;
          const pageNo = scannedPages[i] ?? i + 1;
          emit({ phase: "ocr", page: i + 1, pageCount: recorded.length });
          const tmp = path.join(
            os.tmpdir(),
            `cab-ocr-${process.pid}-${randomUUID()}.png`,
          );
          temps.push(tmp);
          await writeFile(tmp, r.png);
          try {
            // Backstop: the helper wrapper enforces timeoutMs itself, but a
            // provider that ignores it must not hang the job.
            const timeoutMs = Number(process.env.CABINET_OCR_TIMEOUT_MS ?? 30_000);
            const rec = await Promise.race([
              provider.recognize({
                imagePath: tmp,
                width: r.widthPt,
                height: r.heightPt,
                languageHints: args.languageHints,
                timeoutMs,
              }),
              new Promise<null>((resolve) =>
                setTimeout(() => resolve(null), timeoutMs + 5_000),
              ),
            ]);
            results.push(
              rec
                ? {
                    lines: rec.lines.map((l) => ({
                      text: l.text,
                      confidence: l.confidence,
                      box: { x0: l.bounds[0], y0: l.bounds[1], x1: l.bounds[2], y1: l.bounds[3] },
                      ...(l.words
                        ? {
                            chars: l.words.map((w) => ({
                              text: w.text,
                              box: {
                                x0: w.bounds[0],
                                y0: w.bounds[1],
                                x1: w.bounds[2],
                                y1: w.bounds[3],
                              },
                            })),
                          }
                        : {}),
                    })),
                    ...(rec.paperShare !== undefined ? { paperShare: rec.paperShare } : {}),
                  }
                : null,
            );
          } catch {
            results.push(null);
            warnings.push(`page ${pageNo}: OCR failed or timed out, kept as image`);
          }
        }
      } finally {
        for (const f of temps) await rm(f, { force: true }).catch(() => {});
      }

      if (results.some((r) => r)) {
        ocrMeta = { provider: provider.id, version: provider.version };
        let next = 0;
        const server = (): OcrRecognition | null => results[next++] ?? null;
        doc = extractIrDocument(pdf, {
          pdfium: pdfiumModule,
          ocr: server,
          onProgress: (page, pageCount) => emit({ phase: "convert", page, pageCount }),
        });
        warnings = [...doc.warnings];
      } else {
        warnings.push(
          `OCR (${provider.id}) produced no usable text — scanned pages kept as images`,
        );
      }
    }
  }

  // Degraded rule: a page that produced NO content at all (scanned/degraded
  // with no fallback render) fails the job unless the caller acknowledged.
  if (process.env.CABINET_DOC_TEST_OPS === "1" && args.dropRenders) {
    // Test seam: a failed fallback render is hard to synthesize from pdf-lib.
    for (const p of doc.irPages) {
      if (p.scanned || p.degraded) p.render = undefined;
    }
  }
  const dropped = doc.irPages
    .map((p, i) => ({ page: i + 1, p }))
    .filter(({ p }) => (p.scanned || p.degraded) && !p.render)
    .map(({ page }) => page);
  if (dropped.length > 0 && !args.acknowledgeDegraded) {
    throw new DocumentError(
      "degraded",
      `${dropped.length} page(s) produced no content: ${dropped.join(", ")}`,
      { pages: dropped },
    );
  }
  return { doc, warnings, ocrMeta, dropped };
}

async function convertOp(
  args: {
    inputPath: string;
    outputPath: string;
    languageHints?: string[];
    acknowledgeDegraded?: boolean;
    /** CABINET_DOC_TEST_OPS only: drop fallback renders to simulate failures. */
    dropRenders?: boolean;
  },
  progress?: (p: JobProgress) => void,
): Promise<{
  pageCount: number;
  scannedDocument: boolean;
  warnings: string[];
  pageResults: unknown[];
  ocr: { provider: string; version: string } | null;
  degraded?: boolean;
}> {
  const emit = progress ?? (() => {});
  const { doc, warnings, ocrMeta, dropped } = await extractPdfWithOcr(args, emit);
  emit({ phase: "write", page: 0, pageCount: doc.irPages.length });
  const docx = await rebuild.rebuildDocx(doc.irPages, { furnitureHf: doc.furnitureHf });
  await writeFile(args.outputPath, docx);
  return {
    pageCount: doc.irPages.length,
    scannedDocument: isScannedDocument(doc.pageResults, doc.irPages.length),
    warnings,
    pageResults: doc.pageResults,
    ocr: ocrMeta,
    ...(dropped.length > 0 ? { degraded: true } : {}),
  };
}

/**
 * PDF|DOCX → Markdown/MDX. PDF sources run the shared extract+OCR passes,
 * then `irToMarkdown`; DOCX sources `parseDocx` then `docxToMarkdown`. Images
 * go through an AssetSink rooted at `assetsTempDir` (created lazily — absent
 * means no images), referenced from the document as `<assetsRelPrefix><file>`.
 */
async function convertMarkdownOp(
  args: {
    inputPath: string;
    sourceFormat: "pdf" | "docx";
    target: "md" | "mdx";
    outputPath: string;
    assetsTempDir: string;
    assetsRelPrefix: string;
    /** Virtual path of the source document, for the `source:` frontmatter key. */
    sourceVirtualPath?: string;
    languageHints?: string[];
    acknowledgeDegraded?: boolean;
    dropRenders?: boolean;
  },
  progress?: (p: JobProgress) => void,
): Promise<{
  warnings: string[];
  imageFiles: string[];
  title?: string;
  pageCount?: number;
  pageResults?: unknown[];
  scannedDocument?: boolean;
  ocr?: { provider: string; version: string } | null;
  degraded?: boolean;
}> {
  const emit = progress ?? (() => {});
  const assets = createAssetSink(args.assetsTempDir, args.assetsRelPrefix);

  let markdown: string;
  let warnings: string[] = [];
  let title: string | undefined;
  let pdfMeta:
    | {
        pageCount: number;
        pageResults: unknown[];
        scannedDocument: boolean;
        ocr: { provider: string; version: string } | null;
        degraded?: boolean;
      }
    | undefined;

  if (args.sourceFormat === "pdf") {
    const { doc, warnings: w, ocrMeta, dropped } = await extractPdfWithOcr(args, emit);
    emit({ phase: "markdown", page: 0, pageCount: doc.irPages.length });
    const result = await irToMarkdown(doc, { target: args.target, assets });
    markdown = result.markdown;
    warnings = [...w, ...result.warnings];
    title = result.title;
    pdfMeta = {
      pageCount: doc.irPages.length,
      pageResults: doc.pageResults,
      scannedDocument: isScannedDocument(doc.pageResults, doc.irPages.length),
      ocr: ocrMeta,
      ...(dropped.length > 0 ? { degraded: true } : {}),
    };
  } else {
    emit({ phase: "markdown", page: 0, pageCount: 0 });
    const parsed = await parseDocx(new Uint8Array(await readFile(args.inputPath)));
    const result = await docxToMarkdown(parsed, { target: args.target, assets });
    markdown = result.markdown;
    warnings = result.warnings;
    title = result.title;
  }

  const stem =
    path.basename(args.inputPath).replace(/\.[^.]+$/, "") || "document";
  const frontmatter = frontmatterBlock({
    title: title ?? stem,
    sourceVirtualPath: args.sourceVirtualPath ?? stem,
  });
  await writeFile(args.outputPath, frontmatter + markdown, "utf8");
  return {
    warnings,
    imageFiles: assets.files,
    title,
    ...pdfMeta,
  };
}

/**
 * Lightweight convert preview for the UI dialog: page count + which pages look
 * like scans (no text lines and a page-covering image — same rule the
 * pipeline's scanned detection approximates).
 */
async function pdfConvertPlanOp(args: {
  inputPath: string;
}): Promise<{ pageCount: number; scannedPages: number[] }> {
  const geo = await pdfPageGeometryOp({ inputPath: args.inputPath });
  const scannedPages: number[] = [];
  for (const p of geo.pages) {
    if (p.textLines.length > 0) continue;
    const pageArea = Math.max(p.width * p.height, 1e-6);
    const covering = p.images.some((im) => {
      const area = (im.bounds[2] - im.bounds[0]) * (im.bounds[3] - im.bounds[1]);
      return area / pageArea >= 0.6;
    });
    if (covering) scannedPages.push(p.index + 1);
  }
  return { pageCount: geo.pages.length, scannedPages };
}

// ── docx editor model / save plan (Step 4) ──────────────────────────────────

/** Per-image data-URL cap for the serialized model (chars ≈ base64 length). */
const DOCX_IMAGE_DATA_URL_CAP = 8 * 1024 * 1024;

async function docxLoadOp(args: { inputPath: string }): Promise<DocxDocumentModel> {
  const parsed = await parseDocx(new Uint8Array(await readFile(args.inputPath)));
  let oversizedImages = 0;
  for (const block of parsed.blocks) {
    const b = block as Block & { imageOversized?: boolean };
    if (b.imageDataUrl && b.imageDataUrl.length > DOCX_IMAGE_DATA_URL_CAP) {
      // Replace the data URL with a flag — the block's originalXml still
      // carries the real image on save, so nothing is lost on disk.
      b.imageDataUrl = undefined;
      b.imageOversized = true;
      oversizedImages++;
    }
  }
  return {
    format: "docx",
    blocks: parsed.blocks as unknown[],
    sections: readSections(parsed) as unknown[],
    styles: [...parsed.styles] as [string, unknown][],
    numbering: [...parsed.numbering] as [string, unknown][],
    themeFonts: parsed.themeFonts ?? null,
    themeColors: parsed.themeColors ?? null,
    fontTable: parsed.fontTable ?? null,
    docDefaults: parsed.docDefaults ?? null,
    oversizedImages,
  };
}

async function docxSaveOp(args: {
  inputPath: string;
  outputPath: string;
  plan: DocxSavePlan;
}): Promise<{ size: number }> {
  if (!args.plan?.saveBlocks?.length) {
    throw new DocumentError("invalid", "docx save plan contains no blocks");
  }
  const parsed = await parseDocx(new Uint8Array(await readFile(args.inputPath)));
  const options = { ...(args.plan.options ?? {}) } as Parameters<typeof saveDocx>[2] & {
    partXml?: Record<string, string>;
  };
  // Chart edits patch the chart's own zip part, not the body paragraph —
  // mirror of upstream file-actions.ts buildDocBytes.
  for (const { partPath, patch } of args.plan.chartPatches ?? []) {
    const originalPart = parsed.extras?.chartParts?.[partPath];
    if (originalPart) {
      (options.partXml ??= {})[partPath] = patchChartPartXml(
        originalPart,
        patch as Parameters<typeof patchChartPartXml>[1],
      );
    }
  }
  const bytes = await saveDocx(
    parsed,
    args.plan.saveBlocks as unknown as SaveBlock[],
    options,
  );
  await writeFile(args.outputPath, bytes);
  return { size: bytes.byteLength };
}

// ── dispatch ────────────────────────────────────────────────────────────────

export async function runOp(
  op: string,
  args: Record<string, unknown>,
  progress?: (p: JobProgress) => void,
): Promise<unknown> {
  switch (op) {
    case "inspect":
      return args.format === "docx"
        ? inspectDocx(args.inputPath as string)
        : inspectPdf(args.inputPath as string);
    case "read":
      return readOp(args as never);
    case "search":
      return searchOp(args as never);
    case "applyPatch":
      return applyPatchOp(args as never);
    case "convert":
      return convertOp(args as never, progress);
    case "convertMarkdown":
      return convertMarkdownOp(args as never, progress);
    case "pdfConvertPlan":
      return pdfConvertPlanOp(args as never);
    case "docxLoad":
      return docxLoadOp(args as never);
    case "docxSave":
      return docxSaveOp(args as never);
    case "pdfPageGeometry":
      return pdfPageGeometryOp(args as never);
    case "pdfCompositionRender": {
      const { renderComposition } = await import("./pdf-generation");
      const { bytes, ...result } = await renderComposition(args as never);
      // Bytes live in the worker-written outputPath; report the size only.
      return { ...result, byteLength: bytes?.byteLength ?? 0 };
    }
    case "pdfCompositionValidate": {
      const { validateComposition } = await import("@/lib/documents/pdf-composition");
      return validateComposition(args.composition);
    }
    case "__crash":
      if (process.env.CABINET_DOC_TEST_OPS !== "1") {
        throw new DocumentError("invalid", "Unknown op '__crash'");
      }
      process.exit(1);
      return undefined;
    default:
      throw new DocumentError("invalid", `Unknown op '${op}'`);
  }
}
