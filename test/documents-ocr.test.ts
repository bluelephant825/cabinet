/**
 * Step-6 OCR tests: provider registry selection, the vision helper's
 * capabilities detection, and the replaceable-OCR convert pipeline driven by
 * the `test-fake` provider (in-process via the registry hook, and through a
 * spawned worker via CABINET_OCR_PROVIDER env inheritance).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";
import { PNG } from "pngjs";
import JSZip from "jszip";

import { DATA_DIR } from "../src/lib/storage/path-utils";
import { runOp } from "../server/documents/worker-ops";
import { DocumentService } from "../server/documents/service";
import { DocumentBroker } from "../server/documents/broker";
import {
  selectOcrProvider,
  setOcrProviderForTest,
} from "../server/documents/ocr/registry";
import { fakeOcrProvider } from "../server/documents/ocr/fake";
import { noneOcrProvider } from "../server/documents/ocr/none";
import { visionMacosProvider } from "../server/documents/ocr/vision-macos";
import type { JobInfo } from "../src/lib/documents/types";

const artifacts = mkdtempSync(path.join(os.tmpdir(), "documents-ocr-"));

const services: DocumentService[] = [];
function makeService(callbacks?: { onJobChanged?: (j: JobInfo) => void }): DocumentService {
  const s = new DocumentService(new DocumentBroker({ concurrency: 1 }), callbacks);
  services.push(s);
  return s;
}
test.after(async () => {
  setOcrProviderForTest(null);
  delete process.env.CABINET_OCR_PROVIDER;
  for (const s of services) await s.shutdown();
});

async function writeFixture(rel: string, bytes: Uint8Array): Promise<string> {
  const abs = path.join(DATA_DIR, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

async function waitJob(svc: DocumentService, jobId: string, timeoutMs = 120_000): Promise<JobInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = svc.jobStatus(jobId);
    if (info.status !== "queued" && info.status !== "running") return info;
    if (Date.now() > deadline) throw new Error(`job ${jobId} timed out (${info.status})`);
    await new Promise((r) => setTimeout(r, 150));
  }
}

/** A scanned page: a full-page PNG image and no text layer. */
async function scannedPdf(): Promise<Uint8Array> {
  const png = new PNG({ width: 40, height: 40 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 30;
    png.data[i + 1] = 30;
    png.data[i + 2] = 30;
    png.data[i + 3] = 255;
  }
  const doc = await PDFDocument.create();
  const img = await doc.embedPng(PNG.sync.write(png));
  const page = doc.addPage([595, 842]);
  page.drawImage(img, { x: 0, y: 0, width: 595, height: 842 });
  return doc.save({ useObjectStreams: false });
}

async function docxText(bytes: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  return (await zip.file("word/document.xml")?.async("string")) ?? "";
}

// ── registry ──────────────────────────────────────────────────────────────

test("registry: CABINET_OCR_PROVIDER override and platform default", () => {
  process.env.CABINET_OCR_PROVIDER = "none";
  assert.equal(selectOcrProvider().id, "none");
  process.env.CABINET_OCR_PROVIDER = "test-fake";
  assert.equal(selectOcrProvider().id, "test-fake");
  process.env.CABINET_OCR_PROVIDER = "nonexistent";
  assert.equal(selectOcrProvider().id, "none");
  delete process.env.CABINET_OCR_PROVIDER;
  const expected =
    process.platform === "darwin" ? "vision-macos" : process.platform === "win32" ? "windows" : "none";
  assert.equal(selectOcrProvider().id, expected);
});

test("none provider: unavailable with reason", async () => {
  const caps = await noneOcrProvider.capabilities();
  assert.equal(caps.available, false);
  assert.equal(caps.reason, "No OCR provider on this host");
});

test("vision provider: unavailable when the helper binary is missing", async () => {
  const empty = mkdtempSync(path.join(os.tmpdir(), "ocr-empty-"));
  process.env.CABINET_OCR_HELPER_DIR = empty;
  try {
    const caps = await visionMacosProvider.capabilities();
    if (process.platform === "darwin") {
      assert.equal(caps.available, false);
      assert.match(caps.reason ?? "", /not built/);
    } else {
      assert.equal(caps.available, false);
      assert.match(caps.reason ?? "", /macOS/);
    }
  } finally {
    delete process.env.CABINET_OCR_HELPER_DIR;
  }
});

// ── convert pipeline via fake provider ────────────────────────────────────

test("convert: scanned page recovered through fake OCR provider", async () => {
  setOcrProviderForTest(fakeOcrProvider);
  const inputPath = path.join(artifacts, "scan-fake.pdf");
  const outputPath = path.join(artifacts, "scan-fake.docx");
  writeFileSync(inputPath, await scannedPdf());
  const progress: string[] = [];
  const meta = (await runOp(
    "convert",
    { inputPath, outputPath },
    (p) => progress.push((p as { phase: string }).phase),
  )) as {
    pageResults: { status: string }[];
    ocr: { provider: string } | null;
    warnings: string[];
  };
  assert.equal(meta.pageResults[0]?.status, "ocr");
  assert.equal(meta.ocr?.provider, "test-fake");
  assert.ok(progress.includes("scan") && progress.includes("ocr"), `phases: ${progress}`);
  const text = await docxText(new Uint8Array(await fs.readFile(outputPath)));
  assert.ok(text.includes("Fake OCR recovered line one"), "fake text missing from docx");
});

test("convert: scanned page without OCR stays an image + warning", async () => {
  setOcrProviderForTest(noneOcrProvider);
  const inputPath = path.join(artifacts, "scan-none.pdf");
  const outputPath = path.join(artifacts, "scan-none.docx");
  writeFileSync(inputPath, await scannedPdf());
  const meta = (await runOp("convert", { inputPath, outputPath })) as {
    pageResults: { status: string }[];
    ocr: unknown;
    warnings: string[];
  };
  assert.equal(meta.pageResults[0]?.status, "scanned");
  assert.equal(meta.ocr, null);
  assert.ok(
    meta.warnings.some((w) => /no OCR provider/i.test(w)),
    `warnings: ${meta.warnings}`,
  );
});

test("convert: provider timeout falls back to scanned, job completes", async () => {
  setOcrProviderForTest({
    ...fakeOcrProvider,
    recognize: () => new Promise(() => {}), // never resolves
  });
  process.env.CABINET_OCR_TIMEOUT_MS = "400";
  try {
    const inputPath = path.join(artifacts, "scan-timeout.pdf");
    const outputPath = path.join(artifacts, "scan-timeout.docx");
    writeFileSync(inputPath, await scannedPdf());
    const meta = (await runOp("convert", { inputPath, outputPath })) as {
      pageResults: { status: string }[];
      warnings: string[];
    };
    assert.equal(meta.pageResults[0]?.status, "scanned");
    assert.ok(
      meta.warnings.some((w) => /no usable text/i.test(w)),
      `warnings: ${meta.warnings}`,
    );
  } finally {
    delete process.env.CABINET_OCR_TIMEOUT_MS;
    setOcrProviderForTest(null);
  }
});

// ── degraded rule ─────────────────────────────────────────────────────────

test("convert: dropped-content page fails 'degraded', ack re-run writes output", async () => {
  process.env.CABINET_DOC_TEST_OPS = "1";
  setOcrProviderForTest(noneOcrProvider);
  try {
    const inputPath = path.join(artifacts, "scan-degraded.pdf");
    const outputPath = path.join(artifacts, "scan-degraded.docx");
    writeFileSync(inputPath, await scannedPdf());

    const err = await runOp("convert", {
      inputPath,
      outputPath,
      dropRenders: true,
    }).then(
      () => null,
      (e: Error & { code?: string; details?: { pages?: number[] } }) => e,
    );
    assert.ok(err);
    assert.equal((err as { code?: string }).code, "degraded");
    assert.deepEqual((err as { details?: { pages?: number[] } }).details?.pages, [1]);
    assert.equal(
      await fs.stat(outputPath).then(() => true).catch(() => false),
      false,
      "degraded failure must not write output",
    );

    const meta = (await runOp("convert", {
      inputPath,
      outputPath,
      dropRenders: true,
      acknowledgeDegraded: true,
    })) as { degraded?: boolean };
    assert.equal(meta.degraded, true);
    assert.ok(await fs.stat(outputPath).then(() => true).catch(() => false));
  } finally {
    delete process.env.CABINET_DOC_TEST_OPS;
    setOcrProviderForTest(null);
  }
});

// ── service level: progress, degraded, cancel ─────────────────────────────

test("convert job: progress phases + OCR through the worker", async () => {
  process.env.CABINET_OCR_PROVIDER = "test-fake";
  const events: JobInfo[] = [];
  const svc = makeService({ onJobChanged: (j) => events.push(j) });
  await writeFixture("docs/ocr-scan.pdf", await scannedPdf());
  const opened = await svc.open({ virtualPath: "docs/ocr-scan.pdf" });
  const { jobId } = await svc.convert({
    virtualPath: "docs/ocr-scan.pdf",
    baseRevision: opened.revision,
  });
  const info = await waitJob(svc, jobId);
  assert.equal(info.status, "done");
  assert.equal(info.result?.pageResults?.[0]?.status, "ocr");
  assert.equal(info.result?.ocr?.provider, "test-fake");
  assert.ok(info.result?.virtualPath?.endsWith(".docx"));
  // Progress emits are throttled to ≥250ms — fast phases can collapse into a
  // single frame; assert the phases that must be visible, and that progress
  // events fired at all. OCR itself is proven by the 'ocr' page result above.
  const phases = new Set(
    events.map((e) => e.progress?.phase).filter((p): p is NonNullable<typeof p> => Boolean(p)),
  );
  assert.ok(phases.size >= 1, `phases seen: ${[...phases]}`);
  assert.ok(phases.has("scan") || phases.has("ocr") || phases.has("convert"));
});

// ── opt-in Vision integration (CABINET_OCR_INTEGRATION=1) ─────────────────

test("vision helper: recognizes rendered text (opt-in)", { skip: process.env.CABINET_OCR_INTEGRATION !== "1" && "set CABINET_OCR_INTEGRATION=1" }, async () => {
  const caps = await visionMacosProvider.capabilities();
  if (!caps.available) {
    console.log(`  skip: vision helper unavailable — ${caps.reason}`);
    return;
  }
  const { loadPdfium, withDocument } = await import(
    "../src/vendor/genoffice/apps/pdf/main/text-edit"
  );
  const { renderPageByIndexPng } = await import(
    "../src/vendor/genoffice/packages/pdf2docx/src/extract/index"
  );
  const m = await loadPdfium();
  const doc = await PDFDocument.create();
  const font = await doc.embedFont((await import("pdf-lib")).StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText("Recognition integration test", { x: 60, y: 700, size: 24, font });
  const pdf = await doc.save({ useObjectStreams: false });

  const png = await withDocument(m, new Uint8Array(pdf), async (d) =>
    renderPageByIndexPng(m as never, d, 0, 3),
  );
  assert.ok(png?.data, "pdfium page render failed");
  const imagePath = path.join(artifacts, "vision-integration.png");
  await fs.writeFile(imagePath, png!.data);

  const rec = await visionMacosProvider.recognize({
    imagePath,
    width: 595,
    height: 842,
    timeoutMs: 30_000,
  });
  assert.ok(rec, "vision returned no result");
  const text = rec!.lines.map((l) => l.text).join(" ");
  assert.match(text, /Recognition/i, `recognized: ${text}`);
});

test("convert job: cancel mid-OCR leaves no output", async () => {
  process.env.CABINET_OCR_PROVIDER = "test-fake";
  process.env.CABINET_OCR_FAKE_DELAY_MS = "8000";
  try {
    const svc = makeService();
    await writeFixture("docs/ocr-cancel.pdf", await scannedPdf());
    const opened = await svc.open({ virtualPath: "docs/ocr-cancel.pdf" });
    const { jobId } = await svc.convert({
      virtualPath: "docs/ocr-cancel.pdf",
      baseRevision: opened.revision,
    });
    // Wait until the job is running (extraction takes a moment) then cancel.
    const deadline = Date.now() + 30_000;
    while (svc.jobStatus(jobId).status === "queued" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await new Promise((r) => setTimeout(r, 300));
    const cancelled = svc.cancel(jobId);
    assert.equal(cancelled.status, "cancelled");
    await new Promise((r) => setTimeout(r, 300));
    const docxPath = path.join(DATA_DIR, "docs/ocr-cancel.docx");
    assert.equal(
      await fs.stat(docxPath).then(() => true).catch(() => false),
      false,
      "cancelled job must not produce output",
    );
  } finally {
    delete process.env.CABINET_OCR_FAKE_DELAY_MS;
    delete process.env.CABINET_OCR_PROVIDER;
  }
});
