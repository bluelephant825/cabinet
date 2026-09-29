/**
 * Pure comment-thread helpers for the DOCX comments panel: anchors come from
 * the `comment` marks in the live ProseMirror doc, threads from the
 * word/comments.xml list the worker returns. Replies are new list entries
 * whose id is added to the parent's anchor marks (Word: replies share the
 * parent range); the whole list is what a save writes back.
 */
import type { Node as PmNode } from "@tiptap/pm/model";

import type { DocxComment } from "@/lib/documents/types";
import { nextCommentId } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/comments";

export type { DocxComment };

export interface CommentAnchor {
  from: number;
  to: number;
  /** Anchored text (all marked runs, joined). */
  text: string;
}

export interface CommentThread {
  root: DocxComment;
  replies: DocxComment[];
  anchor: CommentAnchor | null;
}

/** id → anchored range, read from every text node carrying a comment mark for that id. */
export function commentAnchors(doc: PmNode): Map<string, CommentAnchor> {
  const out = new Map<string, CommentAnchor>();
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const mark = node.marks.find((m) => m.type.name === "comment");
    if (!mark) return false;
    for (const id of String(mark.attrs.ids ?? "").split(" ").filter(Boolean)) {
      const prev = out.get(id);
      const to = pos + node.nodeSize;
      out.set(id, {
        from: prev ? Math.min(prev.from, pos) : pos,
        to: prev ? Math.max(prev.to, to) : to,
        text: (prev?.text ?? "") + (node.text ?? ""),
      });
    }
    return false;
  });
  return out;
}

/**
 * Group the flat list into threads: roots in document order (unanchored ones
 * last, list order), replies under their root in list order. A reply whose
 * parent is missing is shown as its own root rather than dropped.
 */
export function buildThreads(
  comments: readonly DocxComment[],
  anchors: ReadonlyMap<string, CommentAnchor>,
): CommentThread[] {
  const ids = new Set(comments.map((c) => c.id));
  const roots = comments.filter((c) => !c.parentId || !ids.has(c.parentId));
  const threads = roots.map((root) => ({
    root,
    replies: comments.filter((c) => c.parentId === root.id),
    anchor: anchors.get(root.id) ?? null,
  }));
  const order = new Map(roots.map((r, i) => [r.id, i]));
  return threads.sort((a, b) => {
    if (a.anchor && b.anchor) return a.anchor.from - b.anchor.from;
    if (a.anchor) return -1;
    if (b.anchor) return 1;
    return order.get(a.root.id)! - order.get(b.root.id)!;
  });
}

export function initialsOf(author: string): string {
  return (
    author
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => Array.from(w)[0]!.toUpperCase())
      .join("") || "?"
  );
}

/** Append a reply to a thread (replies always attach to the thread root, as Word does). */
export function withReply(
  comments: readonly DocxComment[],
  rootId: string,
  text: string,
  author: string,
  now: Date = new Date(),
): { comments: DocxComment[]; id: string } | null {
  const body = text.trim();
  if (!body || !comments.some((c) => c.id === rootId)) return null;
  const id = nextCommentId(comments as never);
  const reply: DocxComment = {
    id,
    author,
    initials: initialsOf(author),
    date: now.toISOString(),
    text: body,
    parentId: rootId,
  };
  return { comments: [...comments, reply], id };
}

/** Resolve / reopen a thread; the flag lives on the root (Word's w15:done). */
export function withResolved(
  comments: readonly DocxComment[],
  rootId: string,
  done: boolean,
): DocxComment[] {
  return comments.map((c) => (c.id === rootId ? { ...c, done } : c));
}
