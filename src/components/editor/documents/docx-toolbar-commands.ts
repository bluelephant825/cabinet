/**
 * Pure helpers driving the DOCX toolbar: every function takes the Tiptap
 * `Editor` (no React), so the same logic is reachable from tests with a bare
 * `EditorState`. Ports of the upstream Ribbon logic (upstream at
 * /tmp/genoffice-upstream — newer than the vendored tree; matched to the
 * vendored schema in apps/docs/src/renderer/editor/extensions.ts).
 */
import type { Editor } from "@tiptap/core";
import { TextSelection, type Command, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { Node as PmNode } from "@tiptap/pm/model";
import {
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  deleteTable,
  isInTable,
  mergeCells,
  setCellAttr,
  splitCell,
} from "@tiptap/pm/tables";

import { setSelectionAlign } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/direction";
import { stepParagraphIndent } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/indent";
import { insertPageBreak } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/page-break";
import { tableModelToPmNode } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/convert";
import { isEastAsianFontName } from "../../../vendor/genoffice/apps/docs/src/renderer/font-list";

/** Engine TableModel, reached through the renderer module (packages/ imports are lint-banned client-side). */
type TableModel = Parameters<typeof tableModelToPmNode>[0];

export type ParagraphStyleKey = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
export type AlignKey = "left" | "center" | "right" | "justify";
export type ListKind = "bullet" | "ordered";
export type VertAlign = "superscript" | "subscript";

/** Line-spacing multiples offered by the toolbar (Word's list). */
export const LINE_SPACING_OPTIONS = [1, 1.15, 1.5, 2, 2.5, 3] as const;
/** Paragraph space-before/after choices in points. */
export const PARA_SPACING_PT_OPTIONS = [0, 6, 8, 10, 12, 18, 24] as const;

export interface DocxFormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  paragraphStyle: ParagraphStyleKey;
  /** Primary display font name, or null when unset / mixed. */
  font: string | null;
  sizeHalfPoints: number | null;
  /** 6-hex without '#'. */
  color: string | null;
  /** OOXML highlight name (see HIGHLIGHT_CSS) or null. */
  highlight: string | null;
  vertAlign: VertAlign | null;
  /** Line-spacing multiple of the caret paragraph; null when unset or a fixed (atLeast/exact) rule. */
  lineSpacing: number | null;
  /** Space before/after the caret paragraph in points; null when unset. */
  spaceBeforePt: number | null;
  spaceAfterPt: number | null;
  align: AlignKey | null;
  listKind: ListKind | null;
  inTable: boolean;
  canMergeCells: boolean;
  canSplitCell: boolean;
  canUndo: boolean;
  canRedo: boolean;
  linkHref: string | null;
  /** w:pStyle of the caret paragraph (null = the default style). */
  styleId: string | null;
  tableAlign: TableAlignKey | null;
  /** Table has explicit single-line borders on every side. */
  tableBordered: boolean;
  /** Shading (hex, no '#') and vertical alignment of the caret cell. */
  cellFill: string | null;
  cellVAlign: CellVAlignKey | null;
  repeatHeader: boolean;
}

export type TableAlignKey = "left" | "center" | "right";
export type CellVAlignKey = "top" | "center" | "bottom";

const PARA_BLOCKS = new Set(["docParagraph", "docHeading", "docListItem"]);

/** Line-spacing multiple carried by a paragraph's attrs, or null (unset / fixed-height rule). */
export function lineSpacingOf(attrs: Record<string, unknown>): number | null {
  if (attrs.lineRule === "exact" || attrs.lineRule === "atLeast") return null;
  const mult = Number(attrs.lineSpacing);
  if (mult > 0) return mult;
  const raw = Number(attrs.lineRawTwips);
  return raw > 0 ? Math.round((raw / 240) * 100) / 100 : null;
}

const twipsToPt = (v: unknown): number | null =>
  v == null || Number.isNaN(Number(v)) ? null : Number(v) / 20;

export function readFormatState(editor: Editor): DocxFormatState {
  const state = editor.state;
  const style = editor.getAttributes("docTextStyle");
  let paragraphStyle: ParagraphStyleKey = "p";
  if (editor.isActive("docHeading")) {
    const level = Math.min(Math.max(Number(editor.getAttributes("docHeading").level) || 1, 1), 6);
    paragraphStyle = `h${level}` as ParagraphStyleKey;
  }
  let align: AlignKey | null = null;
  for (const name of PARA_BLOCKS) {
    if (editor.isActive(name)) {
      align = (editor.getAttributes(name).align as AlignKey | null) ?? null;
      break;
    }
  }
  const inTable = isInTable(state);
  const caretPara = state.selection.$from.parent;
  const paraAttrs: Record<string, unknown> =
    caretPara.isTextblock && "lineSpacing" in caretPara.attrs ? caretPara.attrs : {};
  const tableInfo = inTable ? caretTableInfo(state) : null;
  return {
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    strike: editor.isActive("strike"),
    paragraphStyle,
    font: (style.fontAscii as string | null) ?? (style.font as string | null) ?? null,
    sizeHalfPoints: (style.sizeHalfPoints as number | null) ?? null,
    color: (style.color as string | null) ?? null,
    highlight: (style.highlight as string | null) ?? null,
    vertAlign: (style.vertAlign as VertAlign | null) ?? null,
    lineSpacing: lineSpacingOf(paraAttrs),
    spaceBeforePt: twipsToPt(paraAttrs.spaceBefore),
    spaceAfterPt: twipsToPt(paraAttrs.spaceAfter),
    align,
    listKind: editor.isActive("docListItem")
      ? ((editor.getAttributes("docListItem").kind as ListKind) ?? "bullet")
      : null,
    inTable,
    canMergeCells: inTable && mergeCells(state),
    canSplitCell: inTable && splitCell(state),
    canUndo: editor.can().undo(),
    canRedo: editor.can().redo(),
    linkHref: editor.isActive("link")
      ? ((editor.getAttributes("link").href as string) ?? null)
      : null,
    styleId: (paraAttrs.styleId as string | null | undefined) ?? null,
    tableAlign: (tableInfo?.table.attrs.tblAlign as TableAlignKey | null | undefined) ?? null,
    tableBordered: tableInfo ? tableIsBordered(tableInfo.table) : false,
    cellFill: (tableInfo?.cell?.attrs.fill as string | null | undefined) ?? null,
    cellVAlign: (tableInfo?.cell?.attrs.vAlign as CellVAlignKey | null | undefined) ?? null,
    repeatHeader: Boolean(tableInfo?.row?.attrs.repeatHeader),
  };
}

/**
 * Apply a paragraph style across the selection: convert touched textblocks to
 * `docParagraph`/`docHeading` and shed their direct color/size/font marks so
 * the style shows through (port of upstream ribbon-tabs applyParagraphStyle).
 */
export function applyParagraphStyle(editor: Editor, key: ParagraphStyleKey): boolean {
  let c = editor.chain().focus();
  if (key === "p") c = c.setNode("docParagraph");
  else c = c.setNode("docHeading", { level: Number(key.slice(1)) });
  return c
    .command(({ tr }) => {
      const { from, to } = tr.selection;
      let start = from;
      let end = to;
      tr.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isTextblock) {
          start = Math.min(start, pos + 1);
          end = Math.max(end, pos + node.nodeSize - 1);
        }
      });
      const type = editor.schema.marks.docTextStyle;
      const jobs: { from: number; to: number; attrs: Record<string, unknown> | null }[] = [];
      tr.doc.nodesBetween(start, end, (node, pos) => {
        if (!node.isText) return;
        const m = node.marks.find((mm) => mm.type === type);
        if (!m) return;
        if (
          m.attrs.color == null &&
          m.attrs.sizeHalfPoints == null &&
          m.attrs.font == null &&
          m.attrs.fontAscii == null
        )
          return;
        const attrs = {
          ...m.attrs,
          color: null,
          sizeHalfPoints: null,
          font: null,
          fontAscii: null,
        };
        const keep = Object.values(attrs).some((v) => v !== null);
        jobs.push({
          from: Math.max(pos, start),
          to: Math.min(pos + node.nodeSize, end),
          attrs: keep ? attrs : null,
        });
      });
      for (const job of jobs) {
        tr.removeMark(job.from, job.to, type);
        if (job.attrs) tr.addMark(job.from, job.to, type.create(job.attrs));
      }
      return true;
    })
    .run();
}

/**
 * Patch `docTextStyle` attrs, merging over whatever the cursor/selection
 * already carries so unrelated attrs survive. `null` clears an attr. `font`
 * routes to the eastAsia or Latin slot the way Word's font box does.
 */
export function setTextStyle(
  editor: Editor,
  patch: Partial<{
    font: string | null;
    sizeHalfPoints: number | null;
    color: string | null;
    highlight: string | null;
    vertAlign: VertAlign | null;
  }>,
): boolean {
  const current = editor.getAttributes("docTextStyle") as Record<string, unknown>;
  const merged: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key === "font") {
      if (value == null) {
        merged.font = null;
        merged.fontAscii = null;
      } else if (isEastAsianFontName(String(value))) {
        merged.font = value;
      } else {
        merged.fontAscii = value;
      }
      continue;
    }
    merged[key] = value;
  }
  return editor.chain().focus().setMark("docTextStyle", merged).run();
}

/** Clicking the active script again clears it; the two scripts are mutually exclusive. */
export function nextVertAlign(current: VertAlign | null, requested: VertAlign): VertAlign | null {
  return current === requested ? null : requested;
}

export function toggleVertAlign(editor: Editor, requested: VertAlign): boolean {
  const current = editor.getAttributes("docTextStyle").vertAlign as VertAlign | null | undefined;
  return setTextStyle(editor, { vertAlign: nextVertAlign(current ?? null, requested) });
}

/** Word's Insert → Page Break (the vendored helper marks the paragraph after the caret). */
export function insertBreak(editor: Editor): boolean {
  return insertPageBreak(editor);
}

type ParaAttrs = Record<string, unknown>;

/**
 * Patch the paragraph-level attrs of every textblock the selection touches
 * (pure: EditorState in, Transaction out; null when nothing changed). `patch`
 * may be a function of the block's current attrs.
 */
export function paragraphAttrsTransaction(
  state: EditorState,
  patch: ParaAttrs | ((attrs: ParaAttrs) => ParaAttrs),
): Transaction | null {
  const { from, to } = state.selection;
  const tr = state.tr;
  let changed = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock || !("lineSpacing" in node.attrs)) return true;
    const next = typeof patch === "function" ? patch(node.attrs) : patch;
    const attrs = { ...node.attrs, ...next };
    if (Object.keys(next).some((k) => node.attrs[k] !== attrs[k])) {
      tr.setNodeMarkup(pos, undefined, attrs);
      changed = true;
    }
    return false;
  });
  return changed ? tr : null;
}

export function applyParagraphAttrs(
  editor: Editor,
  patch: ParaAttrs | ((attrs: ParaAttrs) => ParaAttrs),
): boolean {
  const tr = paragraphAttrsTransaction(editor.state, patch);
  if (!tr) return false;
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

/** Multiple line spacing exactly as parse emits it (auto rule, raw twips = multiple × 240). */
export function lineSpacingPatch(multiple: number): ParaAttrs {
  return { lineSpacing: multiple, lineRule: "auto", lineRawTwips: Math.round(multiple * 240) };
}

/** Space before/after in points; a style-chain auto flag is overridden explicitly. */
export function paragraphSpacingPatch(
  which: "before" | "after",
  pt: number,
): (attrs: ParaAttrs) => ParaAttrs {
  const key = which === "before" ? "spaceBefore" : "spaceAfter";
  const autoKey = `${key}Auto`;
  return (attrs) => ({
    [key]: Math.round(pt * 20),
    ...(attrs[autoKey] ? { [autoKey]: false } : {}),
  });
}

export function setAlign(editor: Editor, align: AlignKey): boolean {
  return setSelectionAlign(editor, align);
}

/** First numId used by an existing same-kind list item in the doc (pure). */
export function findNumIdOfKindInDoc(doc: PmNode, kind: ListKind): string | null {
  let found: string | null = null;
  doc.descendants((node) => {
    if (found !== null) return false;
    if (node.type.name === "docListItem" && node.attrs.kind === kind && node.attrs.numId) {
      found = node.attrs.numId as string;
      return false;
    }
    return true;
  });
  return found;
}

/**
 * Word's list toggle: same kind active → back to paragraph; otherwise reuse an
 * existing same-kind numId or allocate a fresh definition via `allocateNumId`
 * (supplied by the frame, which owns the pending-numbering state).
 */
export function toggleList(
  editor: Editor,
  kind: ListKind,
  allocateNumId: (kind: ListKind) => string | null,
): boolean {
  if (editor.isActive("docListItem", { kind })) {
    return editor.chain().focus().setNode("docParagraph").run();
  }
  const numId =
    findNumIdOfKindInDoc(editor.state.doc, kind) ?? allocateNumId(kind);
  return editor.chain().focus().setNode("docListItem", { kind, numId, ilvl: 0 }).run();
}

/** Increase/decrease indent (list items change ilvl — handled inside the vendored helper). */
export function changeIndent(editor: Editor, delta: 1 | -1): boolean {
  return stepParagraphIndent(editor, delta);
}

/** http(s)/mailto only — anything else is rejected without touching the doc. */
export function linkHrefAllowed(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href.trim());
}

export function setLink(editor: Editor, href: string | null): boolean {
  if (href == null) {
    return editor.chain().focus().unsetMark("link").run();
  }
  if (!linkHrefAllowed(href)) return false;
  return editor
    .chain()
    .focus()
    .extendMarkRange("link")
    .setMark("link", { href: href.trim() })
    .run();
}

const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLS = 63;

/** Insert a table (port of upstream insertTableAt, incl. the nested-in-cell branch). */
export function insertTable(editor: Editor, rows: number, cols: number): boolean {
  const r = Math.min(MAX_TABLE_ROWS, Math.max(1, Math.round(rows)));
  const c = Math.min(MAX_TABLE_COLS, Math.max(1, Math.round(cols)));
  // Word default single 0.5pt borders — also what save writes; without them
  // the fresh table renders invisible until reload.
  const line = { style: "single", szEighths: 4, color: "auto" };
  const table = {
    rows: Array.from({ length: r }, () =>
      Array.from({ length: c }, () => ({ paras: [""] })),
    ),
    colWidthsPct: Array.from({ length: c }, () => 100 / c),
    widthPct: 100,
    autoFit: "window" as const,
    borders: {
      top: line,
      bottom: line,
      left: line,
      right: line,
      insideH: line,
      insideV: line,
    },
  };
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === "docTableCell" || name === "docTableHeader") {
      return editor
        .chain()
        .focus()
        .insertContentAt($from.end(depth), [
          { type: "docNestedTable", attrs: { model: table } },
          { type: "docParagraph" },
        ])
        .run();
    }
  }
  const node = tableModelToPmNode(table as unknown as TableModel);
  // An empty paragraph stays below the new table (Word behavior); the caret
  // lands in the first cell either way.
  const block = $from.depth > 0 ? $from.node(1) : null;
  const at = block?.isTextblock && block.content.size === 0 ? $from.before(1) : null;
  const chain = editor.chain().focus();
  if (at == null) return chain.insertContent(node).run();
  return chain
    .insertContentAt(at, node)
    .command(({ tr }) => {
      tr.setSelection(TextSelection.near(tr.doc.resolve(at + 1)));
      return true;
    })
    .run();
}

function tableOp(editor: Editor, cmd: Command): boolean {
  return cmd(editor.state, editor.view.dispatch);
}

export const tableAddRowBefore = (e: Editor) => tableOp(e, addRowBefore);
export const tableAddRowAfter = (e: Editor) => tableOp(e, addRowAfter);
export const tableAddColumnBefore = (e: Editor) => tableOp(e, addColumnBefore);
export const tableAddColumnAfter = (e: Editor) => tableOp(e, addColumnAfter);
export const tableDeleteRow = (e: Editor) => tableOp(e, deleteRow);
export const tableDeleteColumn = (e: Editor) => tableOp(e, deleteColumn);
export const tableDeleteTable = (e: Editor) => tableOp(e, deleteTable);
export const tableMergeCells = (e: Editor) => tableOp(e, mergeCells);
export const tableSplitCell = (e: Editor) => tableOp(e, splitCell);

// ── pending numbering (pure pieces; the frame owns the mutable state) ──────

/** Next free numId: above the blank template's 1/2, every existing and pending id, and the floor. */
export function nextNumId(
  existingIds: Iterable<string>,
  pendingIds: Iterable<string>,
  floor: number,
): string {
  let max = 2;
  for (const id of existingIds) max = Math.max(max, parseInt(id, 10) || 0);
  for (const id of pendingIds) max = Math.max(max, parseInt(id, 10) || 0);
  max = Math.max(max, floor);
  return String(max + 1);
}

/** Structural twin of the engine's NumberingDef (avoids a packages/ import client-side). */
export interface PendingNumberingDef {
  numId: string;
  abstractNumId: string;
  levels: Record<
    number,
    {
      numFmt: string;
      lvlText: string;
      start: number;
      indentLeft: number;
      hanging: number;
    }
  >;
  startOverrides: Record<number, number>;
}

/** Five-level pending definition for instant marker display (upstream createNumberingDef). */
export function makePendingNumberingDef(numId: string, kind: ListKind): PendingNumberingDef {
  return {
    numId,
    abstractNumId: `pending-${numId}`,
    levels: Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        i,
        {
          numFmt: kind === "bullet" ? "bullet" : "decimal",
          lvlText: kind === "bullet" ? "" : `%${i + 1}.`,
          start: 1,
          indentLeft: 720 * (i + 1),
          hanging: 360,
        },
      ]),
    ),
    startOverrides: {},
  };
}

// ── horizontal rule (paragraph bottom border — the w:pBdr Word's own `---` makes) ──

const RULE_ATTRS = { borders: "b", borderLines: JSON.stringify({ b: { szPt: 0.75 } }) };

/**
 * Insert a horizontal rule: an empty paragraph carrying a single bottom border,
 * followed by an empty paragraph the caret moves to. An empty caret paragraph
 * becomes the rule itself. Pure (state in, transaction out; null when the caret
 * is not in a textblock).
 */
export function horizontalRuleTransaction(state: EditorState): Transaction | null {
  const { $from } = state.selection;
  const para = $from.parent;
  const paraType = state.schema.nodes.docParagraph;
  if (!para.isTextblock || !paraType) return null;
  const tr = state.tr;
  const empty = para.content.size === 0 && para.type === paraType;
  let after: number;
  if (empty) {
    tr.setNodeMarkup($from.before(), undefined, { ...para.attrs, ...RULE_ATTRS });
    after = $from.after();
  } else {
    after = $from.after();
    tr.insert(after, paraType.create(RULE_ATTRS));
    after += tr.doc.nodeAt(after)!.nodeSize;
  }
  tr.insert(after, paraType.create());
  return tr.setSelection(TextSelection.near(tr.doc.resolve(after + 1))).scrollIntoView();
}

export function insertHorizontalRule(editor: Editor): boolean {
  const tr = horizontalRuleTransaction(editor.state);
  if (!tr) return false;
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

// ── insert image ───────────────────────────────────────────────────────────

/** Largest image accepted (bytes of the file). The bytes ride the save plan as base64. */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
/** Inserted pictures are scaled down to fit the text column (CSS px). */
export const IMAGE_MAX_WIDTH_PX = 600;

export type ImageMime = "image/png" | "image/jpeg" | "image/gif";

/** png / jpeg / gif data URLs only (the formats the engine embeds). */
export function parseImageDataUrl(dataUrl: string): { mime: ImageMime; base64: string } | null {
  const m = /^data:(image\/(?:png|jpeg|gif));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  return m ? { mime: m[1] as ImageMime, base64: m[2] } : null;
}

/** Scale to the column width, never upscale; whole px, at least 1. */
export function fitImageSize(
  width: number,
  height: number,
  maxWidth = IMAGE_MAX_WIDTH_PX,
): { widthPx: number; heightPx: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const scale = Math.min(1, maxWidth / w);
  return { widthPx: Math.max(1, Math.round(w * scale)), heightPx: Math.max(1, Math.round(h * scale)) };
}

/** A new-image block the way `pmDocToSavePlan` expects it (genImage carries the bytes to embed). */
export function imageBlockJson(
  dataUrl: string,
  size: { widthPx: number; heightPx: number },
  altText = "",
): Record<string, unknown> | null {
  const parsed = parseImageDataUrl(dataUrl);
  if (!parsed) return null;
  return {
    type: "docProtected",
    attrs: {
      docxIndex: null,
      blockType: "image",
      label: "Image",
      imageDataUrl: dataUrl,
      imageWidthPx: size.widthPx,
      imageHeightPx: size.heightPx,
      genImage: {
        base64: parsed.base64,
        mime: parsed.mime,
        widthPx: size.widthPx,
        heightPx: size.heightPx,
        ...(altText ? { altText } : {}),
      },
    },
  };
}

/** Insert below the top-level block holding the caret (an empty paragraph keeps the doc typable). */
export function insertImageBlock(
  editor: Editor,
  dataUrl: string,
  size: { widthPx: number; heightPx: number },
  altText = "",
): boolean {
  const node = imageBlockJson(dataUrl, size, altText);
  if (!node) return false;
  const { doc, selection } = editor.state;
  const at = selection.$from.depth >= 1 ? selection.$from.after(1) : doc.content.size;
  const content: Record<string, unknown>[] = [node];
  if (at >= doc.content.size) content.push({ type: "docParagraph" });
  return editor.chain().focus().insertContentAt(at, content).run();
}

// ── styles gallery ─────────────────────────────────────────────────────────

/** The bits of the engine's StyleInfo the gallery reads. */
export interface StyleEntry {
  styleId: string;
  name: string;
  type: string;
  headingLevel?: number;
  semiHidden?: boolean;
  qFormat?: boolean;
  linkedCharShell?: boolean;
  isDefault?: boolean;
  display?: {
    sizeHalfPoints?: number;
    color?: string;
    bold?: boolean;
    italic?: boolean;
    font?: string;
    fontAscii?: string;
  };
}

/**
 * Paragraph styles worth offering (Word's quick-style logic): visible paragraph
 * styles that are the default, a heading, or flagged qFormat. Default first,
 * then headings by level, then the rest by name.
 */
export function listParagraphStyles(entries: Iterable<[string, unknown]>): StyleEntry[] {
  const out: StyleEntry[] = [];
  for (const [, raw] of entries) {
    const s = raw as StyleEntry;
    if (s.type !== "paragraph" || s.semiHidden || s.linkedCharShell) continue;
    if (s.isDefault || s.headingLevel || s.qFormat) out.push(s);
  }
  const rank = (s: StyleEntry) => (s.isDefault ? 0 : s.headingLevel ? s.headingLevel : 100);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * Apply a document paragraph style: heading styles become docHeading (their
 * level), everything else docParagraph; the styleId is what save writes as
 * w:pStyle (null for the document default).
 */
export function applyDocumentStyle(editor: Editor, style: StyleEntry): boolean {
  const key: ParagraphStyleKey =
    style.headingLevel && style.headingLevel <= 6 ? (`h${style.headingLevel}` as ParagraphStyleKey) : "p";
  applyParagraphStyle(editor, key);
  applyParagraphAttrs(editor, { styleId: style.isDefault ? null : style.styleId });
  return true;
}

const CSS_ID = /^[A-Za-z0-9_.-]+$/;
const CSS_COLOR = /^[0-9A-Fa-f]{6}$/;
const CSS_FONT = /^[^"'\\;{}<>]+$/;

/**
 * Minimal display CSS for the gallery's styles, keyed on the `data-style`
 * attribute the vendored schema renders: size, weight, italics, color and
 * face. Only values that pass strict allow-lists are emitted.
 */
export function paragraphStyleCss(styles: StyleEntry[]): string {
  const rules: string[] = [];
  for (const s of styles) {
    if (s.isDefault || !CSS_ID.test(s.styleId) || !s.display) continue;
    const d = s.display;
    const decls: string[] = [];
    if (d.sizeHalfPoints && d.sizeHalfPoints > 0) decls.push(`font-size:${d.sizeHalfPoints / 2}pt`);
    if (d.bold !== undefined) decls.push(`font-weight:${d.bold ? 700 : 400}`);
    if (d.italic !== undefined) decls.push(`font-style:${d.italic ? "italic" : "normal"}`);
    if (d.color && CSS_COLOR.test(d.color)) decls.push(`color:#${d.color}`);
    const face = d.fontAscii ?? d.font;
    if (face && CSS_FONT.test(face)) decls.push(`font-family:"${face}",sans-serif`);
    if (decls.length) rules.push(`.doc-page [data-style="${s.styleId}"]{${decls.join(";")}}`);
  }
  return rules.join("\n");
}

// ── table properties ───────────────────────────────────────────────────────

interface CaretTableInfo {
  table: PmNode;
  tablePos: number;
  row: PmNode | null;
  rowPos: number;
  cell: PmNode | null;
}

/** Innermost table around the caret, with its row and cell. */
export function caretTableInfo(state: EditorState): CaretTableInfo | null {
  const { $from } = state.selection;
  let row: PmNode | null = null;
  let rowPos = -1;
  let cell: PmNode | null = null;
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d);
    const name = node.type.name;
    if (name === "docTableCell" || name === "docTableHeader") cell ??= node;
    else if (name === "docTableRow") {
      row ??= node;
      if (rowPos < 0) rowPos = $from.before(d);
    } else if (name === "docTable") return { table: node, tablePos: $from.before(d), row, rowPos, cell };
  }
  return null;
}

const BORDER_SIDES = ["top", "bottom", "left", "right", "insideH", "insideV"] as const;
const SINGLE = { style: "single", szEighths: 4, color: "auto" };
const NONE = { style: "none", szEighths: 0, color: "auto" };

/**
 * Cell borders override the table's (Word), and only they reach the save
 * plan, so a cell side set to none means the table is not bordered.
 */
export function tableIsBordered(table: PmNode): boolean {
  let cellNone = false;
  table.descendants((node) => {
    if (node.type.name !== "docTableCell" && node.type.name !== "docTableHeader") return true;
    const cb = node.attrs.borders as Record<string, { style?: string }> | null;
    if (cb && Object.values(cb).some((side) => side?.style === "none")) cellNone = true;
    return false;
  });
  if (cellNone) return false;
  const b = table.attrs.borders as Record<string, { style?: string }> | null;
  return !!b && BORDER_SIDES.every((k) => b[k] && b[k].style !== "none");
}

/** Patch the enclosing table's attrs (null when not in a table or nothing changes). */
export function tableAttrsTransaction(
  state: EditorState,
  patch: Record<string, unknown>,
): Transaction | null {
  const info = caretTableInfo(state);
  if (!info) return null;
  const { table, tablePos } = info;
  if (Object.keys(patch).every((k) => table.attrs[k] === patch[k])) return null;
  return state.tr.setNodeMarkup(tablePos, undefined, { ...table.attrs, ...patch });
}

/**
 * Word's Borders → All Borders / No Border: sets the table borders AND every
 * cell's own borders, because the save plan detects edits through the cells.
 */
export function tableBordersTransaction(state: EditorState, on: boolean): Transaction | null {
  const info = caretTableInfo(state);
  if (!info) return null;
  const line = on ? SINGLE : NONE;
  const borders = Object.fromEntries(BORDER_SIDES.map((k) => [k, line]));
  const cellBorders = { top: line, bottom: line, left: line, right: line };
  const tr = state.tr.setNodeMarkup(info.tablePos, undefined, { ...info.table.attrs, borders });
  const start = info.tablePos + 1;
  info.table.descendants((node, pos) => {
    if (node.type.name === "docTableCell" || node.type.name === "docTableHeader") {
      tr.setNodeMarkup(tr.mapping.map(start + pos), undefined, { ...node.attrs, borders: cellBorders });
      return false;
    }
    return true;
  });
  return tr;
}

/** Repeat-as-header flag on the caret row (w:tblHeader). */
export function repeatHeaderTransaction(state: EditorState, on: boolean): Transaction | null {
  const info = caretTableInfo(state);
  if (!info?.row || info.rowPos < 0 || Boolean(info.row.attrs.repeatHeader) === on) return null;
  return state.tr.setNodeMarkup(info.rowPos, undefined, {
    ...info.row.attrs,
    repeatHeader: on,
    repeatHeaderEdited: true,
  });
}

function dispatchTr(editor: Editor, tr: Transaction | null): boolean {
  if (!tr) return false;
  editor.view.dispatch(tr);
  editor.view.focus();
  return true;
}

export const setTableAlign = (e: Editor, align: TableAlignKey | null) =>
  dispatchTr(e, tableAttrsTransaction(e.state, { tblAlign: align }));
export const setTableBordered = (e: Editor, on: boolean) =>
  dispatchTr(e, tableBordersTransaction(e.state, on));
export const setRepeatHeader = (e: Editor, on: boolean) =>
  dispatchTr(e, repeatHeaderTransaction(e.state, on));
/** Shading / vertical alignment of the selected cells (prosemirror-tables setCellAttr). */
export const setCellFill = (e: Editor, hex: string | null) =>
  tableOp(e, setCellAttr("fill", hex && /^[0-9A-Fa-f]{6}$/.test(hex) ? hex.toUpperCase() : null));
export const setCellVAlign = (e: Editor, v: CellVAlignKey | null) =>
  tableOp(e, setCellAttr("vAlign", v));
