/**
 * Pure helpers driving the DOCX toolbar: every function takes the Tiptap
 * `Editor` (no React), so the same logic is reachable from tests with a bare
 * `EditorState`. Ports of the upstream Ribbon logic (upstream at
 * /tmp/genoffice-upstream — newer than the vendored tree; matched to the
 * vendored schema in apps/docs/src/renderer/editor/extensions.ts).
 */
import type { Editor } from "@tiptap/core";
import { TextSelection, type Command } from "@tiptap/pm/state";
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
  splitCell,
} from "@tiptap/pm/tables";

import { setSelectionAlign } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/direction";
import { stepParagraphIndent } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/indent";
import { tableModelToPmNode } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/convert";
import { isEastAsianFontName } from "../../../vendor/genoffice/apps/docs/src/renderer/font-list";

/** Engine TableModel, reached through the renderer module (packages/ imports are lint-banned client-side). */
type TableModel = Parameters<typeof tableModelToPmNode>[0];

export type ParagraphStyleKey = "p" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
export type AlignKey = "left" | "center" | "right" | "justify";
export type ListKind = "bullet" | "ordered";

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
  align: AlignKey | null;
  listKind: ListKind | null;
  inTable: boolean;
  canMergeCells: boolean;
  canSplitCell: boolean;
  canUndo: boolean;
  canRedo: boolean;
  linkHref: string | null;
}

const PARA_BLOCKS = new Set(["docParagraph", "docHeading", "docListItem"]);

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
