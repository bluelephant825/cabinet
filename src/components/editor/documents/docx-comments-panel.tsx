"use client";

/**
 * Comments side panel for the DOCX frame: threads from word/comments.xml,
 * anchors from the live doc. Reply and resolve/reopen edit the comment list
 * held by the frame (written back as `options.comments` on the next save);
 * a reply also extends the parent's anchor marks so Word shows it in-thread.
 */
import type { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { Check, RotateCcw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useLocale } from "@/i18n/use-locale";
import { addReplyToCommentRange } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/comments";
import {
  buildThreads,
  commentAnchors,
  withReply,
  withResolved,
  type CommentThread,
  type DocxComment,
} from "./docx-comments";

function formatDate(iso: string | undefined, locale: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function DocxCommentsPanel({
  editor,
  comments,
  readOnly,
  author,
  onChange,
  onClose,
}: {
  editor: Editor | null;
  comments: DocxComment[];
  readOnly: boolean;
  author: string;
  onChange: (next: DocxComment[]) => void;
  onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const [tick, setTick] = useState(0);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [showResolved, setShowResolved] = useState(true);

  useEffect(() => {
    if (!editor) return;
    const bump = () => setTick((n) => n + 1);
    editor.on("update", bump);
    return () => {
      editor.off("update", bump);
    };
  }, [editor]);

  const threads = useMemo(
    // tick: anchors move as the doc is edited
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => (editor ? buildThreads(comments, commentAnchors(editor.state.doc)) : []),
    [editor, comments, tick],
  );
  const shown = showResolved ? threads : threads.filter((th) => !th.root.done);

  const focusThread = (th: CommentThread) => {
    if (!editor || !th.anchor) return;
    const { state, view } = editor;
    view.dispatch(
      state.tr
        .setSelection(TextSelection.create(state.doc, th.anchor.from, th.anchor.to))
        .scrollIntoView(),
    );
    view.focus();
  };

  const reply = (th: CommentThread) => {
    const text = drafts[th.root.id] ?? "";
    const next = withReply(comments, th.root.id, text, author);
    if (!next || !editor || readOnly) return;
    // Anchor first (a doc transaction), then publish the list.
    addReplyToCommentRange(editor, th.root.id, next.id);
    onChange(next.comments);
    setDrafts((d) => ({ ...d, [th.root.id]: "" }));
  };

  const entry = (c: DocxComment, isReply: boolean) => (
    <div
      key={c.id}
      className={`doc-comment${isReply ? " doc-comment-reply" : ""}`}
      data-testid={isReply ? "docx-comment-reply-entry" : "docx-comment"}
    >
      <div className="doc-comment-meta">
        <strong>{c.author || t("docxEditor:commentUnknownAuthor")}</strong>
        <span>{formatDate(c.date, locale)}</span>
      </div>
      <div className="doc-comment-text">{c.text}</div>
    </div>
  );

  return (
    <aside className="doc-comments-panel" data-testid="docx-comments-panel">
      <div className="doc-comments-head">
        <strong>{t("docxEditor:commentsTitle", { count: threads.length })}</strong>
        <label className="doc-comments-toggle">
          <input
            type="checkbox"
            data-testid="docx-comments-show-resolved"
            checked={showResolved}
            onChange={(e) => setShowResolved(e.target.checked)}
          />
          {t("docxEditor:commentsShowResolved")}
        </label>
        <button
          type="button"
          className="doc-frame-btn"
          data-testid="docx-comments-close"
          title={t("docxEditor:commentsClose")}
          aria-label={t("docxEditor:commentsClose")}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      {shown.length === 0 ? (
        <div className="doc-comments-empty">{t("docxEditor:commentsEmpty")}</div>
      ) : (
        shown.map((th) => (
          <div
            key={th.root.id}
            className={`doc-comment-thread${th.root.done ? " resolved" : ""}`}
            data-testid="docx-comment-thread"
          >
            {th.anchor && (
              <button
                type="button"
                className="doc-comment-anchor"
                data-testid="docx-comment-anchor"
                onClick={() => focusThread(th)}
              >
                {th.anchor.text.length > 80 ? `${th.anchor.text.slice(0, 80)}…` : th.anchor.text}
              </button>
            )}
            {entry(th.root, false)}
            {th.replies.map((r) => entry(r, true))}
            {th.root.done && (
              <div className="doc-comment-resolved">{t("docxEditor:commentResolved")}</div>
            )}
            {!readOnly && (
              <div className="doc-comment-actions">
                <input
                  className="doc-find-input"
                  data-testid="docx-comment-reply-input"
                  placeholder={t("docxEditor:commentReplyPlaceholder")}
                  aria-label={t("docxEditor:commentReplyPlaceholder")}
                  value={drafts[th.root.id] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [th.root.id]: e.target.value }))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      reply(th);
                    }
                  }}
                />
                <button
                  type="button"
                  className="doc-frame-btn"
                  data-testid="docx-comment-reply"
                  disabled={!(drafts[th.root.id] ?? "").trim()}
                  onClick={() => reply(th)}
                >
                  {t("docxEditor:commentReply")}
                </button>
                <button
                  type="button"
                  className="doc-frame-btn"
                  data-testid="docx-comment-resolve"
                  title={th.root.done ? t("docxEditor:commentReopen") : t("docxEditor:commentResolve")}
                  aria-label={th.root.done ? t("docxEditor:commentReopen") : t("docxEditor:commentResolve")}
                  onClick={() => onChange(withResolved(comments, th.root.id, !th.root.done))}
                >
                  {th.root.done ? <RotateCcw size={14} /> : <Check size={14} />}
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </aside>
  );
}
