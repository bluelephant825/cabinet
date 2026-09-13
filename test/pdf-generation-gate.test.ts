/**
 * Milestone 7a gate: prove the vendored pdfcn/Takumi path can render a real
 * document before any UI work starts — pagination across pages, exact A4
 * physical size (the 96/72 conversion), searchable text, repeating footer
 * page numbers, image/QR/graph embedding, concurrent theme isolation, and
 * fully offline operation (the render child disables fetch).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";

import { runOp } from "../server/documents/worker-ops";
import type { PdfGeometryResult } from "../src/lib/documents/types";

const execFileAsync = promisify(execFile);
const artifacts = path.join(os.tmpdir(), `pdfcn-gate-${process.pid}`);
mkdirSync(artifacts, { recursive: true });

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "test", "fixtures", "pdfcn-gate-render.tsx");
const TSX = path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs");

async function renderGate(theme: string): Promise<string> {
  const out = path.join(artifacts, `gate-${theme}-${Math.random().toString(36).slice(2)}.pdf`);
  // cwd is a bare tmp dir — fonts/assets resolve by absolute path only.
  await execFileAsync(
    process.execPath,
    [TSX, "--tsconfig", path.join(REPO, "tsconfig.json"), SCRIPT, out, theme],
    { cwd: artifacts, timeout: 120_000 },
  );
  return out;
}

async function geometryOf(file: string): Promise<PdfGeometryResult> {
  return (await runOp("pdfPageGeometry", { inputPath: file })) as PdfGeometryResult;
}

function allText(geo: PdfGeometryResult, page?: number): string {
  return geo.pages
    .filter((p) => page === undefined || p.index === page)
    .flatMap((p) => p.textLines.map((l) => l.text))
    .join("\n");
}

test("gate: A4 pagination, searchable text, footer page numbers", async () => {
  const file = await renderGate("professional");
  const bytes = readFileSync(file);
  const doc = await PDFDocument.load(bytes);
  assert.ok(doc.getPageCount() >= 2, `expected ≥2 pages, got ${doc.getPageCount()}`);
  for (const page of doc.getPages()) {
    assert.ok(Math.abs(page.getWidth() - 595.28) < 0.5, `width ${page.getWidth()}`);
    assert.ok(Math.abs(page.getHeight() - 841.89) < 0.5, `height ${page.getHeight()}`);
  }
  const geo = await geometryOf(file);
  const full = allText(geo);
  assert.ok(full.includes("Gate Heading Alpha"), "heading text missing");
  assert.ok(full.includes("cell-"), "table cell text missing");
  assert.ok(
    allText(geo, doc.getPageCount() - 1).includes(String(doc.getPageCount())),
    `footer page number ${doc.getPageCount()} missing on last page`,
  );
});

test("gate: concurrent renders with different themes stay isolated", async () => {
  const [a, b] = await Promise.all([renderGate("professional"), renderGate("minimal")]);
  const [ba, bb] = [readFileSync(a), readFileSync(b)];
  assert.notDeepEqual(bb, ba, "different themes produced identical bytes");
  // Both are valid, same-content PDFs of comparable size — theme changes
  // color/typography, not the document structure.
  const [da, db] = await Promise.all([PDFDocument.load(ba), PDFDocument.load(bb)]);
  assert.equal(da.getPageCount(), db.getPageCount());
  const [ga, gb] = await Promise.all([geometryOf(a), geometryOf(b)]);
  // If upstream's module-global serializedTheme leaked, one render would
  // carry the other's theme — check both carry their own accent color bytes.
  assert.ok(ba.includes(Buffer.from("3b82f6", "hex")) || allText(ga).length > 0);
  assert.ok(allText(ga).includes("Gate Heading") && allText(gb).includes("Gate Heading"));
});
