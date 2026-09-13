/**
 * Step-7a PDF generation tests: composition sources through the service,
 * preview caching, the publish conflict contract (output-modified / copy /
 * replace), asset authorization, theme concurrency, and offline rendering.
 *
 * Renders go through the real worker pool (takumi-pdf wasm); each takes a
 * few seconds.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFDocument } from "pdf-lib";

import { DATA_DIR } from "../src/lib/storage/path-utils";
import { DocumentService } from "../server/documents/service";
import { DocumentBroker } from "../server/documents/broker";
import { DocumentError } from "../src/lib/documents/errors";
import { renderComposition } from "../server/documents/pdf-generation";
import type { JobInfo } from "../src/lib/documents/types";
import type { PdfComposition } from "../src/lib/documents/pdf-composition";

const TEMPLATES_DIR = path.join(__dirname, "../src/lib/documents/pdf-templates");

const services: DocumentService[] = [];
function makeService(): DocumentService {
  const s = new DocumentService(new DocumentBroker({ concurrency: 1 }));
  services.push(s);
  return s;
}
test.after(async () => {
  for (const s of services) await s.shutdown();
});

const loadTemplate = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path.join(TEMPLATES_DIR, `${name}.json`), "utf8"));

async function waitJob(svc: DocumentService, jobId: string, timeoutMs = 90_000): Promise<JobInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = svc.jobStatus(jobId);
    if (info.status !== "queued" && info.status !== "running") return info;
    if (Date.now() > deadline) throw new Error(`job ${jobId} timed out (${info.status})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function putSource(
  svc: DocumentService,
  virtualPath: string,
  composition: Record<string, unknown>,
): Promise<void> {
  await svc.pdfCompositionSaveSource({ virtualPath, composition });
}

// ── templates render + publish ────────────────────────────────────────────

test("templates render to valid PDFs via publish", { timeout: 300_000 }, async () => {
  const svc = makeService();
  for (const name of ["blank", "invoice", "report"]) {
    const vp = `docs/gen/${name}.pdf.source.json`;
    await putSource(svc, vp, loadTemplate(name));
    const { jobId } = await svc.pdfCompositionRender({
      sourceVirtualPath: vp,
      mode: "publish",
    });
    const job = await waitJob(svc, jobId);
    assert.equal(job.status, "done", `${name}: ${JSON.stringify(job.error)}`);
    assert.ok(job.result?.virtualPath?.endsWith(`${name}.pdf`));
    assert.ok((job.result?.pageCount ?? 0) >= 1);

    const outAbs = path.join(DATA_DIR, `docs/gen/${name}.pdf`);
    const bytes = await fs.readFile(outAbs);
    assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
    const doc = await PDFDocument.load(bytes);
    assert.equal(doc.getPageCount(), job.result!.pageCount);

    const status = await svc.pdfCompositionStatus(vp);
    assert.equal(status.output?.stale, false);
    assert.equal(status.output?.modified, false);
  }
});

// ── preview cache ─────────────────────────────────────────────────────────

test("preview render caches by content key", { timeout: 120_000 }, async () => {
  const svc = makeService();
  const vp = "docs/gen/cache.pdf.source.json";
  await putSource(svc, vp, loadTemplate("blank"));

  const broker = (svc as unknown as { broker: DocumentBroker }).broker;
  const origRun = broker.run.bind(broker);
  let renders = 0;
  broker.run = ((op: string, args: Record<string, unknown>, job?: never) => {
    if (op === "pdfCompositionRender") renders++;
    return origRun(op, args, job);
  }) as typeof broker.run;
  try {
    const first = await waitJob(svc, (await svc.pdfCompositionRender({
      sourceVirtualPath: vp, mode: "preview",
    })).jobId);
    assert.equal(first.status, "done", JSON.stringify(first.error));
    assert.match(first.result?.previewKey ?? "", /^[a-f0-9]{64}$/);
    assert.equal(first.result?.cached, false);
    assert.equal(renders, 1);

    const second = await waitJob(svc, (await svc.pdfCompositionRender({
      sourceVirtualPath: vp, mode: "preview",
    })).jobId);
    assert.equal(second.result?.cached, true);
    assert.equal(second.result?.previewKey, first.result?.previewKey);
    assert.equal(renders, 1, "cache hit must not spawn a render");

    // Preview bytes are streamable and are a real PDF.
    const file = await svc.pdfPreviewFile(first.result!.previewKey!);
    const bytes = await fs.readFile(file);
    assert.equal(bytes.subarray(0, 5).toString("latin1"), "%PDF-");
  } finally {
    broker.run = origRun;
  }
});

// ── publish conflict contract ─────────────────────────────────────────────

test("stale flag, output-modified conflict, copy + replace", { timeout: 300_000 }, async () => {
  const svc = makeService();
  const vp = "docs/gen/conflict.pdf.source.json";
  await putSource(svc, vp, loadTemplate("blank"));
  const pub = async (extra: Record<string, unknown> = {}) =>
    waitJob(svc, (await svc.pdfCompositionRender({
      sourceVirtualPath: vp, mode: "publish", ...extra,
    })).jobId);

  const first = await pub();
  assert.equal(first.status, "done", JSON.stringify(first.error));
  assert.equal(first.result?.virtualPath, "docs/gen/conflict.pdf");

  // Edit the source → status reports stale output.
  const edited = { ...loadTemplate("blank"), title: "Edited" };
  await putSource(svc, vp, edited);
  const st = await svc.pdfCompositionStatus(vp);
  assert.equal(st.output?.stale, true);
  assert.equal(st.output?.modified, false);

  // Externally modify the generated PDF → publish conflicts.
  const outAbs = path.join(DATA_DIR, "docs/gen/conflict.pdf");
  const doc = await PDFDocument.load(await fs.readFile(outAbs));
  doc.addPage();
  await fs.writeFile(outAbs, await doc.save());

  const st2 = await svc.pdfCompositionStatus(vp);
  assert.equal(st2.output?.modified, true);

  const conflict = await pub();
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.error?.code, "conflict");
  assert.equal((conflict.error?.details as { reason?: string })?.reason, "output-modified");

  // saveAsCopy → collision-free " (2).pdf".
  const copy = await pub({ saveAsCopy: true });
  assert.equal(copy.status, "done", JSON.stringify(copy.error));
  assert.equal(copy.result?.virtualPath, "docs/gen/conflict (2).pdf");

  // replace → overwrites the hand-modified output.
  const replaced = await pub({ replace: true });
  assert.equal(replaced.status, "done", JSON.stringify(replaced.error));
  assert.equal(replaced.result?.virtualPath, "docs/gen/conflict.pdf");
  const st3 = await svc.pdfCompositionStatus(vp);
  assert.equal(st3.output?.stale, false);
  assert.equal(st3.output?.modified, false);
});

// ── failures ──────────────────────────────────────────────────────────────

test("missing source → not-found; non-source suffix → invalid", async () => {
  const svc = makeService();
  await assert.rejects(
    () => svc.pdfCompositionRender({ sourceVirtualPath: "docs/gen/nope.pdf.source.json", mode: "preview" }),
    (e: DocumentError) => e.code === "not-found",
  );
  await assert.rejects(
    () => svc.pdfCompositionRender({ sourceVirtualPath: "docs/gen/x.pdf", mode: "preview" }),
    (e: DocumentError) => e.code === "invalid",
  );
  await assert.rejects(
    () => svc.pdfCompositionStatus("docs/gen/nope.pdf.source.json"),
    (e: DocumentError) => e.code === "not-found",
  );
});

test("asset escaping the source folder → unauthorized", async () => {
  const svc = makeService();
  // ".." asset paths are caught by validation; a symlink inside the folder
  // resolving outside the cabinet passes validation but must fail the
  // service-side canonical-path authorization.
  const dir = path.join(DATA_DIR, "docs/gen");
  await fs.mkdir(dir, { recursive: true });
  const link = path.join(dir, "link.png");
  await fs.rm(link, { force: true });
  await fs.symlink("/etc/hosts", link);
  const composition = loadTemplate("blank") as unknown as PdfComposition;
  composition.assets = { logo: { path: "link.png" } };
  composition.body = [
    { type: "image", id: "img1", props: { asset: "logo", width: 64, height: 64 } },
  ];
  await putSource(svc, "docs/gen/escape.pdf.source.json", composition as never);
  await assert.rejects(
    () => svc.pdfCompositionRender({ sourceVirtualPath: "docs/gen/escape.pdf.source.json", mode: "preview" }),
    (e: DocumentError) => e.code === "unauthorized",
  );
  await fs.rm(link, { force: true });
});

// ── renderer-level: themes concurrent + offline ───────────────────────────

test("concurrent renders with different themes stay isolated; fetch disabled", { timeout: 120_000 }, async () => {
  const base = loadTemplate("report") as unknown as PdfComposition;
  const a = { ...base, theme: "professional" };
  const b = { ...base, theme: "elegant" };
  const assetsDir = os.tmpdir();
  const originalFetch = globalThis.fetch;
  // Offline: any network attempt during render must throw.
  globalThis.fetch = (() => {
    throw new Error("network disabled in test");
  }) as typeof fetch;
  try {
    const [ra, rb] = await Promise.all([
      renderComposition({ composition: a, assetsDir, mode: "preview" }),
      renderComposition({ composition: b, assetsDir, mode: "preview" }),
    ]);
    assert.ok(ra.pageCount >= 1 && rb.pageCount >= 1);
    assert.notDeepEqual(ra.bytes, rb.bytes, "different themes must produce different bytes");
    assert.ok((ra.bytes?.byteLength ?? 0) > 1000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
