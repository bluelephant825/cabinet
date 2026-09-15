"use client";

/**
 * Compact Cabinet-native formatting toolbar for the DOCX editor frame.
 * Every command goes through docx-toolbar-commands.ts against the vendored
 * GenOffice schema — upstream's full Ribbon is App.tsx-coupled and was never
 * vendored.
 */
import type { Editor } from "@tiptap/core";
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  Italic,
  Link,
  List,
  ListOrdered,
  Outdent,
  Indent,
  Redo2,
  Save,
  Strikethrough,
  Table,
  Trash2,
  Underline,
  Undo2,
} from "lucide-react";

import { useLocale } from "@/i18n/use-locale";
import { fontFamiliesFor } from "../../../vendor/genoffice/apps/docs/src/renderer/font-list";
import { HIGHLIGHT_CSS } from "../../../vendor/genoffice/apps/docs/src/renderer/editor/marks";
import {
  applyParagraphStyle,
  changeIndent,
  insertTable,
  setAlign,
  setLink,
  setTextStyle,
  tableAddColumnAfter,
  tableAddRowAfter,
  tableDeleteColumn,
  tableDeleteRow,
  tableDeleteTable,
  tableMergeCells,
  tableSplitCell,
  toggleList,
  type AlignKey,
  type DocxFormatState,
  type ListKind,
  type ParagraphStyleKey,
} from "./docx-toolbar-commands";

const FONT_SIZES_PT = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 72];

type UpstreamLang = Parameters<typeof fontFamiliesFor>[0];
function upstreamLang(locale: string | undefined): UpstreamLang {
  switch (locale) {
    case "zh-CN":
      return "zh" as UpstreamLang;
    case "zh-TW":
      return "zh-TW" as UpstreamLang;
    case "ja":
      return "ja" as UpstreamLang;
    case "ko":
      return "ko" as UpstreamLang;
    default:
      return "en" as UpstreamLang;
  }
}

function ToolButton({
  testId,
  title,
  pressed,
  disabled,
  onClick,
  children,
}: {
  testId: string;
  title: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      className={`doc-frame-btn${pressed ? " active" : ""}`}
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function DocxToolbar({
  editor,
  readOnly,
  formatState,
  onSave,
  dirty,
  saving,
  allocateNumId,
}: {
  editor: Editor | null;
  readOnly: boolean;
  formatState: DocxFormatState | null;
  onSave: () => void;
  dirty: boolean;
  saving: boolean;
  allocateNumId: (kind: ListKind) => string | null;
}) {
  const { t, locale } = useLocale();
  const fs = formatState;
  const disabled = readOnly || !editor;
  const act = (fn: (e: Editor) => boolean | void) => () => {
    if (editor) fn(editor);
  };

  const alignLabels: Record<AlignKey, string> = {
    left: t("docxEditor:tbAlignLeft"),
    center: t("docxEditor:tbAlignCenter"),
    right: t("docxEditor:tbAlignRight"),
    justify: t("docxEditor:tbAlignJustify"),
  };
  const fonts = fontFamiliesFor(upstreamLang(locale));
  const fontOptions = fs?.font && !fonts.includes(fs.font) ? [fs.font, ...fonts] : fonts;
  const sizePt = fs?.sizeHalfPoints ? fs.sizeHalfPoints / 2 : null;
  const sizeOptions =
    sizePt != null && !FONT_SIZES_PT.includes(sizePt)
      ? [sizePt, ...FONT_SIZES_PT]
      : FONT_SIZES_PT;

  const promptLink = () => {
    if (!editor) return;
    const next = window.prompt(t("docxEditor:tbLinkPrompt"), fs?.linkHref ?? "https://");
    if (next == null) return;
    const href = next.trim();
    setLink(editor, href === "" ? null : href);
  };

  return (
    <div className="doc-frame-toolbar" data-testid="docx-toolbar">
      <div className="doc-frame-group">
        <ToolButton
          testId="docx-tb-undo"
          title={t("docxEditor:tbUndo")}
          disabled={disabled || !fs?.canUndo}
          onClick={act((e) => e.chain().focus().undo().run())}
        >
          <Undo2 size={14} />
        </ToolButton>
        <ToolButton
          testId="docx-tb-redo"
          title={t("docxEditor:tbRedo")}
          disabled={disabled || !fs?.canRedo}
          onClick={act((e) => e.chain().focus().redo().run())}
        >
          <Redo2 size={14} />
        </ToolButton>
      </div>
      <span className="doc-frame-sep" />
      <div className="doc-frame-group">
        <select
          data-testid="docx-tb-style"
          className="doc-frame-select"
          title={t("docxEditor:tbStyle")}
          aria-label={t("docxEditor:tbStyle")}
          disabled={disabled}
          value={fs?.paragraphStyle ?? "p"}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            if (editor) applyParagraphStyle(editor, e.target.value as ParagraphStyleKey);
          }}
        >
          <option value="p">{t("docxEditor:tbStyleNormal")}</option>
          {[1, 2, 3, 4, 5, 6].map((n) => (
            <option key={n} value={`h${n}`}>
              {t("docxEditor:tbStyleHeading", { level: n })}
            </option>
          ))}
        </select>
        <select
          data-testid="docx-tb-font"
          className="doc-frame-select"
          title={t("docxEditor:tbFont")}
          aria-label={t("docxEditor:tbFont")}
          disabled={disabled}
          value={fs?.font ?? ""}
          onChange={(e) => {
            if (editor) setTextStyle(editor, { font: e.target.value || null });
          }}
        >
          <option value="">{t("docxEditor:tbFontDefault")}</option>
          {fontOptions.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
        <select
          data-testid="docx-tb-size"
          className="doc-frame-select doc-frame-select-narrow"
          title={t("docxEditor:tbSize")}
          aria-label={t("docxEditor:tbSize")}
          disabled={disabled}
          value={sizePt != null ? String(sizePt) : ""}
          onChange={(e) => {
            if (!editor) return;
            const pt = Number(e.target.value);
            if (pt > 0) setTextStyle(editor, { sizeHalfPoints: Math.round(pt * 2) });
          }}
        >
          <option value="">–</option>
          {sizeOptions.map((pt) => (
            <option key={pt} value={String(pt)}>
              {pt}
            </option>
          ))}
        </select>
      </div>
      <span className="doc-frame-sep" />
      <div className="doc-frame-group">
        <ToolButton
          testId="docx-tb-bold"
          title={t("docxEditor:tbBold")}
          pressed={fs?.bold}
          disabled={disabled}
          onClick={act((e) => e.chain().focus().toggleMark("bold").run())}
        >
          <Bold size={14} />
        </ToolButton>
        <ToolButton
          testId="docx-tb-italic"
          title={t("docxEditor:tbItalic")}
          pressed={fs?.italic}
          disabled={disabled}
          onClick={act((e) => e.chain().focus().toggleMark("italic").run())}
        >
          <Italic size={14} />
        </ToolButton>
        <ToolButton
          testId="docx-tb-underline"
          title={t("docxEditor:tbUnderline")}
          pressed={fs?.underline}
          disabled={disabled}
          onClick={act((e) => e.chain().focus().toggleMark("underline").run())}
        >
          <Underline size={14} />
        </ToolButton>
        <ToolButton
          testId="docx-tb-strike"
          title={t("docxEditor:tbStrike")}
          pressed={fs?.strike}
          disabled={disabled}
          onClick={act((e) => e.chain().focus().toggleMark("strike").run())}
        >
          <Strikethrough size={14} />
        </ToolButton>
        <input
          type="color"
          data-testid="docx-tb-color"
          className="doc-frame-color"
          title={t("docxEditor:tbColor")}
          aria-label={t("docxEditor:tbColor")}
          disabled={disabled}
          value={`#${(fs?.color ?? "000000").toLowerCase()}`}
          onMouseDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            if (editor) setTextStyle(editor, { color: e.target.value.slice(1).toUpperCase() });
          }}
        />
        <ToolButton
          testId="docx-tb-color-clear"
          title={t("docxEditor:tbColorClear")}
          disabled={disabled || !fs?.color}
          onClick={act((e) => setTextStyle(e, { color: null }))}
        >
          ×
        </ToolButton>
        <select
          data-testid="docx-tb-highlight"
          className="doc-frame-select doc-frame-select-narrow"
          title={t("docxEditor:tbHighlight")}
          aria-label={t("docxEditor:tbHighlight")}
          disabled={disabled}
          value={fs?.highlight ?? ""}
          onChange={(e) => {
            if (editor) setTextStyle(editor, { highlight: e.target.value || null });
          }}
        >
          <option value="">{t("docxEditor:tbHighlightNone")}</option>
          {Object.keys(HIGHLIGHT_CSS).map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <span className="doc-frame-sep" />
      <div className="doc-frame-group">
        {(["left", "center", "right", "justify"] as AlignKey[]).map((a) => {
          const icons = {
            left: AlignLeft,
            center: AlignCenter,
            right: AlignRight,
            justify: AlignJustify,
          } as const;
          const Icon = icons[a];
          return (
            <ToolButton
              key={a}
              testId={`docx-tb-align-${a}`}
              title={alignLabels[a]}
              pressed={fs?.align === a}
              disabled={disabled}
              onClick={act((e) => setAlign(e, a))}
            >
              <Icon size={14} />
            </ToolButton>
          );
        })}
      </div>
      <span className="doc-frame-sep" />
      <div className="doc-frame-group">
        <ToolButton
          testId="docx-tb-bullets"
          title={t("docxEditor:tbBullets")}
          pressed={fs?.listKind === "bullet"}
          disabled={disabled}
          onClick={act((e) => toggleList(e, "bullet", allocateNumId))}
        >
          <List size={14} />
        </ToolButton>
        <ToolButton
          testId="docx-tb-numbering"
          title={t("docxEditor:tbNumbering")}
          pressed={fs?.listKind === "ordered"}
          disabled={disabled}
          onClick={act((e) => toggleList(e, "ordered", allocateNumId))}
        >
          <ListOrdered size={14} />
        </ToolButton>
        <ToolButton
          testId="docx-tb-outdent"
          title={t("docxEditor:tbOutdent")}
          disabled={disabled}
          onClick={act((e) => changeIndent(e, -1))}
        >
          <Outdent size={14} />
        </ToolButton>
        <ToolButton
          testId="docx-tb-indent"
          title={t("docxEditor:tbIndent")}
          disabled={disabled}
          onClick={act((e) => changeIndent(e, 1))}
        >
          <Indent size={14} />
        </ToolButton>
        <ToolButton
          testId="docx-tb-link"
          title={t("docxEditor:tbLink")}
          pressed={fs?.linkHref != null}
          disabled={disabled}
          onClick={promptLink}
        >
          <Link size={14} />
        </ToolButton>
      </div>
      <span className="doc-frame-sep" />
      <div className="doc-frame-group">
        <ToolButton
          testId="docx-tb-table-insert"
          title={t("docxEditor:tbInsertTable")}
          disabled={disabled}
          onClick={act((e) => insertTable(e, 3, 3))}
        >
          <Table size={14} />
        </ToolButton>
        {fs?.inTable ? (
          <>
            <ToolButton
              testId="docx-tb-table-row-add"
              title={t("docxEditor:tbAddRow")}
              disabled={disabled}
              onClick={act(tableAddRowAfter)}
            >
              +{t("docxEditor:tbRow")}
            </ToolButton>
            <ToolButton
              testId="docx-tb-table-col-add"
              title={t("docxEditor:tbAddCol")}
              disabled={disabled}
              onClick={act(tableAddColumnAfter)}
            >
              +{t("docxEditor:tbCol")}
            </ToolButton>
            <ToolButton
              testId="docx-tb-table-row-del"
              title={t("docxEditor:tbDeleteRow")}
              disabled={disabled}
              onClick={act(tableDeleteRow)}
            >
              −{t("docxEditor:tbRow")}
            </ToolButton>
            <ToolButton
              testId="docx-tb-table-col-del"
              title={t("docxEditor:tbDeleteCol")}
              disabled={disabled}
              onClick={act(tableDeleteColumn)}
            >
              −{t("docxEditor:tbCol")}
            </ToolButton>
            <ToolButton
              testId="docx-tb-table-merge"
              title={t("docxEditor:tbMergeCells")}
              disabled={disabled || !fs.canMergeCells}
              onClick={act(tableMergeCells)}
            >
              ⇄
            </ToolButton>
            <ToolButton
              testId="docx-tb-table-split"
              title={t("docxEditor:tbSplitCell")}
              disabled={disabled || !fs.canSplitCell}
              onClick={act(tableSplitCell)}
            >
              ⇅
            </ToolButton>
            <ToolButton
              testId="docx-tb-table-delete"
              title={t("docxEditor:tbDeleteTable")}
              disabled={disabled}
              onClick={act(tableDeleteTable)}
            >
              <Trash2 size={14} />
            </ToolButton>
          </>
        ) : null}
      </div>
      <div className="doc-frame-group doc-frame-save">
        <button
          type="button"
          data-testid="docx-tb-save"
          className="doc-frame-btn doc-frame-save-btn"
          title={t("docxEditor:tbSave")}
          disabled={saving || readOnly}
          onMouseDown={(e) => e.preventDefault()}
          onClick={onSave}
        >
          <Save size={14} />
          {saving ? t("docxEditor:saving") : t("docxEditor:tbSave")}
          {dirty ? <span className="doc-frame-dirty" aria-hidden="true" /> : null}
        </button>
      </div>
    </div>
  );
}

