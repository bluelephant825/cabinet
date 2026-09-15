/**
 * The worker `listFonts` op feeds both font pickers: docxFamilies is every
 * installed family, pdfFamilies the subset with an embeddable face (glyf/CFF,
 * no color-only bitmap tables — .ttc members qualify since resolution extracts
 * single faces). Plus: inserts naming a family (not a curated EDIT_FONTS id)
 * embed the real family.
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
import type { FontListResult } from "../src/lib/documents/types";

const artifacts = mkdtempSync(path.join(os.tmpdir(), "pdf-fonts-list-"));

test("listFonts: docx superset, pdf embeddable subset, expected members", async () => {
  const r = (await runOp("listFonts", {})) as FontListResult;
  assert.ok(r.docxFamilies.length > 0, "expected installed families");
  assert.ok(r.pdfFamilies.length > 0, "expected embeddable families");
  for (const f of r.pdfFamilies) {
    assert.ok(r.docxFamilies.includes(f), `${f} missing from docxFamilies`);
  }
  assert.ok(r.pdfFamilies.includes("Arial"), "Arial (.ttf) must be embeddable");
  // Color-only faces cannot embed as PDF text objects.
  if (r.docxFamilies.includes("Apple Color Emoji")) {
    assert.ok(!r.pdfFamilies.includes("Apple Color Emoji"));
  }
  assert.ok(Array.isArray(r.editFontIds));
});

test("pdf insert with a family name embeds that family", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Base line", { x: 50, y: 700, size: 14, font });
  const inputPath = path.join(artifacts, "family-in.pdf");
  const outputPath = path.join(artifacts, "family-out.pdf");
  writeFileSync(inputPath, await doc.save({ useObjectStreams: false }));

  const res = (await runOp("applyPatch", {
    inputPath,
    outputPath,
    format: "pdf",
    ops: [
      {
        kind: "pdfTextInsert",
        insert: {
          pageIndex: 0,
          origin: [50, 600],
          text: "Family insert",
          fontSize: 14,
          color: [0, 0, 0],
          font: "Arial", // family name, not a curated EDIT_FONTS id
        },
      },
    ],
  })) as { applied: number };
  assert.equal(res.applied, 1); // a skipped insert throws before this

  const m = await loadPdfium();
  const baseFonts = await withDocument(
    m,
    new Uint8Array(readFileSync(outputPath)),
    async (d) => {
      const p = m._FPDF_LoadPage(d, 0);
      try {
        const names: string[] = [];
        const count = m._FPDFPage_CountObjects(p);
        for (let i = 0; i < count; i++) {
          const obj = m._FPDFPage_GetObject(p, i);
          if (m._FPDFPageObj_GetType(obj) !== FPDF_PAGEOBJ_TEXT) continue;
          const buf = m._malloc(256);
          try {
            const len = m._FPDFFont_GetBaseFontName(m._FPDFTextObj_GetFont(obj), buf, 256);
            if (len) {
              names.push(
                Buffer.from(m.HEAPU8.slice(buf, buf + len - 1)).toString("utf8"),
              );
            }
          } finally {
            m._free(buf);
          }
        }
        return names;
      } finally {
        m._FPDF_ClosePage(p);
      }
    },
  );
  assert.ok(
    baseFonts.some((n) => n.replace(/^[A-Z]{6}\+/, "").includes("Arial")),
    `expected an Arial BaseFont, got ${JSON.stringify(baseFonts)}`,
  );
});
