import { readFile, writeFile } from "node:fs/promises";
import {
  elementDurableId,
  getSlideNotes,
  groupChildDurableId,
  matchesElementRef,
  openPptx,
  patchGroupChildText,
  savePptx,
  setSlideNotes,
  type GroupElement,
  type TextElement,
} from "../../src/vendor/genoffice/packages/pptx-engine/src/index";
import { applyEditParagraphs } from "../../src/vendor/genoffice/packages/pptx-ops/src/index";
import { makeViewport, placeTransform } from "../../src/vendor/genoffice/packages/pptx-render/src/coords";
import { DocumentError } from "../../src/lib/documents/errors";
import type {
  PptxDocumentModel,
  PptxInspectResult,
  PptxSavePlan,
  PptxTextElementModel,
} from "../../src/lib/documents/types";

const MAX_SLIDES = 500;
const SLIDE_WIDTH = 960;

function solidColor(fill: TextElement["fill"]): string | undefined {
  return fill?.type === "solid" ? fill.color : undefined;
}

function textElementModel(
  element: TextElement,
  viewport: ReturnType<typeof makeViewport>,
  identity = elementDurableId(element) ?? element.id,
  groupId?: string,
): PptxTextElementModel {
  const box = placeTransform(element.transform, viewport);
  return {
    id: identity,
    ...(groupId ? { groupId } : {}),
    ...(element.name ? { name: element.name } : {}),
    type: element.type,
    x: box.x,
    y: box.y,
    width: box.w,
    height: box.h,
    rotation: box.rotationDeg,
    ...(solidColor(element.fill) ? { fill: solidColor(element.fill) } : {}),
    ...(element.stroke?.fill.type === "solid" ? { stroke: element.stroke.fill.color } : {}),
    paragraphs: (element.text?.paragraphs ?? []).map((paragraph) => ({
      ...(paragraph.align ? { align: paragraph.align } : {}),
      runs: paragraph.runs.map((run) => ({
        text: run.text,
        ...(run.bold === undefined ? {} : { bold: run.bold }),
        ...(run.italic === undefined ? {} : { italic: run.italic }),
        ...(run.underline === undefined ? {} : { underline: run.underline }),
        ...(run.fontSize === undefined ? {} : { fontSize: run.fontSize }),
        ...(run.fontFamily ? { fontFamily: run.fontFamily } : {}),
        ...(run.color ? { color: run.color } : {}),
      })),
    })),
  };
}

function slideTextElements(
  elements: Array<TextElement | GroupElement | { type: string }>,
  viewport: ReturnType<typeof makeViewport>,
): PptxTextElementModel[] {
  const result: PptxTextElementModel[] = [];
  for (const element of elements) {
    if (element.type === "text" || element.type === "shape") {
      result.push(textElementModel(element as TextElement, viewport));
    } else if (element.type === "group") {
      const group = element as GroupElement;
      const groupId = elementDurableId(group) ?? group.id;
      for (const child of group.children) {
        if (child.type !== "text" && child.type !== "shape") continue;
        result.push(
          textElementModel(
            child as TextElement,
            viewport,
            groupChildDurableId(group, child) ?? child.id,
            groupId,
          ),
        );
      }
    }
  }
  return result;
}

export async function loadPptx(inputPath: string): Promise<PptxDocumentModel> {
  const opened = await openPptx(new Uint8Array(await readFile(inputPath)));
  const viewport = makeViewport(opened.deck.size, SLIDE_WIDTH);
  const slides = opened.deck.slides.slice(0, MAX_SLIDES).map((slide, index) => ({
    index,
    width: viewport.widthPx,
    height: viewport.heightPx,
    ...(solidColor(slide.background) ? { background: solidColor(slide.background) } : {}),
    elements: slideTextElements(slide.elements, viewport),
    notes: getSlideNotes(opened.archive, slide.path),
  }));
  return { format: "pptx", slides, truncated: opened.deck.slides.length > MAX_SLIDES };
}

export async function inspectPptx(inputPath: string): Promise<PptxInspectResult> {
  const model = await loadPptx(inputPath);
  return {
    format: "pptx",
    slideCount: model.slides.length,
    slides: model.slides.map((slide) => {
      const text = slide.elements
        .map((element) => element.paragraphs.map((paragraph) => paragraph.runs.map((run) => run.text).join("")).join("\n"))
        .filter(Boolean)
        .join("\n");
      return { index: slide.index, title: text.split("\n")[0] ?? "", text, notes: slide.notes };
    }),
    ...(model.truncated ? { truncated: true } : {}),
  };
}

export async function readPptx(inputPath: string): Promise<{ text: string }> {
  const result = await inspectPptx(inputPath);
  return {
    text: result.slides
      .map((slide) => `## Slide ${slide.index + 1}${slide.title ? `: ${slide.title}` : ""}\n${slide.text}${slide.notes ? `\n\nNotes:\n${slide.notes}` : ""}`)
      .join("\n\n"),
  };
}

export async function savePptxPlan(
  inputPath: string,
  outputPath: string,
  plan: PptxSavePlan,
): Promise<{ size: number }> {
  if (!plan || !Array.isArray(plan.textEdits) || !Array.isArray(plan.notesEdits)) {
    throw new DocumentError("invalid", "PPTX save plan is malformed");
  }
  const opened = await openPptx(new Uint8Array(await readFile(inputPath)));
  for (const edit of plan.textEdits) {
    const slide = opened.deck.slides[edit.slideIndex];
    if (!slide) throw new DocumentError("invalid", `Unknown slide ${edit.slideIndex + 1}`);
    const group = slide.elements.find(
      (candidate): candidate is GroupElement =>
        candidate.type === "group" && candidate.children.some((child) => matchesElementRef(child, edit.elementId)),
    );
    if (group) {
      const child = group.children.find((candidate) => matchesElementRef(candidate, edit.elementId));
      if (!child || (child.type !== "text" && child.type !== "shape") || !child.text) {
        throw new DocumentError("invalid", `Unknown text element ${edit.elementId}`);
      }
      child.text.paragraphs = applyEditParagraphs(child.text.paragraphs, edit.paragraphs);
      if (!patchGroupChildText(slide, group.id, child)) {
        throw new DocumentError("invalid", `Could not update grouped text element ${edit.elementId}`);
      }
      continue;
    }
    const element = slide.elements.find((candidate) => matchesElementRef(candidate, edit.elementId));
    if (!element || (element.type !== "text" && element.type !== "shape") || !element.text) {
      throw new DocumentError("invalid", `Unknown text element ${edit.elementId}`);
    }
    element.text.paragraphs = applyEditParagraphs(element.text.paragraphs, edit.paragraphs);
    element.dirty = true;
  }
  for (const edit of plan.notesEdits) {
    if (!setSlideNotes(opened, edit.slideIndex, edit.text)) {
      throw new DocumentError("invalid", `Could not update notes for slide ${edit.slideIndex + 1}`);
    }
  }
  const bytes = await savePptx(opened);
  await writeFile(outputPath, bytes);
  return { size: bytes.byteLength };
}
