/**
 * Pure helpers for the tracked-changes panel: a display-ready list over the
 * vendored `collectRevisions`, plus selection of a revision range. Accepting
 * or rejecting is the vendored `applyRevisions` (ordinary transactions, so it
 * flows through the same dirty/save-plan path).
 */
import type { Node as PmNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

import {
  TRACK_IGNORE,
  collectRevisions,
  type RevisionRange,
} from "../../../vendor/genoffice/apps/docs/src/renderer/editor/revisions";

export type { RevisionRange };

export type RevisionGroup = "insert" | "delete" | "format" | "structure";

export interface RevisionItem {
  range: RevisionRange;
  group: RevisionGroup;
  /** Affected text (truncated); empty for structural changes. */
  text: string;
}

const GROUP_BY_KIND: Record<RevisionRange["kind"], RevisionGroup> = {
  ins: "insert",
  moveTo: "insert",
  del: "delete",
  both: "delete",
  moveFrom: "delete",
  pPrChange: "format",
  rPrChange: "format",
  rowIns: "structure",
  rowDel: "structure",
  cellIns: "structure",
  cellDel: "structure",
  blockIns: "structure",
  blockDel: "structure",
};

const MAX_TEXT = 120;

export function listRevisions(doc: PmNode): RevisionItem[] {
  return collectRevisions(doc).map((range) => {
    const raw = range.to > range.from ? doc.textBetween(range.from, range.to, " ", " ") : "";
    return {
      range,
      group: GROUP_BY_KIND[range.kind],
      text: raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}…` : raw,
    };
  });
}

export function selectRevision(state: EditorState, range: RevisionRange): Transaction {
  const tr = state.tr;
  // between(): row/cell range ends are not text positions — snap to a selectable one
  tr.setSelection(TextSelection.between(tr.doc.resolve(range.from), tr.doc.resolve(range.to)));
  tr.setMeta(TRACK_IGNORE, true);
  return tr.scrollIntoView();
}
