import type { PdfcnTheme } from "@/vendor/pdfcn/registry/types/pdf-themes";

import { defaultPrimitives } from "./primitives";

/**
 * Elegant theme preset.
 *
 * Character: Warm cream-adjacent whites, amber/gold accent, Playfair Display
 * headings paired with Lora body — a classic editorial combination.
 * Ideal for design portfolios, luxury brands, and high-end editorial PDFs.
 */
export const elegantTheme: PdfcnTheme = {
  colors: {
    accent: "#b45309",
    background: "#ffffff",
    border: "#d6d3d1",
    destructive: "#dc2626",
    foreground: "#1c1917",
    info: "#0ea5e9",
    muted: "#fafaf9",
    mutedForeground: "#78716c",
    primary: "#78350f",
    primaryForeground: "#fffbeb",
    success: "#16a34a",
    warning: "#d97706",
  },
  name: "elegant",
  page: {
    orientation: "portrait",
    size: "A4",
  },
  primitives: defaultPrimitives,
  spacing: {
    componentGap: 16,
    page: {
      marginBottom: 60,
      marginLeft: 52,
      marginRight: 52,
      marginTop: 60,
    },
    paragraphGap: 12,
    sectionGap: 30,
  },
  typography: {
    body: {
      fontFamily: "Lora",
      fontSize: 11,
      lineHeight: 1.7,
    },
    heading: {
      fontFamily: "Playfair Display",
      fontSize: {
        h1: 36,
        h2: 26,
        h3: 20,
        h4: 16,
        h5: 14,
        h6: 12,
      },
      fontWeight: 700,
      lineHeight: 1.2,
    },
  },
};
