"use client";

/**
 * Read-only view of the document's default header and footer (text, page-number
 * fields, and a note about what the summary leaves out). Editing them stays in
 * Word — the save path rewrites the body only and keeps these parts verbatim.
 */
import { X } from "lucide-react";

import { useLocale } from "@/i18n/use-locale";
import type { DocxHeaderFooterInfo } from "@/lib/documents/types";

function Part({
  testId,
  title,
  lines,
  images,
}: {
  testId: string;
  title: string;
  lines: string[];
  images: number;
}) {
  const { t } = useLocale();
  return (
    <section className="doc-comment-thread" data-testid={testId}>
      <strong>{title}</strong>
      {lines.length === 0 ? (
        <div className="doc-comment-resolved">{t("docxEditor:hfEmpty")}</div>
      ) : (
        lines.map((line, i) => (
          <div key={i} className="doc-comment-text">
            {line || "\u00a0"}
          </div>
        ))
      )}
      {images > 0 ? (
        <div className="doc-comment-resolved">{t("docxEditor:hfImages", { count: images })}</div>
      ) : null}
    </section>
  );
}

export function DocxHeaderFooterPanel({
  info,
  onClose,
}: {
  info: DocxHeaderFooterInfo | null;
  onClose: () => void;
}) {
  const { t } = useLocale();
  return (
    <aside className="doc-comments-panel" data-testid="docx-hf-panel">
      <div className="doc-comments-head">
        <strong>{t("docxEditor:hfTitle")}</strong>
        <button
          type="button"
          className="doc-frame-btn"
          data-testid="docx-hf-close"
          title={t("docxEditor:hfClose")}
          aria-label={t("docxEditor:hfClose")}
          onClick={onClose}
        >
          <X size={14} />
        </button>
      </div>
      {info ? (
        <>
          <Part testId="docx-hf-header" title={t("docxEditor:hfHeader")} lines={info.header} images={info.headerImages} />
          <Part testId="docx-hf-footer" title={t("docxEditor:hfFooter")} lines={info.footer} images={info.footerImages} />
          {info.watermark ? (
            <div className="doc-comment-resolved" data-testid="docx-hf-watermark">
              {t("docxEditor:hfWatermark", { text: info.watermark })}
            </div>
          ) : null}
          {info.differentFirstPage || info.differentOddEven ? (
            <div className="doc-comment-resolved" data-testid="docx-hf-variants">
              {t("docxEditor:hfVariants")}
            </div>
          ) : null}
          <div className="doc-comment-resolved">{t("docxEditor:hfReadOnly")}</div>
        </>
      ) : (
        <div className="doc-comment-resolved">{t("docxEditor:hfEmpty")}</div>
      )}
    </aside>
  );
}
