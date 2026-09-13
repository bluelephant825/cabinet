/**
 * PDFCN component catalog: the contract between .pdf.source.json compositions,
 * the validation rules in pdf-composition.ts, and the vendored render
 * components in src/vendor/pdfcn. `type` values are the only strings the
 * renderer accepts — the worker maps them through a fixed registry, never a
 * dynamic lookup.
 */

export const PDFCN_CATALOG_VERSION = "1.0.0";

/** Renderer identity reported in render results + cache keys. Worker-side
    pdf-generation.tsx re-exports this as PDF_RENDERER (service code must not
    import the worker module). */
export const PDFCN_RENDERER = { id: "takumi", version: "0.14.3" } as const;

export type PdfPropType =
  | "string"
  | "number"
  | "boolean"
  | "color"
  | "length-pt"
  | "url"
  | "asset-ref"
  | "json";

export interface PdfPropSpec {
  type: PdfPropType;
  required?: boolean;
  enum?: readonly string[];
  min?: number;
  max?: number;
  /** Human hint surfaced in validation errors and agent help. */
  hint?: string;
}

export type PdfCategory =
  | "Content"
  | "Layout"
  | "Data"
  | "Media"
  | "Status"
  | "Document";

export interface PdfComponentSpec {
  type: string;
  category: PdfCategory;
  label: string;
  icon: string;
  /** Categories this node may appear under: 'body'|'header'|'footer' roots
      or another component type. */
  allowedParents: readonly string[];
  /** true → may contain child nodes (containers only). */
  allowsChildren?: boolean;
  props: Record<string, PdfPropSpec>;
  defaults?: Record<string, unknown>;
  /** Free-form per-node payload checked shape-only (chart data, table rows). */
  data?: { kind: "rows" | "chart" | "kv" };
}

const ROOTS = ["body", "header", "footer"] as const;
const CONTAINERS = ["section", "stack", "columns", "keep-together", "card", "callout"] as const;
const ANY_BLOCK: readonly string[] = [...ROOTS, ...CONTAINERS];
const ANYWHERE: readonly string[] = [...ANY_BLOCK];

export const PDF_COMPONENTS: readonly PdfComponentSpec[] = [
  // ── Content ──────────────────────────────────────────────────────────
  {
    type: "heading",
    category: "Content",
    label: "Heading",
    icon: "heading-1",
    allowedParents: ANYWHERE,
    props: {
      level: { type: "number", enum: ["1", "2", "3", "4", "5", "6"], hint: "1-6" },
      text: { type: "string", required: true },
      align: { type: "string", enum: ["left", "center", "right"] },
      color: { type: "color" },
    },
    defaults: { level: 1 },
  },
  {
    type: "text",
    category: "Content",
    label: "Text",
    icon: "text",
    allowedParents: ANYWHERE,
    props: {
      text: { type: "string", required: true },
      align: { type: "string", enum: ["left", "center", "right", "justify"] },
      color: { type: "color" },
      fontSize: { type: "length-pt", min: 4, max: 96 },
      bold: { type: "boolean" },
      italic: { type: "boolean" },
    },
  },
  {
    type: "list",
    category: "Content",
    label: "List",
    icon: "list",
    allowedParents: ANYWHERE,
    props: {
      ordered: { type: "boolean" },
      items: { type: "json", required: true, hint: "array of strings" },
    },
  },
  {
    type: "link",
    category: "Content",
    label: "Link",
    icon: "link",
    allowedParents: ANYWHERE,
    props: {
      text: { type: "string", required: true },
      href: { type: "url", required: true, hint: "https:, mailto:, or in-cabinet path" },
      color: { type: "color" },
    },
  },
  {
    type: "key-value",
    category: "Data",
    label: "Key-Value",
    icon: "list-checks",
    allowedParents: ANYWHERE,
    props: {},
    data: { kind: "kv" },
  },
  {
    type: "divider",
    category: "Layout",
    label: "Divider",
    icon: "minus",
    allowedParents: ANYWHERE,
    props: {
      color: { type: "color" },
      thickness: { type: "string", enum: ["thin", "medium", "thick"] },
      spacing: { type: "length-pt", min: 0, max: 120 },
    },
  },
  // ── Layout ───────────────────────────────────────────────────────────
  {
    type: "section",
    category: "Layout",
    label: "Section",
    icon: "layout-template",
    allowedParents: ANY_BLOCK,
    allowsChildren: true,
    props: {
      title: { type: "string" },
      gap: { type: "length-pt", min: 0, max: 96 },
    },
  },
  {
    type: "stack",
    category: "Layout",
    label: "Stack",
    icon: "layers",
    allowedParents: ANY_BLOCK,
    allowsChildren: true,
    props: {
      gap: { type: "length-pt", min: 0, max: 96 },
      direction: { type: "string", enum: ["vertical", "horizontal"] },
    },
  },
  {
    type: "columns",
    category: "Layout",
    label: "Columns",
    icon: "columns-2",
    allowedParents: ANY_BLOCK,
    allowsChildren: true,
    props: {
      gap: { type: "length-pt", min: 0, max: 96 },
      /** One weight per child column, e.g. [2,1]. */
      weights: { type: "json", hint: "array of numbers" },
    },
  },
  {
    type: "keep-together",
    category: "Layout",
    label: "Keep Together",
    icon: "link-2",
    allowedParents: ANY_BLOCK,
    allowsChildren: true,
    props: {},
  },
  {
    type: "page-break",
    category: "Layout",
    label: "Page Break",
    icon: "scissors",
    allowedParents: ANYWHERE,
    props: {},
  },
  // ── Data ─────────────────────────────────────────────────────────────
  {
    type: "table",
    category: "Data",
    label: "Table",
    icon: "table",
    allowedParents: ANYWHERE,
    props: {
      variant: { type: "string", enum: ["line", "bordered", "striped", "minimal"] },
      zebraStripe: { type: "boolean" },
      header: { type: "boolean" },
    },
    defaults: { variant: "line", header: true },
    data: { kind: "rows" },
  },
  {
    type: "graph",
    category: "Data",
    label: "Chart",
    icon: "bar-chart-3",
    allowedParents: ANYWHERE,
    props: {
      variant: { type: "string", enum: ["bar", "horizontal-bar", "line", "area", "pie", "donut"] },
      title: { type: "string" },
      subtitle: { type: "string" },
      xLabel: { type: "string" },
      yLabel: { type: "string" },
      height: { type: "length-pt", min: 60, max: 600 },
      showValues: { type: "boolean" },
      showGrid: { type: "boolean" },
      legend: { type: "string", enum: ["bottom", "right", "none"] },
    },
    defaults: { variant: "bar", height: 260 },
    data: { kind: "chart" },
  },
  // ── Media ────────────────────────────────────────────────────────────
  {
    type: "image",
    category: "Media",
    label: "Image",
    icon: "image",
    allowedParents: ANYWHERE,
    props: {
      asset: { type: "asset-ref", required: true, hint: "key into composition.assets" },
      width: { type: "length-pt", min: 8, max: 1000 },
      height: { type: "length-pt", min: 8, max: 1400 },
      caption: { type: "string" },
      fit: { type: "string", enum: ["contain", "cover", "fill", "none"] },
    },
  },
  {
    type: "qr-code",
    category: "Media",
    label: "QR Code",
    icon: "qr-code",
    allowedParents: ANYWHERE,
    props: {
      value: { type: "string", required: true },
      size: { type: "length-pt", min: 24, max: 400 },
      color: { type: "color" },
      caption: { type: "string" },
    },
    defaults: { size: 96 },
  },
  // ── Status ───────────────────────────────────────────────────────────
  {
    type: "badge",
    category: "Status",
    label: "Badge",
    icon: "tag",
    allowedParents: ANYWHERE,
    props: {
      text: { type: "string", required: true },
      variant: { type: "string", enum: ["default", "success", "warning", "destructive", "info", "outline"] },
      color: { type: "color" },
    },
  },
  {
    type: "callout",
    category: "Status",
    label: "Callout",
    icon: "info",
    allowedParents: ANYWHERE,
    allowsChildren: true,
    props: {
      variant: { type: "string", enum: ["info", "success", "warning", "destructive"] },
      title: { type: "string" },
      text: { type: "string" },
    },
    defaults: { variant: "info" },
  },
  {
    type: "card",
    category: "Status",
    label: "Card",
    icon: "square",
    allowedParents: ANYWHERE,
    allowsChildren: true,
    props: {
      title: { type: "string" },
      padding: { type: "length-pt", min: 0, max: 96 },
    },
  },
  // ── Document ─────────────────────────────────────────────────────────
  {
    type: "page-number",
    category: "Document",
    label: "Page Number",
    icon: "hash",
    allowedParents: [...ROOTS, "section", "stack", "columns", "card"],
    props: {
      format: { type: "string", hint: "{page} and {total} placeholders" },
      align: { type: "string", enum: ["left", "center", "right"] },
    },
    defaults: { format: "Page {page} of {total}" },
  },
  {
    type: "watermark",
    category: "Document",
    label: "Watermark",
    icon: "droplet",
    allowedParents: ["body"],
    props: {
      text: { type: "string", required: true },
      color: { type: "color" },
      opacity: { type: "number", min: 0.02, max: 0.5 },
      angle: { type: "number", min: -90, max: 90 },
    },
  },
];

const byType = new Map(PDF_COMPONENTS.map((c) => [c.type, c]));

export function componentSpec(type: string): PdfComponentSpec | undefined {
  return byType.get(type);
}

export const PDF_THEMES = ["professional", "minimal", "elegant"] as const;
export type PdfThemeId = (typeof PDF_THEMES)[number];

export function isPdfThemeId(id: string): id is PdfThemeId {
  return (PDF_THEMES as readonly string[]).includes(id);
}
