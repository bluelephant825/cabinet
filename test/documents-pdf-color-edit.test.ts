/**
 * Color-only PDF text edits repaint the matched objects in place — no font
 * rebuild — so the original embedded/base font survives. Regression test for
 * the frame emitting `newText === oldText` + `newColor` (before, canReuseFont
 * rejected any newColor edit and rebuildRun picked a fallback family).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { runOp } from "../server/documents/worker-ops";
import {
  FPDF_PAGEOBJ_TEXT,
  loadPdfium,
  withDocument,
} from "../src/vendor/genoffice/apps/pdf/main/text-edit";

const artifacts = mkdtempSync(path.join(os.tmpdir(), "pdf-color-edit-"));

interface FontAndFill {
  baseFonts: string[];
  fills: [number, number, number, number][];
}

/** Per text object on page 0: BaseFont name + fill color, read with pdfium. */
async function pageTextFontsAndFills(bytes: Uint8Array): Promise<FontAndFill> {
  const m = await loadPdfium();
  return withDocument(m, bytes, async (doc) => {
    const page = m._FPDF_LoadPage(doc, 0);
    try {
      const baseFonts: string[] = [];
      const fills: [number, number, number, number][] = [];
      const count = m._FPDFPage_CountObjects(page);
      for (let i = 0; i < count; i++) {
        const obj = m._FPDFPage_GetObject(page, i);
        if (m._FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) continue;
        const font = m._FPDFTextObj_GetFont(obj);
        const nameBuf = m._malloc(256);
        try {
          const len = m._FPDFFont_GetBaseFontName(font, nameBuf, 256);
          baseFonts.push(
            len
              ? Buffer.from(m.HEAPU8.slice(nameBuf, nameBuf + len - 1)).toString("utf8")
              : "",
          );
        } finally {
          m._free(nameBuf);
        }
        const col = m._malloc(16);
        try {
          if (m._FPDFPageObj_GetFillColor(obj, col, col + 4, col + 8, col + 12)) {
            fills.push([
              m.HEAPU8[col]!,
              m.HEAPU8[col + 4]!,
              m.HEAPU8[col + 8]!,
              m.HEAPU8[col + 12]!,
            ]);
          }
        } finally {
          m._free(col);
        }
      }
      return { baseFonts, fills };
    } finally {
      m._FPDF_ClosePage(page);
    }
  });
}

test("pdf color-only edit keeps the original font and repaints in place", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("First pdf line", { x: 50, y: 700, size: 14, font });
  const w = font.widthOfTextAtSize("First pdf line", 14);
  const bytes = await doc.save({ useObjectStreams: false });

  const inputPath = path.join(artifacts, "in.pdf");
  const outputPath = path.join(artifacts, "out.pdf");
  writeFileSync(inputPath, bytes);

  const before = await pageTextFontsAndFills(bytes);
  assert.ok(before.baseFonts.length > 0, "fixture has text objects");
  assert.ok(before.fills.every((f) => f[0] === 0 && f[1] === 0 && f[2] === 0));

  const res = (await runOp("applyPatch", {
    inputPath,
    outputPath,
    format: "pdf",
    ops: [
      {
        kind: "pdfTextEdit",
        edit: {
          pageIndex: 0,
          rect: [45, 694, 50 + w + 5, 700 + 14 + 4],
          oldText: "First pdf line",
          newText: "First pdf line",
          fontSize: 14,
          newColor: [255, 0, 0],
        },
      },
    ],
  })) as { applied: number };
  assert.equal(res.applied, 1); // a skipped edit would throw before this

  const after = await pageTextFontsAndFills(new Uint8Array(readFileSync(outputPath)));
  assert.deepEqual(after.baseFonts.sort(), before.baseFonts.sort());
  assert.equal(after.fills.length, before.fills.length);
  assert.ok(
    after.fills.every((f) => f[0] === 255 && f[1] === 0 && f[2] === 0),
    `expected red fills, got ${JSON.stringify(after.fills)}`,
  );
});
