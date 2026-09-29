/**
 * Pure find / replace over a ProseMirror doc, shared by the DOCX find panel
 * and its tests. Matches never cross a textblock boundary; inline atoms and
 * tracked-deleted runs read as a separator so they neither match nor join
 * the words around them.
 */
import type { Node as PmNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";

import { findInText, type FindOptions } from "@genoffice/ui";

export type { FindOptions };

export interface FindMatch {
  from: number;
  to: number;
}

const SEPARATOR = "\uFFFC";

const isDeleted = (node: PmNode) => node.marks.some((m) => m.type.name === "del");

interface Segment {
  offset: number;
  pos: number;
  length: number;
}

export function findMatches(doc: PmNode, query: string, opts: FindOptions): FindMatch[] {
  if (!query) return [];
  const out: FindMatch[] = [];
  doc.descendants((block, blockPos) => {
    if (!block.isTextblock) return true;
    let text = "";
    const segments: Segment[] = [];
    block.forEach((child, offset) => {
      const pos = blockPos + 1 + offset;
      if (child.isText && !isDeleted(child)) {
        segments.push({ offset: text.length, pos, length: child.nodeSize });
        text += child.text ?? "";
      } else {
        text += SEPARATOR.repeat(Math.max(1, child.isText ? (child.text?.length ?? 1) : 1));
      }
    });
    const at = (offset: number) => {
      const seg = segments.find((s) => offset >= s.offset && offset < s.offset + s.length);
      return seg ? seg.pos + (offset - seg.offset) : null;
    };
    for (const start of findInText(text, query, opts)) {
      if (text.slice(start, start + query.length).includes(SEPARATOR)) continue;
      const from = at(start);
      const last = at(start + query.length - 1);
      if (from != null && last != null) out.push({ from, to: last + 1 });
    }
    return false;
  });
  return out;
}

/** Index of the match the selection sits on, or -1. */
export function currentMatchIndex(matches: FindMatch[], sel: { from: number; to: number }): number {
  return matches.findIndex((m) => m.from === sel.from && m.to === sel.to);
}

/** Next (or previous) match relative to the selection, wrapping; null when there are none. */
export function stepMatch(
  matches: FindMatch[],
  sel: { from: number; to: number },
  dir: 1 | -1,
): FindMatch | null {
  if (matches.length === 0) return null;
  if (dir === 1) return matches.find((m) => m.from >= sel.to) ?? matches[0]!;
  const before = matches.filter((m) => m.to <= sel.from);
  return before[before.length - 1] ?? matches[matches.length - 1]!;
}

export function selectMatch(state: EditorState, match: FindMatch): Transaction {
  return state.tr.setSelection(TextSelection.create(state.doc, match.from, match.to)).scrollIntoView();
}

/**
 * Replace matches (all given ranges, applied back to front so earlier
 * positions stay valid). The replacement takes the marks of the first
 * replaced character, so bold/color/size survive.
 */
export function replaceTransaction(
  state: EditorState,
  matches: FindMatch[],
  replacement: string,
): Transaction | null {
  if (matches.length === 0) return null;
  const tr = state.tr;
  for (const m of [...matches].sort((a, b) => b.from - a.from)) {
    if (replacement === "") {
      tr.delete(m.from, m.to);
    } else {
      const marks = state.doc.resolve(m.from + 1).marks();
      tr.replaceWith(m.from, m.to, state.schema.text(replacement, marks));
    }
  }
  return tr;
}
