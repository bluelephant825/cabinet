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
  type Pdfium,
} from "../../src/vendor/genoffice/apps/pdf/main/text-edit";
import { savePdfToPath } from "../../src/vendor/genoffice/apps/pdf/main/save-pdf";
import { convertPdfToDocx } from "../../src/vendor/genoffice/packages/pdf2docx/src/index";
import type {
  SavePdfRequest,
  TextEditInput,
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
} from "../../src/lib/documents/types";

const INSPECT_LINE_CAP = 5000;
const SEARCH_MATCH_CAP = 500;
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
      chars.push({
        ch,
        originY: m.HEAPF64[py >> 3]!,
        bounds: [
          m.HEAPF32[rect >> 2]!,
          m.HEAPF32[(rect >> 2) + 1]!,
          m.HEAPF32[(rect >> 2) + 2]!,
          m.HEAPF32[(rect >> 2) + 3]!,
        ],
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
    return { text: inOrder.map((c) => c.ch).join(""), bounds };
  });
}

// The vendored `Pdfium` interface omits a few FPDF exports the wasm module
// actually provides; extend it locally rather than editing vendored code.
type PdfiumExt = Pdfium & {
  _FPDFText_GetUnicode(textPage: number, index: number): number;
  _FPDFPage_GetRotation?(page: number): number;
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
  const imageEdits: ImageEditInput[] = [];
  ops.forEach((op) => {
    if (op.kind === "pdfTextEdit") textEdits.push(op.edit as TextEditInput);
    else if (op.kind === "pdfImageOp") imageEdits.push(op.op as ImageEditInput);
    else throw new DocumentError("invalid", `Unsupported PDF op '${op.kind}'`);
  });
  if (textEdits.length + imageEdits.length === 0) {
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
      skippedImageEdits: skips.skippedImageEdits,
    });
  }
  return { applied: textEdits.length + imageEdits.length, diagnostics: [] };
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

async function convertOp(args: {
  inputPath: string;
  outputPath: string;
}): Promise<{
  pageCount: number;
  scannedDocument: boolean;
  warnings: string[];
  pageResults: unknown[];
}> {
  const pdf = new Uint8Array(await readFile(args.inputPath));
  const result = await convertPdfToDocx(pdf, {
    pdfium: (await pdfium()) as unknown as Parameters<typeof convertPdfToDocx>[1]["pdfium"],
  });
  await writeFile(args.outputPath, result.docx);
  return {
    pageCount: result.pages,
    scannedDocument: result.scannedDocument,
    warnings: result.warnings,
    pageResults: result.pageResults,
  };
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

export async function runOp(op: string, args: Record<string, unknown>): Promise<unknown> {
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
      return convertOp(args as never);
    case "docxLoad":
      return docxLoadOp(args as never);
    case "docxSave":
      return docxSaveOp(args as never);
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
