"use client";

/**
 * Find & replace bar for the DOCX frame. All matching/replacing is pure
 * (docx-find.ts) against the live ProseMirror doc; edits are ordinary
 * transactions, so they flow through the same dirty/save-plan path.
 */
import type { Editor } from "@tiptap/core";
import { CaseSensitive, ChevronDown, ChevronUp, WholeWord, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useLocale } from "@/i18n/use-locale";
import {
  currentMatchIndex,
  findMatches,
  replaceTransaction,
  selectMatch,
  stepMatch,
} from "./docx-find";

export function DocxFindPanel({
  editor,
  readOnly,
  onClose,
}: {
  editor: Editor | null;
  readOnly: boolean;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [tick, setTick] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => inputRef.current?.focus(), []);
  useEffect(() => {
    if (!editor) return;
    const bump = () => setTick((n) => n + 1);
    editor.on("transaction", bump);
    return () => {
      editor.off("transaction", bump);
    };
  }, [editor]);

  const matches = useMemo(
    // tick: the doc or selection changed underneath us
    // eslint-disable-next-line react-hooks/exhaustive-deps
    () => (editor ? findMatches(editor.state.doc, query, { matchCase, wholeWord }) : []),
    [editor, query, matchCase, wholeWord, tick],
  );
  const sel = editor?.state.selection;
  const index = sel ? currentMatchIndex(matches, sel) : -1;

  const go = (dir: 1 | -1) => {
    if (!editor) return;
    const next = stepMatch(matches, editor.state.selection, dir);
    if (next) editor.view.dispatch(selectMatch(editor.state, next));
  };
  const replaceOne = () => {
    if (!editor || readOnly) return;
    if (index < 0) return go(1);
    const tr = replaceTransaction(editor.state, [matches[index]!], replacement);
    if (tr) editor.view.dispatch(tr);
    // The doc changed; jump to the next remaining match from the caret.
    const rest = findMatches(editor.state.doc, query, { matchCase, wholeWord });
    const next = stepMatch(rest, editor.state.selection, 1);
    if (next) editor.view.dispatch(selectMatch(editor.state, next));
  };
  const replaceAll = () => {
    if (!editor || readOnly) return;
    const tr = replaceTransaction(editor.state, matches, replacement);
    if (tr) editor.view.dispatch(tr);
  };

  const count = !query
    ? ""
    : matches.length === 0
      ? t("docxEditor:findNone")
      : t("docxEditor:findCount", { current: index + 1, total: matches.length });

  return (
    <div className="doc-find-panel" data-testid="docx-find-panel" role="search">
      <input
        ref={inputRef}
        data-testid="docx-find-input"
        className="doc-find-input"
        placeholder={t("docxEditor:findPlaceholder")}
        aria-label={t("docxEditor:findPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
      />
      <span className="doc-find-count" data-testid="docx-find-count">
        {count}
      </span>
      <button
        type="button"
        className={`doc-frame-btn${matchCase ? " active" : ""}`}
        data-testid="docx-find-case"
        title={t("docxEditor:findMatchCase")}
        aria-label={t("docxEditor:findMatchCase")}
        aria-pressed={matchCase}
        onClick={() => setMatchCase((v) => !v)}
      >
        <CaseSensitive size={14} />
      </button>
      <button
        type="button"
        className={`doc-frame-btn${wholeWord ? " active" : ""}`}
        data-testid="docx-find-word"
        title={t("docxEditor:findWholeWord")}
        aria-label={t("docxEditor:findWholeWord")}
        aria-pressed={wholeWord}
        onClick={() => setWholeWord((v) => !v)}
      >
        <WholeWord size={14} />
      </button>
      <button
        type="button"
        className="doc-frame-btn"
        data-testid="docx-find-prev"
        title={t("docxEditor:findPrev")}
        aria-label={t("docxEditor:findPrev")}
        disabled={matches.length === 0}
        onClick={() => go(-1)}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        className="doc-frame-btn"
        data-testid="docx-find-next"
        title={t("docxEditor:findNext")}
        aria-label={t("docxEditor:findNext")}
        disabled={matches.length === 0}
        onClick={() => go(1)}
      >
        <ChevronDown size={14} />
      </button>
      <input
        data-testid="docx-replace-input"
        className="doc-find-input"
        placeholder={t("docxEditor:replacePlaceholder")}
        aria-label={t("docxEditor:replacePlaceholder")}
        disabled={readOnly}
        value={replacement}
        onChange={(e) => setReplacement(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            replaceOne();
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
      />
      <button
        type="button"
        className="doc-frame-btn"
        data-testid="docx-replace-one"
        disabled={readOnly || matches.length === 0}
        onClick={replaceOne}
      >
        {t("docxEditor:findReplace")}
      </button>
      <button
        type="button"
        className="doc-frame-btn"
        data-testid="docx-replace-all"
        disabled={readOnly || matches.length === 0}
        onClick={replaceAll}
      >
        {t("docxEditor:findReplaceAll")}
      </button>
      <button
        type="button"
        className="doc-frame-btn"
        data-testid="docx-find-close"
        title={t("docxEditor:findClose")}
        aria-label={t("docxEditor:findClose")}
        onClick={onClose}
      >
        <X size={14} />
      </button>
    </div>
  );
}
