import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DocumentBroker } from "../server/documents/broker";
import { DocumentService } from "../server/documents/service";
import { runOp } from "../server/documents/worker-ops";
import { DocumentError } from "../src/lib/documents/errors";
import { DATA_DIR } from "../src/lib/storage/path-utils";
import {
  addElement,
  createBlankPptx,
  getSlideNotes,
  matchesElementRef,
  openPptx,
  savePptx,
  setSlideNotes,
} from "../src/vendor/genoffice/packages/pptx-engine/src/index";
import type { PptxDocumentModel } from "../src/lib/documents/types";

const dir = path.join(os.tmpdir(), `cabinet-pptx-${process.pid}`);

test.before(async () => fs.mkdir(dir, { recursive: true }));
test.after(async () => fs.rm(dir, { recursive: true, force: true }));

async function fixture(name = "input.pptx") {
  const opened = await openPptx(await createBlankPptx());
  addElement(opened.deck.slides[0]!, {
    kind: "textbox",
    offset: { x: 914400, y: 914400, cx: 5486400, cy: 914400 },
    paragraphs: [{ runs: [{ text: "Phase 4 title", bold: true }, { text: " subtitle" }] }],
  });
  setSlideNotes(opened, 0, "Original speaker note");
  const file = path.join(dir, name);
  await fs.writeFile(file, await savePptx(opened));
  return file;
}

test("pptx worker inspects, reads and loads text with speaker notes", async () => {
  const inputPath = await fixture();
  const inspected = (await runOp("inspect", { inputPath, format: "pptx" })) as {
    format: string;
    slideCount: number;
    slides: { text: string; notes: string }[];
  };
  assert.equal(inspected.format, "pptx");
  assert.equal(inspected.slideCount, 1);
  assert.match(inspected.slides[0]!.text, /Phase 4 title subtitle/);
  assert.equal(inspected.slides[0]!.notes, "Original speaker note");

  const read = (await runOp("read", { inputPath, format: "pptx" })) as { text: string };
  assert.match(read.text, /## Slide 1/);
  assert.match(read.text, /Notes:\nOriginal speaker note/);

  const model = (await runOp("pptxLoad", { inputPath })) as PptxDocumentModel;
  assert.equal(model.format, "pptx");
  assert.equal(model.slides[0]!.elements[0]!.paragraphs[0]!.runs[0]!.bold, true);
});

test("pptx save persists text and notes while preserving run formatting", async () => {
  const inputPath = await fixture("save.pptx");
  const outputPath = path.join(dir, "saved.pptx");
  const model = (await runOp("pptxLoad", { inputPath })) as PptxDocumentModel;
  const element = model.slides[0]!.elements[0]!;
  const paragraphs = structuredClone(element.paragraphs);
  paragraphs[0]!.runs[0]!.text = "Edited title";
  await runOp("pptxSave", {
    inputPath,
    outputPath,
    plan: {
      textEdits: [{ slideIndex: 0, elementId: element.id, paragraphs }],
      notesEdits: [{ slideIndex: 0, text: "Edited speaker note" }],
    },
  });

  const reopened = await openPptx(new Uint8Array(await fs.readFile(outputPath)));
  const textElement = reopened.deck.slides[0]!.elements.find((candidate) => matchesElementRef(candidate, element.id));
  assert.ok(textElement && (textElement.type === "text" || textElement.type === "shape"));
  assert.equal(textElement.text?.paragraphs[0]?.runs[0]?.text, "Edited title");
  assert.equal(textElement.text?.paragraphs[0]?.runs[0]?.bold, true);
  assert.equal(textElement.text?.paragraphs[0]?.runs[1]?.text, " subtitle");
  assert.equal(getSlideNotes(reopened.archive, reopened.deck.slides[0]!.path), "Edited speaker note");
});

test("pptx service advances revisions and rejects external edit conflicts", async () => {
  const source = await fixture("service-source.pptx");
  const virtualPath = `pptx-test-${process.pid}/service.pptx`;
  const absPath = path.join(DATA_DIR, virtualPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.copyFile(source, absPath);
  const service = new DocumentService(new DocumentBroker({ concurrency: 1 }));
  try {
    const opened = await service.open({ virtualPath });
    assert.equal(opened.format, "pptx");
    const model = await service.pptxLoad({ sessionId: opened.sessionId });
    const element = model.slides[0]!.elements[0]!;
    const paragraphs = structuredClone(element.paragraphs);
    paragraphs[0]!.runs[0]!.text = "Service edit";
    const saved = await service.pptxSave({
      sessionId: opened.sessionId,
      baseRevision: opened.revision,
      plan: {
        textEdits: [{ slideIndex: 0, elementId: element.id, paragraphs }],
        notesEdits: [],
      },
    });
    assert.notEqual(saved.revision, opened.revision);
    const recovery = await service.listRecovery(virtualPath);
    assert.ok(recovery.entries.some((entry) => entry.revision === opened.revision));
    await fs.copyFile(await fixture("external.pptx"), absPath);
    await assert.rejects(
      service.pptxSave({
        sessionId: opened.sessionId,
        baseRevision: saved.revision,
        plan: { textEdits: [], notesEdits: [{ slideIndex: 0, text: "stale" }] },
      }),
      (cause) => cause instanceof DocumentError && cause.code === "conflict",
    );
  } finally {
    await service.shutdown();
    await fs.rm(path.dirname(absPath), { recursive: true, force: true });
  }
});
