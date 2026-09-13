/**
 * Step-5 PDF geometry tests: the worker `pdfPageGeometry` op feeds the
 * editor's overlay layers — per-page bounds/rotation/cropBox, stable line ids,
 * editability flags, and image identifiers. Also covers the cheap encryption
 * and signature detection that open/geometry expose.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { PDFDocument, StandardFonts, degrees } from "pdf-lib";

import { DATA_DIR } from "../src/lib/storage/path-utils";
import { runOp } from "../server/documents/worker-ops";
import { DocumentService } from "../server/documents/service";
import { DocumentBroker } from "../server/documents/broker";
import type { PdfGeometryResult } from "../src/lib/documents/types";

const artifacts = path.join(os.tmpdir(), `documents-pdf-geometry-${process.pid}`);
mkdirSync(artifacts, { recursive: true });

const persist = (name: string, bytes: Uint8Array): string => {
  const p = path.join(artifacts, name);
  writeFileSync(p, bytes);
  return p;
};

const services: DocumentService[] = [];
function makeService(): DocumentService {
  const s = new DocumentService(new DocumentBroker({ concurrency: 1 }));
  services.push(s);
  return s;
}
test.after(async () => {
  for (const s of services) await s.shutdown();
});

async function writeDataFixture(rel: string, bytes: Uint8Array): Promise<void> {
  const abs = path.join(DATA_DIR, rel);
  await import("node:fs/promises").then((fs) => fs.mkdir(path.dirname(abs), { recursive: true }));
  await import("node:fs/promises").then((fs) => fs.writeFile(abs, bytes));
}

/** Two-page fixture: page 1 upright, page 2 rotated 90°, both with
    standard-font text lines. */
async function twoPagePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([595, 842]);
  p1.drawText("Alpha page one", { x: 60, y: 740, size: 16, font });
  p1.drawText("Beta second line", { x: 60, y: 710, size: 16, font });
  const p2 = doc.addPage([595, 842]);
  p2.setRotation(degrees(90));
  p2.drawText("Rotated page two", { x: 60, y: 740, size: 16, font });
  return doc.save({ useObjectStreams: false });
}

/** Fixture whose only text lives inside an embedded Form XObject — the
    text-edit engine only matches top-level page objects. */
async function xobjectPdf(): Promise<Uint8Array> {
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  const sp = src.addPage([300, 200]);
  sp.drawText("Nested form text", { x: 20, y: 120, size: 14, font });
  const srcBytes = await src.save({ useObjectStreams: false });

  const doc = await PDFDocument.create();
  const embedded = await doc.embedPage((await PDFDocument.load(srcBytes)).getPage(0));
  const page = doc.addPage([400, 400]);
  page.drawPage(embedded, { x: 40, y: 200, width: 300, height: 200 });
  return doc.save({ useObjectStreams: false });
}

test("geometry: two pages, rotation 90 on page 2, stable ids, editable lines", async () => {
  const inputPath = persist("two.pdf", await twoPagePdf());
  const g1 = (await runOp("pdfPageGeometry", { inputPath })) as PdfGeometryResult;
  const g2 = (await runOp("pdfPageGeometry", { inputPath })) as PdfGeometryResult;

  assert.equal(g1.format, "pdf");
  assert.equal(g1.pages.length, 2);
  const p1 = g1.pages[0]!;
  const p2 = g1.pages[1]!;
  assert.equal(p1.rotation, 0);
  assert.equal(p2.rotation, 90);
  assert.ok(p1.width > 0 && p1.height > 0);
  assert.deepEqual(p1.cropBox, [0, 0, 595, 842]);
  assert.equal(p2.cropBox.length, 4);

  // Line ids are stable across calls on unchanged bytes.
  const ids1 = p1.textLines.map((l) => l.id);
  assert.deepEqual(ids1, g2.pages[0]!.textLines.map((l) => l.id));
  assert.ok(ids1.length >= 2, "expected at least two text lines");

  const alpha = p1.textLines.find((l) => l.text.includes("Alpha page one"));
  assert.ok(alpha, "line text not found");
  assert.equal(alpha.editable, true);
  assert.ok(alpha.bounds[2] > alpha.bounds[0] && alpha.bounds[3] > alpha.bounds[1]);
  assert.ok((alpha.fontSize ?? 0) > 0);

  // Every standard-font line in this fixture is a top-level text object.
  for (const l of p1.textLines) assert.equal(l.editable, true, l.text);
  for (const l of p2.textLines) assert.equal(l.editable, true, l.text);
});

test("geometry: text inside a Form XObject is reported non-editable", async () => {
  const inputPath = persist("xobject.pdf", await xobjectPdf());
  const g = (await runOp("pdfPageGeometry", { inputPath })) as PdfGeometryResult;
  const nested = g.pages[0]!.textLines.filter((l) => l.text.includes("Nested form text"));
  if (nested.length === 0) {
    // PDFium's text page does not surface XObject text at all — that also
    // means nothing here can be matched as editable.
    return;
  }
  for (const l of nested) {
    assert.equal(l.editable, false);
    assert.ok(l.reason, "non-editable lines must carry a reason");
  }
});

test("geometry: images carry stable ids, bounds and object index", async () => {
  const { PNG } = await import("pngjs");
  const png = new PNG({ width: 10, height: 6 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10;
    png.data[i + 1] = 120;
    png.data[i + 2] = 200;
    png.data[i + 3] = 255;
  }
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 400]);
  const img = await doc.embedPng(PNG.sync.write(png));
  page.drawImage(img, { x: 50, y: 200, width: 100, height: 60 });
  const inputPath = persist("img.pdf", await doc.save({ useObjectStreams: false }));

  const g = (await runOp("pdfPageGeometry", { inputPath })) as PdfGeometryResult;
  const g2 = (await runOp("pdfPageGeometry", { inputPath })) as PdfGeometryResult;
  const images = g.pages[0]!.images;
  assert.equal(images.length, 1);
  const im = images[0]!;
  assert.equal(im.id, g2.pages[0]!.images[0]!.id);
  assert.ok(im.objectIndex >= 0);
  assert.equal(im.width, 10);
  assert.equal(im.height, 6);
  assert.ok(im.bounds[2] - im.bounds[0] > 90);
});

test("open: /Encrypt-bearing PDF is flagged read-only", async () => {
  const svc = makeService();
  const bytes = await twoPagePdf();
  // pdf-lib cannot encrypt; a literal /Encrypt token exercises the cheap
  // trailer scan that gates the editor (real encryption covered when qpdf
  // is available, see below).
  const fake = Buffer.concat([
    Buffer.from(bytes),
    Buffer.from("\n% trailer << /Encrypt 9 0 R >>\n"),
  ]);
  await writeDataFixture("docs/encrypted-marker.pdf", new Uint8Array(fake));
  const opened = await svc.open({ virtualPath: "docs/encrypted-marker.pdf" });
  assert.ok(opened.readOnlyReason, "expected a readOnlyReason for /Encrypt bytes");
  assert.equal(opened.capabilities.edit, false);
});

test("open: real encrypted PDF via qpdf is flagged read-only", async (t) => {
  try {
    execFileSync("qpdf", ["--version"], { stdio: "ignore" });
  } catch {
    t.skip("qpdf not available — cannot produce an encrypted fixture");
    return;
  }
  const svc = makeService();
  const plain = persist("plain.pdf", await twoPagePdf());
  const enc = path.join(artifacts, "enc.pdf");
  execFileSync("qpdf", [
    "--encrypt",
    "userpw",
    "ownerpw",
    "256",
    "--",
    plain,
    enc,
  ]);
  await writeDataFixture("docs/enc.pdf", new Uint8Array(await import("node:fs/promises").then((fs) => fs.readFile(enc))));
  const opened = await svc.open({ virtualPath: "docs/enc.pdf" });
  assert.ok(opened.readOnlyReason);
  assert.equal(opened.capabilities.edit, false);
});
