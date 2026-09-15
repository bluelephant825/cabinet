/**
 * Pure helpers for PDF block-edit reflow: which font the draft should be
 * measured with, and a calibration factor mapping the browser's measured
 * widths back onto the PDF's true line widths. No DOM at module level —
 * unit-tested directly.
 */
import { EDIT_FONTS } from "../../../vendor/genoffice/apps/pdf/shared/ipc";
import type { DraftStyle } from "./pdf-draft-style";

export interface MeasureFont {
  cssFamily: string;
  /** CSS font-shorthand prefix: "" | "bold" | "italic" | "italic bold". */
  cssStyle: string;
  /** True when the family is the chosen font itself, so no calibration. */
  exact: boolean;
}

/** Font to measure a draft with: a chosen EDIT_FONTS id → its css; a chosen
    installed family name → quoted family + ", sans-serif"; none → uiFamily
    (calibrated later by widthCalibration). */
export function draftMeasureFont(style: DraftStyle, uiFamily: string): MeasureFont {
  const cssStyle = style.italic && style.bold ? "italic bold" : style.bold ? "bold" : style.italic ? "italic" : "";
  const curated = EDIT_FONTS.find((f) => f.id === style.font);
  if (curated) return { cssFamily: curated.css, cssStyle, exact: true };
  if (style.font) return { cssFamily: `"${style.font}", sans-serif`, cssStyle, exact: true };
  return { cssFamily: uiFamily, cssStyle, exact: false };
}

/** Ratio of true PDF line widths to measured widths, for keep-original
    edits. measure(text, fontSizePt) wraps measurePt with the css family/style.
    Uses only lines with non-blank text and widthPt > 0; returns
    sum(widthPt)/sum(measured) clamped to [0.5, 2]; 1 when no usable line or
    the measured sum is 0. */
export function widthCalibration(
  lines: readonly { text: string; widthPt: number; fontSize: number }[],
  measure: (text: string, fontSizePt: number) => number,
): number {
  let trueSum = 0;
  let measuredSum = 0;
  for (const l of lines) {
    if (!l.text.trim() || l.widthPt <= 0) continue;
    trueSum += l.widthPt;
    measuredSum += measure(l.text, l.fontSize);
  }
  if (trueSum <= 0 || measuredSum <= 0) return 1;
  return Math.min(2, Math.max(0.5, trueSum / measuredSum));
}
