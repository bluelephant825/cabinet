"use client";

/**
 * Table properties bar: alignment, borders, cell shading, cell vertical
 * alignment and repeat-header-row for the table around the caret. Every
 * control is an ordinary transaction (docx-toolbar-commands), so the edit
 * flows through the normal dirty/save-plan path.
 */
import type { Editor } from "@tiptap/core";
import { X } from "lucide-react";

import { useLocale } from "@/i18n/use-locale";
import {
  setCellFill,
  setCellVAlign,
  setRepeatHeader,
  setTableAlign,
  setTableBordered,
  type CellVAlignKey,
  type DocxFormatState,
  type TableAlignKey,
} from "./docx-toolbar-commands";

export function DocxTablePanel({
  editor,
  readOnly,
  formatState,
  onClose,
}: {
  editor: Editor | null;
  readOnly: boolean;
  formatState: DocxFormatState | null;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const fs = formatState;
  const disabled = readOnly || !editor || !fs?.inTable;
  return (
    <div className="doc-find-panel" data-testid="docx-table-panel">
      <strong>{t("docxEditor:tpTitle")}</strong>
      <label>
        {t("docxEditor:tpAlign")}{" "}
        <select
          data-testid="docx-tp-align"
          className="doc-frame-select"
          disabled={disabled}
          value={fs?.tableAlign ?? "left"}
          onChange={(e) => editor && setTableAlign(editor, e.target.value as TableAlignKey)}
        >
          <option value="left">{t("docxEditor:tbAlignLeft")}</option>
          <option value="center">{t("docxEditor:tbAlignCenter")}</option>
          <option value="right">{t("docxEditor:tbAlignRight")}</option>
        </select>
      </label>
      <label>
        {t("docxEditor:tpBorders")}{" "}
        <select
          data-testid="docx-tp-borders"
          className="doc-frame-select"
          disabled={disabled}
          value={fs?.tableBordered ? "all" : "none"}
          onChange={(e) => editor && setTableBordered(editor, e.target.value === "all")}
        >
          <option value="all">{t("docxEditor:tpBordersAll")}</option>
          <option value="none">{t("docxEditor:tpBordersNone")}</option>
        </select>
      </label>
      <label>
        {t("docxEditor:tpShading")}{" "}
        <input
          type="color"
          data-testid="docx-tp-fill"
          className="doc-frame-color"
          disabled={disabled}
          value={`#${(fs?.cellFill ?? "FFFFFF").toLowerCase()}`}
          onChange={(e) => editor && setCellFill(editor, e.target.value.slice(1))}
        />
      </label>
      <button
        type="button"
        className="doc-frame-btn"
        data-testid="docx-tp-fill-clear"
        disabled={disabled || !fs?.cellFill}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => editor && setCellFill(editor, null)}
      >
        {t("docxEditor:tpShadingClear")}
      </button>
      <label>
        {t("docxEditor:tpVAlign")}{" "}
        <select
          data-testid="docx-tp-valign"
          className="doc-frame-select"
          disabled={disabled}
          value={fs?.cellVAlign ?? "top"}
          onChange={(e) => editor && setCellVAlign(editor, e.target.value as CellVAlignKey)}
        >
          <option value="top">{t("docxEditor:tpVAlignTop")}</option>
          <option value="center">{t("docxEditor:tpVAlignCenter")}</option>
          <option value="bottom">{t("docxEditor:tpVAlignBottom")}</option>
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          data-testid="docx-tp-repeat-header"
          disabled={disabled}
          checked={Boolean(fs?.repeatHeader)}
          onChange={(e) => editor && setRepeatHeader(editor, e.target.checked)}
        />{" "}
        {t("docxEditor:tpRepeatHeader")}
      </label>
      <button
        type="button"
        className="doc-frame-btn"
        data-testid="docx-tp-close"
        title={t("docxEditor:tpClose")}
        aria-label={t("docxEditor:tpClose")}
        onClick={onClose}
      >
        <X size={14} />
      </button>
    </div>
  );
}
