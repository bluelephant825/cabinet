"use client";

/**
 * Tracked-changes side panel: the revision list of the live doc with per-item
 * and bulk Accept / Reject, previous/next navigation, the Track Changes
 * switch (the vendored TrackChangesExtension storage) and Word's three
 * markup views (all / final / original) applied as a class on the frame body.
 */
import type { Editor } from "@tiptap/core";
import { Check, ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { useLocale } from "@/i18n/use-locale";
import {
  acceptAllRevisions,
  applyRevisions,
  gotoRevision,
  rejectAllRevisions,
} from "../../../vendor/genoffice/apps/docs/src/renderer/editor/revisions";
import { listRevisions, selectRevision, type RevisionItem } from "./docx-revisions";

export type MarkupView = "all" | "final" | "original";

function formatDate(iso: string | undefined, locale: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
}

export function DocxChangesPanel({
  editor,
  readOnly,
  author,
  view,
  onViewChange,
  onClose,
}: {
  editor: Editor | null;
  readOnly: boolean;
  author: string;
  view: MarkupView;
  onViewChange: (v: MarkupView) => void;
  onClose: () => void;
}) {
  const { t, locale } = useLocale();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!editor) return;
    const bump = () => setTick((n) => n + 1);
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
    };
  }, [editor]);

  const items = useMemo(
    // tick: the doc changed underneath us
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => (editor ? listRevisions(editor.state.doc) : []),
    [editor, tick],
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const tracking = useMemo(() => Boolean(editor?.storage.trackChanges?.enabled), [editor, tick]);

  const toggleTracking = (on: boolean) => {
    if (!editor) return;
    editor.storage.trackChanges.enabled = on;
    if (on && author) editor.storage.trackChanges.author = author;
    setTick((n) => n + 1);
  };
  const apply = (item: RevisionItem, mode: "accept" | "reject") => {
    if (editor && !readOnly) applyRevisions(editor, [item.range], mode);
  };
  const focus = (item: RevisionItem) => {
    if (!editor) return;
    editor.view.dispatch(selectRevision(editor.state, item.range));
    editor.view.focus();
  };
  const groupLabel = (g: RevisionItem["group"]) =>
    t(
      g === "insert"
        ? "docxEditor:changeInserted"
        : g === "delete"
          ? "docxEditor:changeDeleted"
          : g === "format"
            ? "docxEditor:changeFormatted"
            : "docxEditor:changeStructure",
    );

  return (
    <aside className="doc-comments-panel" data-testid="docx-changes-panel">
      <div className="doc-comments-head">
        <strong>{t("docxEditor:changesTitle", { count: items.length })}</strong>
        <button
          type="button"
          className="doc-frame-btn"
          data-testid="docx-changes-close"
          title={t("docxEditor:changesClose")}
          aria-label={t("docxEditor:changesClose")}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      <div className="doc-comment-actions">
        <label className="doc-comments-toggle">
          <input
            type="checkbox"
            data-testid="docx-track-toggle"
            checked={tracking}
            disabled={readOnly}
            onChange={(e) => toggleTracking(e.target.checked)}
          />
          {t("docxEditor:changesTrack")}
        </label>
        <select
          data-testid="docx-markup-view"
          className="doc-frame-select"
          title={t("docxEditor:changesView")}
          aria-label={t("docxEditor:changesView")}
          value={view}
          onChange={(e) => onViewChange(e.target.value as MarkupView)}
        >
          <option value="all">{t("docxEditor:changesViewAll")}</option>
          <option value="final">{t("docxEditor:changesViewFinal")}</option>
          <option value="original">{t("docxEditor:changesViewOriginal")}</option>
        </select>
      </div>
      <div className="doc-comment-actions">
        <button
          type="button"
          className="doc-frame-btn"
          data-testid="docx-change-prev"
          title={t("docxEditor:changePrev")}
          aria-label={t("docxEditor:changePrev")}
          disabled={items.length === 0}
          onClick={() => editor && gotoRevision(editor, -1)}
        >
          <ChevronUp size={14} />
        </button>
        <button
          type="button"
          className="doc-frame-btn"
          data-testid="docx-change-next"
          title={t("docxEditor:changeNext")}
          aria-label={t("docxEditor:changeNext")}
          disabled={items.length === 0}
          onClick={() => editor && gotoRevision(editor, 1)}
        >
          <ChevronDown size={14} />
        </button>
        <button
          type="button"
          className="doc-frame-btn"
          data-testid="docx-accept-all"
          disabled={readOnly || items.length === 0}
          onClick={() => editor && acceptAllRevisions(editor)}
        >
          {t("docxEditor:changeAcceptAll")}
        </button>
        <button
          type="button"
          className="doc-frame-btn"
          data-testid="docx-reject-all"
          disabled={readOnly || items.length === 0}
          onClick={() => editor && rejectAllRevisions(editor)}
        >
          {t("docxEditor:changeRejectAll")}
        </button>
      </div>
      {items.length === 0 ? (
        <div className="doc-comments-empty">{t("docxEditor:changesEmpty")}</div>
      ) : (
        items.map((item) => (
          <div
            key={`${item.range.kind}-${item.range.from}-${item.range.to}`}
            className="doc-comment-thread"
            data-testid="docx-change-item"
          >
            <div className="doc-comment-meta">
              <strong>{groupLabel(item.group)}</strong>
              <span>{item.range.author}</span>
            </div>
            <div className="doc-comment-meta">
              <span>{formatDate(item.range.date, locale)}</span>
            </div>
            {item.text && (
              <button
                type="button"
                className="doc-comment-anchor"
                data-testid="docx-change-text"
                onClick={() => focus(item)}
              >
                {item.text}
              </button>
            )}
            {!readOnly && (
              <div className="doc-comment-actions">
                <button
                  type="button"
                  className="doc-frame-btn"
                  data-testid="docx-change-accept"
                  title={t("docxEditor:changeAccept")}
                  aria-label={t("docxEditor:changeAccept")}
                  onClick={() => apply(item, "accept")}
                >
                  <Check size={14} />
                </button>
                <button
                  type="button"
                  className="doc-frame-btn"
                  data-testid="docx-change-reject"
                  title={t("docxEditor:changeReject")}
                  aria-label={t("docxEditor:changeReject")}
                  onClick={() => apply(item, "reject")}
                >
                  <X size={14} />
                </button>
              </div>
            )}
          </div>
        ))
      )}
    </aside>
  );
}
