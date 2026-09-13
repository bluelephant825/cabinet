/**
 * Human labels for catalog components and prop keys. Every entry is a
 * literal t("pdfComposer:...") call so `npm run i18n:check` covers them;
 * lookups fall back to the catalog's English label / a humanized key.
 */
import type { TFunction } from "i18next";

function humanize(key: string): string {
  return key.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());
}

/** type → localized palette/outline label. */
export function componentLabel(
  t: TFunction,
  type: string,
  fallback: string,
): string {
  const labels: Record<string, string> = {
    heading: t("pdfComposer:components.heading"),
    text: t("pdfComposer:components.text"),
    list: t("pdfComposer:components.list"),
    link: t("pdfComposer:components.link"),
    "key-value": t("pdfComposer:components.key-value"),
    divider: t("pdfComposer:components.divider"),
    section: t("pdfComposer:components.section"),
    stack: t("pdfComposer:components.stack"),
    columns: t("pdfComposer:components.columns"),
    "keep-together": t("pdfComposer:components.keep-together"),
    "page-break": t("pdfComposer:components.page-break"),
    table: t("pdfComposer:components.table"),
    graph: t("pdfComposer:components.graph"),
    image: t("pdfComposer:components.image"),
    "qr-code": t("pdfComposer:components.qr-code"),
    badge: t("pdfComposer:components.badge"),
    callout: t("pdfComposer:components.callout"),
    card: t("pdfComposer:components.card"),
    "page-number": t("pdfComposer:components.page-number"),
    watermark: t("pdfComposer:components.watermark"),
  };
  return labels[type] ?? fallback;
}

/** Per-component overrides win over the shared prop labels. */
export function propLabel(t: TFunction, componentType: string, name: string): string {
  const labels: Record<string, string> = {
    level: t("pdfComposer:props.level"),
    text: t("pdfComposer:props.text"),
    align: t("pdfComposer:props.align"),
    color: t("pdfComposer:props.color"),
    fontSize: t("pdfComposer:props.fontSize"),
    bold: t("pdfComposer:props.bold"),
    italic: t("pdfComposer:props.italic"),
    ordered: t("pdfComposer:props.ordered"),
    items: t("pdfComposer:props.items"),
    href: t("pdfComposer:props.href"),
    thickness: t("pdfComposer:props.thickness"),
    spacing: t("pdfComposer:props.spacing"),
    title: t("pdfComposer:props.title"),
    gap: t("pdfComposer:props.gap"),
    direction: t("pdfComposer:props.direction"),
    weights: t("pdfComposer:props.weights"),
    variant: t("pdfComposer:props.variant"),
    zebraStripe: t("pdfComposer:props.zebraStripe"),
    header: t("pdfComposer:props.header"),
    subtitle: t("pdfComposer:props.subtitle"),
    xLabel: t("pdfComposer:props.xLabel"),
    yLabel: t("pdfComposer:props.yLabel"),
    height: t("pdfComposer:props.height"),
    showValues: t("pdfComposer:props.showValues"),
    showGrid: t("pdfComposer:props.showGrid"),
    legend: t("pdfComposer:props.legend"),
    asset: t("pdfComposer:props.asset"),
    width: t("pdfComposer:props.width"),
    caption: t("pdfComposer:props.caption"),
    fit: t("pdfComposer:props.fit"),
    value: t("pdfComposer:props.value"),
    size: t("pdfComposer:props.size"),
    padding: t("pdfComposer:props.padding"),
    format: t("pdfComposer:props.format"),
    opacity: t("pdfComposer:props.opacity"),
    angle: t("pdfComposer:props.angle"),
  };
  const overrides: Record<string, string> = {
    "table.header": t("pdfComposer:props.table.header"),
  };
  return overrides[`${componentType}.${name}`] ?? labels[name] ?? humanize(name);
}
