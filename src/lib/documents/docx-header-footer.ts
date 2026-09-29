/**
 * Read-only header/footer summary carried on the DOCX model, built from the
 * engine's parsed default header/footer parts (worker side) and shown by the
 * frame's headers & footers panel.
 */
import type { DocxHeaderFooterInfo } from "./types";

const PAGE_MARK = "\uE001";
const TOTAL_PAGES_MARK = "\uE000";

interface HfParaLike {
  runs?: { text?: string }[];
}

const clean = (text: string): string =>
  text.split(PAGE_MARK).join("{page}").split(TOTAL_PAGES_MARK).join("{pages}");

/** Plain-text lines of one part: rich paragraphs when present, else the flat text. */
export function headerFooterLines(
  paras: HfParaLike[] | null | undefined,
  text: string | null | undefined,
): string[] {
  const lines = paras?.length
    ? paras.map((p) => (p.runs ?? []).map((r) => r.text ?? "").join(""))
    : (text ?? "").split(/\r?\n/);
  const out = lines.map(clean);
  while (out.length && out[out.length - 1].trim() === "") out.pop();
  return out;
}

export function summarizeHeaderFooter(parsed: {
  headerParas?: HfParaLike[] | null;
  headerText?: string | null;
  footerParas?: HfParaLike[] | null;
  footerText?: string | null;
  headerImages?: unknown[] | null;
  footerImages?: unknown[] | null;
  watermarkText?: string | null;
  titlePg?: boolean;
  evenAndOddHeaders?: boolean;
}): DocxHeaderFooterInfo {
  return {
    header: headerFooterLines(parsed.headerParas, parsed.headerText),
    footer: headerFooterLines(parsed.footerParas, parsed.footerText),
    headerImages: parsed.headerImages?.length ?? 0,
    footerImages: parsed.footerImages?.length ?? 0,
    watermark: parsed.watermarkText ?? null,
    differentFirstPage: Boolean(parsed.titlePg),
    differentOddEven: Boolean(parsed.evenAndOddHeaders),
  };
}
