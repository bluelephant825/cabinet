import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { PNG } from "pngjs";

import { DATA_DIR } from "../src/lib/storage/path-utils";
import { buildBlankDocx } from "../src/vendor/genoffice/packages/docx-engine/src/blank";
import { parseDocx, saveDocx } from "../src/vendor/genoffice/packages/docx-engine/src/index";
import type { SaveBlock } from "../src/vendor/genoffice/packages/docx-engine/src/index";
import { addKnowledgeSource, removeKnowledgeSource } from "../src/lib/knowledge-sources/store";
import { ROOT_CABINET_PATH } from "../src/lib/cabinets/paths";
import { DocumentService } from "../server/documents/service";
import { DocumentBroker } from "../server/documents/broker";
import { DocumentError } from "../src/lib/documents/errors";
import { revisionOf } from "../src/lib/documents/revision";
import type { JobInfo } from "../src/lib/documents/types";

const services: DocumentService[] = [];
function makeService(concurrency = 2): DocumentService {
  const s = new DocumentService(new DocumentBroker({ concurrency }));
  services.push(s);
  return s;
}
test.after(async () => {
  for (const s of services) await s.shutdown();
});

// ── fixtures ──────────────────────────────────────────────────────────────

const para = (text: string): SaveBlock => ({
  kind: "generated",
  block: { type: "paragraph", runs: [{ text }] },
});

async function docxBytes(): Promise<Uint8Array> {
  const blank = await buildBlankDocx();
  const doc = await parseDocx(blank);
  return saveDocx(doc, [para("Alpha first line"), para("Beta second line")]);
}

interface PdfFixture {
  bytes: Uint8Array;
  rect1: [number, number, number, number];
}
async function pdfBytes(): Promise<PdfFixture> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("First pdf line", { x: 50, y: 700, size: 14, font });
  page.drawText("Second pdf line", { x: 50, y: 670, size: 14, font });
  const w = font.widthOfTextAtSize("First pdf line", 14);
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    rect1: [45, 694, 50 + w + 5, 700 + 14 + 4],
  };
}

function makePng(): string {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200;
    png.data[i + 1] = 60;
    png.data[i + 2] = 40;
    png.data[i + 3] = 255;
  }
  return PNG.sync.write(png).toString("base64");
}

async function writeFixture(rel: string, bytes: Uint8Array): Promise<string> {
  const abs = path.join(DATA_DIR, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

async function waitJob(svc: DocumentService, jobId: string, timeoutMs = 60000): Promise<JobInfo> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const info = svc.jobStatus(jobId);
    if (info.status !== "queued" && info.status !== "running") return info;
    if (Date.now() > deadline) throw new Error(`job ${jobId} timed out (${info.status})`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

// ── tests ─────────────────────────────────────────────────────────────────

test("docx: open → inspect → patch → revision advances → reopen reflects edit", async () => {
  const svc = makeService();
  await writeFixture("docs/a.docx", await docxBytes());
  const opened = await svc.open({ virtualPath: "docs/a.docx" });
  assert.equal(opened.format, "docx");
  assert.equal(opened.capabilities.edit, true);

  const inspected = await svc.inspect({ sessionId: opened.sessionId });
  assert.equal(inspected.format, "docx");
  const target = inspected.paragraphs.find((p) => p.text.includes("Alpha first line"));
  assert.ok(target, "paragraph not found in inspect result");

  const patched = await svc.applyPatch({
    sessionId: opened.sessionId,
    baseRevision: opened.revision,
    ops: [
      {
        kind: "replaceParagraphText",
        paragraphId: target.id,
        expectedText: target.text,
        newText: "Alpha EDITED line",
      },
    ],
  });
  assert.equal(patched.applied, 1);
  assert.equal(patched.virtualPath, "docs/a.docx");
  assert.notEqual(patched.revision, opened.revision);

  const reopened = await svc.open({ virtualPath: "docs/a.docx" });
  assert.equal(reopened.revision, patched.revision);
  const read = await svc.read({ sessionId: reopened.sessionId });
  assert.ok(read.text.includes("Alpha EDITED line"));
  assert.ok(read.text.includes("Beta second line"));
});

test("pdf: text edit + image insert", async () => {
  const svc = makeService();
  const fx = await pdfBytes();
  await writeFixture("docs/b.pdf", fx.bytes);
  const opened = await svc.open({ virtualPath: "docs/b.pdf" });
  const inspected = await svc.inspect({ sessionId: opened.sessionId });
  assert.equal(inspected.format, "pdf");
  assert.equal(inspected.pageCount, 1);
  const line = inspected.pages[0]!.textLines.find((l) => l.text.includes("First pdf line"));
  assert.ok(line, "text line not found");

  let rev = opened.revision;
  const t = await svc.applyPatch({
    sessionId: opened.sessionId,
    baseRevision: rev,
    ops: [
      {
        kind: "pdfTextEdit",
        edit: {
          pageIndex: 0,
          rect: fx.rect1,
          oldText: "First pdf line",
          newText: "REPLACED pdf line",
          fontSize: 14,
        },
      },
    ],
  });
  rev = t.revision;
  const img = await svc.applyPatch({
    sessionId: opened.sessionId,
    baseRevision: rev,
    ops: [
      {
        kind: "pdfImageOp",
        op: {
          kind: "insertImage",
          pageIndex: 0,
          rect: [200, 500, 264, 564],
          image: makePng(),
          layer: "aboveText",
        },
      },
    ],
  });
  const re = await svc.inspect({ sessionId: opened.sessionId });
  if (re.format !== "pdf") throw new Error("expected pdf");
  assert.equal(re.pages[0]!.imageCount, 1);
  const rd = await svc.read({ sessionId: opened.sessionId });
  assert.ok(rd.text.includes("REPLACED pdf line"));
  void img;
});

test("docx expectedText mismatch → conflict, no write", async () => {
  const svc = makeService();
  const bytes = await docxBytes();
  const abs = await writeFixture("docs/c.docx", bytes);
  const opened = await svc.open({ virtualPath: "docs/c.docx" });
  const inspected = await svc.inspect({ sessionId: opened.sessionId });
  if (inspected.format !== "docx") throw new Error();
  const target = inspected.paragraphs[0]!;
  await assert.rejects(
    svc.applyPatch({
      sessionId: opened.sessionId,
      baseRevision: opened.revision,
      ops: [
        {
          kind: "replaceParagraphText",
          paragraphId: target.id,
          expectedText: "WRONG",
          newText: "nope",
        },
      ],
    }),
    (e) => e instanceof DocumentError && e.code === "conflict",
  );
  assert.deepEqual(await fs.readFile(abs), Buffer.from(bytes));
});

test("pdf skipped edit → invalid/verification-failed, file unchanged", async () => {
  const svc = makeService();
  const fx = await pdfBytes();
  const abs = await writeFixture("docs/d.pdf", fx.bytes);
  const opened = await svc.open({ virtualPath: "docs/d.pdf" });
  await assert.rejects(
    svc.applyPatch({
      sessionId: opened.sessionId,
      baseRevision: opened.revision,
      ops: [
        {
          kind: "pdfTextEdit",
          edit: {
            pageIndex: 0,
            rect: [0, 0, 20, 20],
            oldText: "text that does not exist",
            newText: "x",
            fontSize: 12,
          },
        },
      ],
    }),
    (e) => e instanceof DocumentError && (e.code === "invalid" || e.code === "verification-failed"),
  );
  assert.deepEqual(await fs.readFile(abs), Buffer.from(fx.bytes));
});

test("two concurrent patches with same baseRevision → one success, one conflict", async () => {
  const svc = makeService();
  const bytes = await docxBytes();
  await writeFixture("docs/e.docx", bytes);
  const opened = await svc.open({ virtualPath: "docs/e.docx" });
  const inspected = await svc.inspect({ sessionId: opened.sessionId });
  if (inspected.format !== "docx") throw new Error();
  const target = inspected.paragraphs[0]!;
  const mk = (newText: string) =>
    svc.applyPatch({
      sessionId: opened.sessionId,
      baseRevision: opened.revision,
      ops: [
        {
          kind: "replaceParagraphText",
          paragraphId: target.id,
          expectedText: target.text,
          newText,
        },
      ],
    });
  const [a, b] = await Promise.allSettled([mk("edit A"), mk("edit B")]);
  const results = [a, b];
  const ok = results.filter((r) => r.status === "fulfilled");
  const conflicts = results.filter(
    (r) => r.status === "rejected" && r.reason instanceof DocumentError && r.reason.code === "conflict",
  );
  assert.equal(ok.length, 1);
  assert.equal(conflicts.length, 1);
});

test("saveCopy collision naming", async () => {
  const svc = makeService();
  const bytes = await docxBytes();
  await writeFixture("docs/src.docx", bytes);
  await writeFixture("docs/copy.docx", bytes);
  await writeFixture("docs/copy (2).docx", bytes);
  const opened = await svc.open({ virtualPath: "docs/src.docx" });
  const out = await svc.saveCopy({
    virtualPath: "docs/src.docx",
    destinationVirtualPath: "docs/copy.docx",
    baseRevision: opened.revision,
  });
  assert.equal(out.virtualPath, "docs/copy (3).docx");
  assert.deepEqual(
    await fs.readFile(path.join(DATA_DIR, "docs/copy (3).docx")),
    Buffer.from(bytes),
  );
});

test("convert job → done, <stem>.docx created; stale revision → conflict", async () => {
  const svc = makeService();
  const fx = await pdfBytes();
  await writeFixture("docs/conv.pdf", fx.bytes);
  const opened = await svc.open({ virtualPath: "docs/conv.pdf" });
  const { jobId } = await svc.convert({ virtualPath: "docs/conv.pdf", baseRevision: opened.revision });
  const info = await waitJob(svc, jobId);
  assert.equal(info.status, "done");
  assert.equal(info.result?.virtualPath, "docs/conv.docx");
  assert.equal(info.result?.pageCount, 1);
  assert.ok(info.result?.revision?.startsWith("sha256:"));
  const docxAbs = path.join(DATA_DIR, "docs/conv.docx");
  const saved = await fs.readFile(docxAbs);
  assert.equal(saved.subarray(0, 2).toString("latin1"), "PK");

  await assert.rejects(
    svc.convert({ virtualPath: "docs/conv.pdf", baseRevision: "sha256:stale" }),
    (e) => e instanceof DocumentError && e.code === "conflict",
  );
});

test("cancel a queued job → cancelled, no output file", async () => {
  const svc = makeService(1); // one worker → second convert queues behind first
  const fx = await pdfBytes();
  await writeFixture("docs/c1.pdf", fx.bytes);
  await writeFixture("docs/c2.pdf", fx.bytes);
  const opened = await svc.open({ virtualPath: "docs/c1.pdf" });
  const { jobId: first } = await svc.convert({ virtualPath: "docs/c1.pdf", baseRevision: opened.revision });
  const { jobId: second } = await svc.convert({ virtualPath: "docs/c2.pdf", baseRevision: revisionOf(fx.bytes) });
  const cancelled = svc.cancel(second);
  assert.equal(cancelled.status, "cancelled");
  const firstInfo = await waitJob(svc, first);
  assert.equal(firstInfo.status, "done");
  assert.equal(await exists(path.join(DATA_DIR, "docs/c2.docx")), false);
});

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

test("read-only inline source: open works with reason, patch → read-only", async () => {
  const svc = makeService();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cab-ro-src-"));
  const linkDir = path.join(DATA_DIR, "ro-src");
  try {
    await fs.writeFile(path.join(outside, "ro.docx"), await docxBytes());
    await fs.symlink(outside, linkDir);
    const src = await addKnowledgeSource(ROOT_CABINET_PATH, {
      provider: "local",
      absPath: outside,
      name: "ro-src",
      policy: "read-only",
      surface: "inline",
      treePath: "ro-src",
    });
    const opened = await svc.open({ virtualPath: "ro-src/ro.docx" });
    assert.ok(opened.readOnlyReason, "expected readOnlyReason");
    assert.equal(opened.capabilities.edit, false);
    const inspected = await svc.inspect({ sessionId: opened.sessionId });
    if (inspected.format !== "docx") throw new Error();
    await assert.rejects(
      svc.applyPatch({
        sessionId: opened.sessionId,
        baseRevision: opened.revision,
        ops: [
          {
            kind: "replaceParagraphText",
            paragraphId: inspected.paragraphs[0]!.id,
            expectedText: inspected.paragraphs[0]!.text,
            newText: "x",
          },
        ],
      }),
      (e) => e instanceof DocumentError && e.code === "read-only",
    );
    await removeKnowledgeSource(ROOT_CABINET_PATH, src.id);
  } finally {
    await fs.rm(linkDir, { force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("path traversal → unauthorized; symlink escape → unauthorized; .xlsx → unsupported", async () => {
  const svc = makeService();
  await assert.rejects(svc.open({ virtualPath: "../escape.docx" }), (e) => {
    return e instanceof DocumentError && e.code === "unauthorized";
  });

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cab-escape-"));
  try {
    await fs.writeFile(path.join(outside, "evil.docx"), await docxBytes());
    await fs.symlink(path.join(outside, "evil.docx"), path.join(DATA_DIR, "evil.docx"));
    await assert.rejects(svc.open({ virtualPath: "evil.docx" }), (e) => {
      return e instanceof DocumentError && e.code === "unauthorized";
    });
  } finally {
    await fs.rm(path.join(DATA_DIR, "evil.docx"), { force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }

  await writeFixture("docs/sheet.xlsx", new Uint8Array([1, 2, 3]));
  await assert.rejects(svc.open({ virtualPath: "docs/sheet.xlsx" }), (e) => {
    return e instanceof DocumentError && e.code === "unsupported";
  });
});

test("worker crash → worker-failed, fresh worker handles next op", async () => {
  // Workers inherit process.env at spawn; enable the test-only op first.
  process.env.CABINET_DOC_TEST_OPS = "1";
  const svc = makeService();
  await writeFixture("docs/crash.docx", await docxBytes());
  const abs = path.join(DATA_DIR, "docs/crash.docx");
  await assert.rejects(
    svc.runWorkerOp("__crash", {}),
    (e) => e instanceof DocumentError && e.code === "worker-failed",
  );
  const inspected = await svc.runWorkerOp("inspect", { inputPath: abs, format: "docx" });
  assert.equal((inspected as { format: string }).format, "docx");
});
