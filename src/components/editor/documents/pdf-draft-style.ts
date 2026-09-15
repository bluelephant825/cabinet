/**
 * Pure helpers for the PDF draft format bar: which engine fields a draft
 * style maps to, line-leading scaling, and the insert-font rule. No React —
 * unit-tested directly.
 */
import type { PdfTextEdit, Rgb } from "@/lib/documents/types";

export interface DraftStyle {
  /** Target size in pt (block edits initialize to the block's own size). */
  fontSize: number;
  /** 0-255 RGB; null = keep the run's original color (block edits only). */
  color: Rgb | null;
  /** EDIT_FONTS id; null = keep original (edits) / engine fallback (inserts). */
  font: string | null;
  bold: boolean;
  italic: boolean;
}

export const DEFAULT_INSERT_STYLE: DraftStyle = {
  fontSize: 14,
  color: [0, 0, 0],
  font: null,
  bold: false,
  italic: false,
};

export function blockDraftStyle(fontSize: number, existing?: PdfTextEdit): DraftStyle {
  return existing
    ? {
        fontSize: existing.newFontSize ?? fontSize,
        color: existing.newColor ?? null,
        font: existing.newFont ?? null,
        bold: !!existing.newBold,
        italic: !!existing.newItalic,
      }
    : { fontSize, color: null, font: null, bold: false, italic: false };
}

export type EditStyleFields = Pick<
  PdfTextEdit,
  "newFontSize" | "newColor" | "newFont" | "newBold" | "newItalic"
>;

/** Emit only real changes — absent fields keep the original run's style. */
export function draftStyleToEditFields(
  style: DraftStyle,
  baseFontSize: number,
): EditStyleFields {
  const f: EditStyleFields = {};
  if (style.fontSize !== baseFontSize) f.newFontSize = style.fontSize;
  if (style.color) f.newColor = style.color;
  if (style.font) f.newFont = style.font;
  if (style.bold) f.newBold = true;
  if (style.italic) f.newItalic = true;
  return f;
}

export function hasStyleChanges(fields: EditStyleFields): boolean {
  return Object.values(fields).some((v) => v !== undefined);
}

/**
 * Only the color changed — the engine repaints the matched objects in place,
 * so the frame emits the minimal edit (unchanged text, no layout overrides)
 * and the original embedded font survives.
 */
export function isColorOnlyEdit(fields: EditStyleFields): boolean {
  return (
    fields.newColor !== undefined &&
    fields.newFontSize === undefined &&
    fields.newFont === undefined &&
    !fields.newBold &&
    !fields.newItalic
  );
}

/** Rebuild line leading scales with the size change; unchanged size keeps the block's. */
export function scaledLineLeading(
  lineHeight: number,
  oldSize: number,
  newSize: number,
): number {
  if (newSize === oldSize || oldSize <= 0) return lineHeight;
  return lineHeight * (newSize / oldSize);
}

/**
 * Inserts: a bold/italic toggle with no chosen font needs an explicit face.
 * The engine's insert path calls rebuildFontBytes with font=0, which skips
 * the styled-variant lookup and lands on a regular fallback face — the toggle
 * would be silently dropped. Prefer arial, else the first usable edit font.
 */
export function resolveInsertFont(
  style: DraftStyle,
  editFonts: readonly string[],
): string | undefined {
  if (style.font) return style.font;
  if (!style.bold && !style.italic) return undefined;
  return defaultInsertFont(editFonts) ?? undefined;
}

/** Displayed/default face for inserts — arial when usable, else the first. */
export function defaultInsertFont(editFonts: readonly string[]): string | null {
  if (editFonts.includes("arial")) return "arial";
  return editFonts[0] ?? null;
}

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0, 0, 0];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.max(0, Math.min(255, Math.round(v)))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function rgbCss(rgb: Rgb): string {
  return `rgb(${rgb.map((v) => Math.round(v)).join(", ")})`;
}
