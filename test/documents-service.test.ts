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
import { suspendRoomHistoryCommits } from "./support/room-history-guard";

suspendRoomHistoryCommits();

const services: DocumentService[] = [];
function makeService(concurrency = 2): DocumentService {
  const s = new DocumentService(new DocumentBroker({ concurrency }));
  services.push(s);
  return s;
}
test.after(async () => {
  for (const s of services) await s.shutdown();
  // Fixtures live under test-docs/ + test-imports/ so a direct `tsx --test`
  // run (no isolated CABINET_DATA_DIR) never touches real room content.
  await fs.rm(path.join(DATA_DIR, "test-docs"), { recursive: true, force: true });
  await fs.rm(path.join(DATA_DIR, "test-imports"), { recursive: true, force: true });
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
  await writeFixture("test-docs/a.docx", await docxBytes());
  const opened = await svc.open({ virtualPath: "test-docs/a.docx" });
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
  assert.equal(patched.virtualPath, "test-docs/a.docx");
  assert.notEqual(patched.revision, opened.revision);

  const reopened = await svc.open({ virtualPath: "test-docs/a.docx" });
  assert.equal(reopened.revision, patched.revision);
  const read = await svc.read({ sessionId: reopened.sessionId });
  assert.ok(read.text.includes("Alpha EDITED line"));
  assert.ok(read.text.includes("Beta second line"));
});

test("pdf: text edit + image insert", async () => {
  const svc = makeService();
  const fx = await pdfBytes();
  await writeFixture("test-docs/b.pdf", fx.bytes);
  const opened = await svc.open({ virtualPath: "test-docs/b.pdf" });
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
  const abs = await writeFixture("test-docs/c.docx", bytes);
  const opened = await svc.open({ virtualPath: "test-docs/c.docx" });
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
  const abs = await writeFixture("test-docs/d.pdf", fx.bytes);
  const opened = await svc.open({ virtualPath: "test-docs/d.pdf" });
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
  await writeFixture("test-docs/e.docx", bytes);
  const opened = await svc.open({ virtualPath: "test-docs/e.docx" });
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
  await writeFixture("test-docs/src.docx", bytes);
  await writeFixture("test-docs/copy.docx", bytes);
  await writeFixture("test-docs/copy (2).docx", bytes);
  const opened = await svc.open({ virtualPath: "test-docs/src.docx" });
  const out = await svc.saveCopy({
    virtualPath: "test-docs/src.docx",
    destinationVirtualPath: "test-docs/copy.docx",
    baseRevision: opened.revision,
  });
  assert.equal(out.virtualPath, "test-docs/copy (3).docx");
  assert.deepEqual(
    await fs.readFile(path.join(DATA_DIR, "test-docs/copy (3).docx")),
    Buffer.from(bytes),
  );
});

test("staged document and text imports are validated and collision-free", async () => {
  const svc = makeService();
  const pdf = await pdfBytes();
  const stage = path.join(os.tmpdir(), `cabinet-import-${Date.now()}.pdf`);
  await fs.writeFile(stage, pdf.bytes);
  const imported = await svc.importStaged({ destinationVirtualPath: "test-imports/paper.pdf", tempPath: stage });
  assert.equal(imported.virtualPath, "test-imports/paper.pdf");
  assert.deepEqual(await fs.readFile(path.join(DATA_DIR, imported.virtualPath)), Buffer.from(pdf.bytes));

  const text = await svc.importText({ destinationVirtualPath: "test-imports/page.md", bytes: Buffer.from("# Saved page\n") });
  const collision = await svc.importText({ destinationVirtualPath: "test-imports/page.md", bytes: Buffer.from("# Second\n") });
  assert.equal(text.virtualPath, "test-imports/page.md");
  assert.equal(collision.virtualPath, "test-imports/page (2).md");

  const stageA = path.join(os.tmpdir(), `cabinet-import-a-${Date.now()}.pdf`);
  const stageB = path.join(os.tmpdir(), `cabinet-import-b-${Date.now()}.pdf`);
  await Promise.all([fs.writeFile(stageA, pdf.bytes), fs.writeFile(stageB, pdf.bytes)]);
  const raced = await Promise.all([
    svc.importStaged({ destinationVirtualPath: "test-imports/race.pdf", tempPath: stageA }),
    svc.importStaged({ destinationVirtualPath: "test-imports/race.pdf", tempPath: stageB }),
  ]);
  assert.deepEqual(raced.map((entry) => entry.virtualPath), ["test-imports/race.pdf", "test-imports/race (2).pdf"]);

  await assert.rejects(
    svc.importText({ destinationVirtualPath: "../escape.md", bytes: Buffer.from("no") }),
    /not allowed|escapes|Path/i,
  );
});

test("convert job → done, <stem>.docx created; stale revision → conflict", async () => {
  const svc = makeService();
  const fx = await pdfBytes();
  await writeFixture("test-docs/conv.pdf", fx.bytes);
  const opened = await svc.open({ virtualPath: "test-docs/conv.pdf" });
  const { jobId } = await svc.convert({ virtualPath: "test-docs/conv.pdf", baseRevision: opened.revision });
  const info = await waitJob(svc, jobId);
  assert.equal(info.status, "done");
  assert.equal(info.result?.virtualPath, "test-docs/conv.docx");
  assert.equal(info.result?.pageCount, 1);
  assert.ok(info.result?.revision?.startsWith("sha256:"));
  const docxAbs = path.join(DATA_DIR, "test-docs/conv.docx");
  const saved = await fs.readFile(docxAbs);
  assert.equal(saved.subarray(0, 2).toString("latin1"), "PK");

  await assert.rejects(
    svc.convert({ virtualPath: "test-docs/conv.pdf", baseRevision: "sha256:stale" }),
    (e) => e instanceof DocumentError && e.code === "conflict",
  );
});

test("convert pdf → md: frontmatter + text, no assets dir without images", async () => {
  const svc = makeService();
  const fx = await pdfBytes();
  await writeFixture("test-docs/mdpdf.pdf", fx.bytes);
  const opened = await svc.open({ virtualPath: "test-docs/mdpdf.pdf" });
  const { jobId } = await svc.convert({
    virtualPath: "test-docs/mdpdf.pdf",
    baseRevision: opened.revision,
    target: "md",
  });
  const info = await waitJob(svc, jobId);
  assert.equal(info.status, "done", JSON.stringify(info.error));
  assert.equal(info.result?.virtualPath, "test-docs/mdpdf.md");
  const md = await fs.readFile(path.join(DATA_DIR, "test-docs/mdpdf.md"), "utf8");
  assert.ok(md.startsWith("---"), md.slice(0, 200));
  assert.ok(md.includes('source: "test-docs/mdpdf.pdf"'), md.slice(0, 400));
  assert.ok(md.includes("First pdf line"), md);
  assert.equal(info.result?.assetsVirtualPath, undefined);
  assert.equal(await exists(path.join(DATA_DIR, "test-docs/mdpdf-assets")), false);
  assert.deepEqual(info.result?.createdPaths, ["test-docs/mdpdf.md"]);
});

test("convert pdf with image → md + test-docs/a-assets/img-01.png in createdPaths", async () => {
  const svc = makeService();
  const doc = await PDFDocument.create();
  const pg = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  pg.drawText("Page with picture", { x: 50, y: 700, size: 14, font });
  const png = new PNG({ width: 32, height: 32 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 10; png.data[i + 1] = 120; png.data[i + 2] = 200; png.data[i + 3] = 255;
  }
  const embedded = await doc.embedPng(PNG.sync.write(png));
  pg.drawImage(embedded, { x: 50, y: 400, width: 100, height: 100 });
  const bytes = await doc.save({ useObjectStreams: false });
  await writeFixture("test-docs/a.pdf", bytes);
  const opened = await svc.open({ virtualPath: "test-docs/a.pdf" });
  const { jobId } = await svc.convert({
    virtualPath: "test-docs/a.pdf",
    baseRevision: opened.revision,
    target: "md",
  });
  const info = await waitJob(svc, jobId);
  assert.equal(info.status, "done", JSON.stringify(info.error));
  assert.equal(info.result?.virtualPath, "test-docs/a.md");
  assert.equal(info.result?.assetsVirtualPath, "test-docs/a-assets");
  const created = info.result?.createdPaths ?? [];
  assert.ok(created.includes("test-docs/a.md"), JSON.stringify(created));
  assert.ok(
    created.some((p) => /^test-docs\/a-assets\/(img|page)-\d+\.(png|jpg)$/.test(p)),
    JSON.stringify(created),
  );
  assert.equal(await exists(path.join(DATA_DIR, created[1]!)), true);
  const md = await fs.readFile(path.join(DATA_DIR, "test-docs/a.md"), "utf8");
  assert.ok(md.includes("./a-assets/"), md);
});

test("convert docx → md and docx → mdx", async () => {
  const svc = makeService();
  await writeFixture("test-docs/srcmd.docx", await docxBytes());
  const opened = await svc.open({ virtualPath: "test-docs/srcmd.docx" });
  const { jobId } = await svc.convert({
    virtualPath: "test-docs/srcmd.docx",
    baseRevision: opened.revision,
    target: "md",
  });
  const info = await waitJob(svc, jobId);
  assert.equal(info.status, "done", JSON.stringify(info.error));
  assert.equal(info.result?.virtualPath, "test-docs/srcmd.md");
  const md = await fs.readFile(path.join(DATA_DIR, "test-docs/srcmd.md"), "utf8");
  assert.ok(md.includes("Alpha first line"), md);

  const reopened = await svc.open({ virtualPath: "test-docs/srcmd.docx" });
  const { jobId: j2 } = await svc.convert({
    virtualPath: "test-docs/srcmd.docx",
    baseRevision: reopened.revision,
    target: "mdx",
  });
  const info2 = await waitJob(svc, j2);
  assert.equal(info2.status, "done", JSON.stringify(info2.error));
  assert.equal(info2.result?.virtualPath, "test-docs/srcmd.mdx");
});

test("convert: unsupported pairs rejected; plan reports target + assets", async () => {
  const svc = makeService();
  await writeFixture("test-docs/nop.docx", await docxBytes());
  const opened = await svc.open({ virtualPath: "test-docs/nop.docx" });
  await assert.rejects(
    svc.convert({
      virtualPath: "test-docs/nop.docx",
      baseRevision: opened.revision,
      target: "docx",
    }),
    (e) => e instanceof DocumentError && e.code === "unsupported",
  );
  await assert.rejects(
    svc.convertPlan("test-docs/nop.docx", "docx"),
    (e) => e instanceof DocumentError && e.code === "unsupported",
  );
  const plan = await svc.convertPlan("test-docs/nop.docx", "md");
  assert.equal(plan.target, "md");
  assert.equal(plan.sourceFormat, "docx");
  assert.equal(plan.destinationVirtualPath, "test-docs/nop.md");
  assert.equal(plan.assetsVirtualPath, "test-docs/nop-assets");
  assert.equal(plan.pageCount, 0);
  assert.deepEqual(plan.scannedPages, []);
});

test("convert markdown: name collision re-picks -1 for both md and assets", async () => {
  const svc = makeService();
  await writeFixture("test-docs/coll.docx", await docxBytes());
  await writeFixture("test-docs/coll.md", Buffer.from("taken", "utf8"));
  const opened = await svc.open({ virtualPath: "test-docs/coll.docx" });
  const plan = await svc.convertPlan("test-docs/coll.docx", "md");
  assert.equal(plan.destinationVirtualPath, "test-docs/coll-1.md");
  assert.equal(plan.assetsVirtualPath, "test-docs/coll-1-assets");
  const { jobId } = await svc.convert({
    virtualPath: "test-docs/coll.docx",
    baseRevision: opened.revision,
    target: "md",
  });
  const info = await waitJob(svc, jobId);
  assert.equal(info.status, "done", JSON.stringify(info.error));
  assert.equal(info.result?.virtualPath, "test-docs/coll-1.md");
});

test("cancel a queued job → cancelled, no output file", async () => {
  const svc = makeService(1); // one worker → second convert queues behind first
  const fx = await pdfBytes();
  await writeFixture("test-docs/c1.pdf", fx.bytes);
  await writeFixture("test-docs/c2.pdf", fx.bytes);
  const opened = await svc.open({ virtualPath: "test-docs/c1.pdf" });
  const { jobId: first } = await svc.convert({ virtualPath: "test-docs/c1.pdf", baseRevision: opened.revision });
  const { jobId: second } = await svc.convert({ virtualPath: "test-docs/c2.pdf", baseRevision: revisionOf(fx.bytes) });
  const cancelled = svc.cancel(second);
  assert.equal(cancelled.status, "cancelled");
  const firstInfo = await waitJob(svc, first);
  assert.equal(firstInfo.status, "done");
  assert.equal(await exists(path.join(DATA_DIR, "test-docs/c2.docx")), false);
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

test("path traversal → unauthorized; symlink escape → unauthorized; .odt → unsupported", async () => {
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

  await writeFixture("test-docs/slides.odt", new Uint8Array([1, 2, 3]));
  await assert.rejects(svc.open({ virtualPath: "test-docs/slides.odt" }), (e) => {
    return e instanceof DocumentError && e.code === "unsupported";
  });
});

test("worker crash → worker-failed, fresh worker handles next op", async () => {
  // Workers inherit process.env at spawn; enable the test-only op first.
  process.env.CABINET_DOC_TEST_OPS = "1";
  const svc = makeService();
  await writeFixture("test-docs/crash.docx", await docxBytes());
  const abs = path.join(DATA_DIR, "test-docs/crash.docx");
  await assert.rejects(
    svc.runWorkerOp("__crash", {}),
    (e) => e instanceof DocumentError && e.code === "worker-failed",
  );
  const inspected = await svc.runWorkerOp("inspect", { inputPath: abs, format: "docx" });
  assert.equal((inspected as { format: string }).format, "docx");
});
