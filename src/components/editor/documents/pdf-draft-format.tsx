/**
 * Floating format bar shown above (or below, near the page top) an open PDF
 * text draft — font face, size, bold/italic, color, Done/Cancel. Drives the
 * pure DraftStyle object from pdf-draft-style.ts; commits are the caller's.
 */
import { useLocale } from "@/i18n/use-locale";
import { EDIT_FONTS } from "../../../vendor/genoffice/apps/pdf/shared/ipc";
import {
  defaultInsertFont,
  hexToRgb,
  rgbToHex,
  type DraftStyle,
} from "./pdf-draft-style";

interface Props {
  style: DraftStyle;
  onStyle: (patch: Partial<DraftStyle>) => void;
  /** EDIT_FONTS ids usable on this machine (from the fonts/list op). */
  editFonts: readonly string[];
  /** Installed family names the PDF engine can embed (fonts/list op). */
  installedFonts?: readonly string[];
  /** Insert drafts have no "keep original" — color/font are always explicit. */
  isInsert: boolean;
  /** Render under the textarea instead of above it (block at the page top). */
  below?: boolean;
  onDone: () => void;
  onCancel: () => void;
}

export function PdfDraftFormatBar({
  style,
  onStyle,
  editFonts,
  installedFonts = [],
  isInsert,
  below,
  onDone,
  onCancel,
}: Props) {
  const { t } = useLocale();
  const fonts = EDIT_FONTS.filter((f) => editFonts.includes(f.id));
  const fontValue =
    style.font ??
    (isInsert ? defaultInsertFont([...editFonts, ...installedFonts]) : null) ??
    "";
  return (
    <div
      className={`pdf-draft-format${below ? " pdf-draft-format-below" : ""}`}
      data-testid="pdf-draft-format"
      // Keep clicks inside the draft container: the container's blur handler
      // decides commit-vs-stay via relatedTarget.
      onMouseDown={(e) => {
        // Inputs and selects need the default action (focus / open the option
        // list); they sit inside the container so relatedTarget still matches.
        if (!(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) {
          e.preventDefault();
        }
      }}
    >
      <select
        className="pdf-draft-select"
        data-testid="pdf-draft-font"
        title={t("pdfEditor:font")}
        value={fontValue}
        onChange={(e) => onStyle({ font: e.target.value || null })}
      >
        {!isInsert && <option value="">{t("pdfEditor:keepOriginalFont")}</option>}
        {fonts.map((f) => (
          <option key={f.id} value={f.id}>
            {f.label}
          </option>
        ))}
        {installedFonts.length > 0 && (
          <optgroup label={t("pdfEditor:installedFonts")}>
            {installedFonts.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <input
        className="pdf-draft-size"
        data-testid="pdf-draft-size"
        type="number"
        min={4}
        max={200}
        step={0.5}
        title={t("pdfEditor:fontSize")}
        value={style.fontSize}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && v > 0) onStyle({ fontSize: v });
        }}
      />
      <button
        type="button"
        className="pdf-draft-btn pdf-draft-bold"
        data-testid="pdf-draft-bold"
        aria-pressed={style.bold}
        title={t("pdfEditor:bold")}
        onClick={() => onStyle({ bold: !style.bold })}
      >
        B
      </button>
      <button
        type="button"
        className="pdf-draft-btn pdf-draft-italic"
        data-testid="pdf-draft-italic"
        aria-pressed={style.italic}
        title={t("pdfEditor:italic")}
        onClick={() => onStyle({ italic: !style.italic })}
      >
        I
      </button>
      <input
        className="pdf-draft-color"
        data-testid="pdf-draft-color"
        type="color"
        title={t("pdfEditor:textColor")}
        value={rgbToHex(style.color ?? [0, 0, 0])}
        onChange={(e) => onStyle({ color: hexToRgb(e.target.value) })}
      />
      {!isInsert && (
        <button
          type="button"
          className="pdf-draft-btn"
          data-testid="pdf-draft-color-clear"
          title={t("pdfEditor:keepOriginalColor")}
          disabled={style.color === null}
          onClick={() => onStyle({ color: null })}
        >
          ×
        </button>
      )}
      <button
        type="button"
        className="pdf-draft-btn pdf-draft-done"
        data-testid="pdf-draft-done"
        title={t("pdfEditor:done")}
        onClick={onDone}
      >
        {t("pdfEditor:done")}
      </button>
      <button
        type="button"
        className="pdf-draft-btn"
        data-testid="pdf-draft-cancel"
        title={t("pdfEditor:cancel")}
        onClick={onCancel}
      >
        {t("pdfEditor:cancel")}
      </button>
    </div>
  );
}
