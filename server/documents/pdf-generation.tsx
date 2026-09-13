/**
 * Composition → PDF renderer (worker side). Maps validated PdfNode trees onto
 * the vendored pdfcn components through a FIXED registry — a composition type
 * string is never resolved dynamically — and renders via takumi-pdf. Theme
 * state is request-local (runWithPdfcnTheme) so concurrent renders cannot
 * cross-contaminate.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { ReactNode } from "react";
import { render as takumiRender } from "takumi-pdf";

import type { PdfComposition, PdfNode, JsonValue } from "@/lib/documents/pdf-composition";
import { PDFCN_RENDERER } from "@/lib/documents/pdf-component-catalog";
import { runWithPdfcnTheme } from "@/vendor/pdfcn/registry/bases/takumi/components/theme-provider";
import type { PdfcnTheme } from "@/vendor/pdfcn/registry/bases/takumi/components/theme-provider";
import { professionalTheme } from "@/vendor/pdfcn/registry/themes/professional";
import { minimalTheme } from "@/vendor/pdfcn/registry/themes/minimal";
import { elegantTheme } from "@/vendor/pdfcn/registry/themes/elegant";
import {
  Document,
  Page,
  View,
  pointToCssPixel,
} from "@/vendor/pdfcn/registry/bases/takumi/lib/pdf-primitives";
import { Heading } from "@/vendor/pdfcn/registry/bases/takumi/components/heading/heading";
import { Text } from "@/vendor/pdfcn/registry/bases/takumi/components/text/text";
import { Section } from "@/vendor/pdfcn/registry/bases/takumi/components/section/section";
import { Stack } from "@/vendor/pdfcn/registry/bases/takumi/components/stack/stack";
import { Divider } from "@/vendor/pdfcn/registry/bases/takumi/components/divider/divider";
import { PageBreak } from "@/vendor/pdfcn/registry/bases/takumi/components/page-break/page-break";
import { KeepTogether } from "@/vendor/pdfcn/registry/bases/takumi/components/keep-together/keep-together";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/vendor/pdfcn/registry/bases/takumi/components/table/table";
import { KeyValue } from "@/vendor/pdfcn/registry/bases/takumi/components/key-value/key-value";
import { PdfImage } from "@/vendor/pdfcn/registry/bases/takumi/components/pdf-image/pdf-image";
import { PdfGraph } from "@/vendor/pdfcn/registry/bases/takumi/components/graph/graph";
import type { GraphDataPoint, GraphSeries } from "@/vendor/pdfcn/registry/bases/takumi/components/graph/graph.types";
import { Badge } from "@/vendor/pdfcn/registry/bases/takumi/components/badge/badge";
import { PdfAlert } from "@/vendor/pdfcn/registry/bases/takumi/components/alert/alert";
import { PdfCard } from "@/vendor/pdfcn/registry/bases/takumi/components/card/card";
import { PdfQRCode } from "@/vendor/pdfcn/registry/bases/takumi/components/qrcode/qrcode";
import { PageNumber } from "@/vendor/pdfcn/registry/bases/takumi/components/page-number/page-number";
import { PdfWatermark } from "@/vendor/pdfcn/registry/bases/takumi/components/watermark/watermark";
import { Link } from "@/vendor/pdfcn/registry/bases/takumi/components/link/link";
import { PdfList } from "@/vendor/pdfcn/registry/bases/takumi/components/list/list";

export const PDF_RENDERER = PDFCN_RENDERER;

const THEMES: Record<string, PdfcnTheme> = {
  professional: professionalTheme,
  minimal: minimalTheme,
  elegant: elegantTheme,
};

// Bundled OFL fonts registered under the family names the vendored themes
// request (Liberation faces are metric-compatible substitutes).
const FONT_DIR = path.resolve(__dirname, "../../resources/documents/pdf-fonts");
const FONT_FILES: [string, string, number, string][] = [
  ["Helvetica", "LiberationSans-Regular.ttf", 400, "normal"],
  ["Helvetica", "LiberationSans-Bold.ttf", 700, "normal"],
  ["Helvetica", "LiberationSans-Italic.ttf", 400, "italic"],
  ["Helvetica", "LiberationSans-BoldItalic.ttf", 700, "italic"],
  ["Times-Roman", "LiberationSerif-Regular.ttf", 400, "normal"],
  ["Times-Roman", "LiberationSerif-Bold.ttf", 700, "normal"],
  ["Courier", "LiberationMono-Regular.ttf", 400, "normal"],
  ["Courier", "LiberationMono-Bold.ttf", 700, "normal"],
  ["Lora", "LiberationSerif-Regular.ttf", 400, "normal"],
  ["Playfair Display", "LiberationSerif-Bold.ttf", 700, "normal"],
];

let cachedFonts: { name: string; data: Buffer; weight: number; style: "normal" | "italic" }[] | null = null;
export function compositionFonts() {
  if (!cachedFonts) {
    cachedFonts = FONT_FILES.map(([name, file, weight, style]) => ({
      name,
      data: readFileSync(path.join(FONT_DIR, file)),
      weight,
      style: style as "normal" | "italic",
    }));
  }
  return cachedFonts;
}

export interface CompositionWarning {
  nodeId?: string;
  code: string;
  message: string;
}

export interface RenderCompositionInput {
  composition: PdfComposition;
  /** Absolute dir composition assets resolve against (already authorized). */
  assetsDir: string;
  outputPath?: string;
  mode: "preview" | "publish";
}

export interface RenderCompositionResult {
  pageCount: number;
  pages: { index: number; widthPt: number; heightPt: number }[];
  warnings: CompositionWarning[];
  renderer: { id: string; version: string };
  fontsUsed: string[];
  /** Set on success; bytes also written to outputPath when given. */
  bytes?: Uint8Array;
}

const str = (v: JsonValue | undefined): string | undefined =>
  typeof v === "string" ? v : undefined;
const num = (v: JsonValue | undefined): number | undefined =>
  typeof v === "number" ? v : undefined;
const bool = (v: JsonValue | undefined): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;

const PAGE_SIZES: Record<string, { width: number; height: number }> = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 },
};

function assetUri(
  node: PdfNode,
  composition: PdfComposition,
  warnings: CompositionWarning[],
): string | null {
  const key = str(node.props?.asset);
  const asset = key ? composition.assets?.[key] : undefined;
  if (!key || !asset) {
    warnings.push({ nodeId: node.id, code: "missing-asset", message: `image asset "${key ?? ""}" not declared` });
    return null;
  }
  return `asset://${key}`;
}

function renderNode(
  node: PdfNode,
  ctx: { composition: PdfComposition; warnings: CompositionWarning[] },
): ReactNode {
  if (node.hidden) return null;
  const p = node.props ?? {};
  const kids = () => (node.children ?? []).map((c) => renderNode(c, ctx));
  switch (node.type) {
    case "heading":
      return (
        <Heading level={(num(p.level) ?? 1) as 1 | 2 | 3 | 4 | 5 | 6} align={str(p.align) as never} color={str(p.color)}>
          {str(p.text) ?? ""}
        </Heading>
      );
    case "text":
      return (
        <Text
          align={str(p.align) as never}
          color={str(p.color)}
          weight={bool(p.bold) ? "bold" : undefined}
          italic={bool(p.italic)}
          style={num(p.fontSize) ? { fontSize: num(p.fontSize) } : undefined}
        >
          {str(p.text) ?? ""}
        </Text>
      );
    case "list": {
      const items = Array.isArray(p.items) ? p.items : [];
      return (
        <PdfList
          variant={bool(p.ordered) ? "numbered" : "bullet"}
          items={items.map((i) => ({ text: String(i) }))}
        />
      );
    }
    case "link":
      return (
        <Link href={str(p.href) ?? "#"} color={str(p.color)}>
          {str(p.text) ?? str(p.href) ?? ""}
        </Link>
      );
    case "key-value": {
      const entries = (node.data as { entries?: { key: string; value: string }[] })?.entries ?? [];
      return <KeyValue items={entries.map((e) => ({ key: String(e.key), value: String(e.value) }))} />;
    }
    case "divider":
      return (
        <Divider
          color={str(p.color)}
          thickness={str(p.thickness) as never}
          style={num(p.spacing) ? { marginTop: num(p.spacing)! / 2, marginBottom: num(p.spacing)! / 2 } : undefined}
        />
      );
    case "section":
      return (
        <Section style={num(p.gap) ? { gap: num(p.gap) } : undefined}>
          {str(p.title) ? <Heading level={2}>{str(p.title)}</Heading> : null}
          {kids()}
        </Section>
      );
    case "stack":
      return (
        <Stack
          direction={str(p.direction) === "horizontal" ? "horizontal" : "vertical"}
          style={num(p.gap) ? { gap: num(p.gap) } : undefined}
        >
          {kids()}
        </Stack>
      );
    case "columns": {
      const weights = Array.isArray(p.weights) ? (p.weights as JsonValue[]).map((w) => Number(w) || 1) : [];
      return (
        <View style={{ display: "flex", flexDirection: "row", gap: num(p.gap) ?? 12 }}>
          {(node.children ?? []).map((c, i) => (
            <View key={c.id} style={{ flex: weights[i] ?? 1, flexDirection: "column" }}>
              {renderNode(c, ctx)}
            </View>
          ))}
        </View>
      );
    }
    case "keep-together":
      return <KeepTogether>{kids()}</KeepTogether>;
    case "page-break":
      return <PageBreak />;
    case "table": {
      const data = (node.data ?? {}) as { columns?: unknown[]; rows?: unknown[][] };
      const columns = (data.columns ?? []).map((c) => String(c));
      const rows = data.rows ?? [];
      return (
        <Table variant={str(p.variant) as never} zebraStripe={bool(p.zebraStripe)}>
          {p.header !== false && columns.length > 0 && (
            <TableHeader>
              <TableRow header>
                {columns.map((c, i) => (
                  <TableCell key={i} header>{c}</TableCell>
                ))}
              </TableRow>
            </TableHeader>
          )}
          <TableBody>
            {rows.map((row, ri) => (
              <TableRow key={ri}>
                {(Array.isArray(row) ? row : []).map((cell, ci) => (
                  <TableCell key={ci}>{String(cell)}</TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
    }
    case "graph": {
      const d = (node.data ?? {}) as { data?: GraphDataPoint[] | GraphSeries[] };
      return (
        <PdfGraph
          variant={str(p.variant) as never}
          data={d.data ?? []}
          title={str(p.title)}
          subtitle={str(p.subtitle)}
          xLabel={str(p.xLabel)}
          yLabel={str(p.yLabel)}
          height={num(p.height)}
          showValues={bool(p.showValues)}
          showGrid={bool(p.showGrid)}
          legend={str(p.legend) as never}
        />
      );
    }
    case "image": {
      const uri = assetUri(node, ctx.composition, ctx.warnings);
      if (!uri) return null;
      return (
        <PdfImage
          src={{ uri }}
          width={num(p.width)}
          height={num(p.height)}
          fit={str(p.fit) as never}
          caption={str(p.caption)}
        />
      );
    }
    case "qr-code":
      return (
        <PdfQRCode
          value={str(p.value) ?? ""}
          size={num(p.size)}
          color={str(p.color)}
          caption={str(p.caption)}
        />
      );
    case "badge":
      return <Badge label={str(p.text) ?? ""} variant={str(p.variant) as never} color={str(p.color)} />;
    case "callout":
      return (
        <PdfAlert variant={str(p.variant) as never} title={str(p.title)}>
          {str(p.text) ?? kids()}
        </PdfAlert>
      );
    case "card":
      return (
        <PdfCard title={str(p.title)} style={num(p.padding) ? { padding: num(p.padding) } : undefined}>
          {kids()}
        </PdfCard>
      );
    case "page-number":
      return <PageNumber format={str(p.format)} align={str(p.align) as never} />;
    case "watermark":
      return (
        <PdfWatermark
          text={str(p.text) ?? ""}
          color={str(p.color)}
          opacity={num(p.opacity)}
          angle={num(p.angle)}
        />
      );
    default:
      ctx.warnings.push({ nodeId: node.id, code: "unknown-type", message: `skipped unknown type "${node.type}"` });
      return null;
  }
}

function band(nodes: PdfNode[] | undefined, ctx: { composition: PdfComposition; warnings: CompositionWarning[] }): ReactNode {
  if (!nodes || nodes.length === 0) return undefined;
  return (
    <View style={{ display: "flex", flexDirection: "column", width: "100%" }}>
      {nodes.map((n) => renderNode(n, ctx))}
    </View>
  );
}

export async function renderComposition(input: RenderCompositionInput): Promise<RenderCompositionResult> {
  const { composition } = input;
  const theme = THEMES[composition.theme] ?? professionalTheme;
  const warnings: CompositionWarning[] = [];
  const ctx = { composition, warnings };

  // Resolve declared assets server-side: asset://<key> → bytes from the
  // authorized assets directory. No remote URLs, no fs access in the tree.
  const images: { src: string; data: Uint8Array }[] = [];
  for (const [key, asset] of Object.entries(composition.assets ?? {})) {
    const abs = path.resolve(input.assetsDir, asset.path);
    if (!abs.startsWith(path.resolve(input.assetsDir) + path.sep)) {
      warnings.push({ code: "bad-asset", message: `asset "${key}" escapes the assets directory` });
      continue;
    }
    try {
      const data = readFileSync(abs);
      if (data.length > 20 * 1024 * 1024) {
        warnings.push({ code: "bad-asset", message: `asset "${key}" exceeds 20MB` });
        continue;
      }
      images.push({ src: `asset://${key}`, data });
    } catch {
      warnings.push({ code: "missing-asset", message: `asset "${key}" not found: ${asset.path}` });
    }
  }

  const size = typeof composition.page.size === "string"
    ? PAGE_SIZES[composition.page.size]
    : { width: composition.page.size.widthPt, height: composition.page.size.heightPt };
  const cssSize = {
    width: pointToCssPixel(size.width),
    height: pointToCssPixel(size.height),
  };

  const Body = () => (
    <Document title={composition.title}>
      <Page style={{ display: "flex", flexDirection: "column" }}>
        {composition.body.map((n) => renderNode(n, ctx))}
      </Page>
    </Document>
  );

  const timeoutMs = input.mode === "preview" ? 20_000 : 60_000;
  const bytes = await runWithPdfcnTheme(theme, () =>
    Promise.race([
      takumiRender(<Body />, {
        size: cssSize,
        landscape: composition.page.orientation === "landscape",
        margin: {
          top: pointToCssPixel(composition.page.margins.top),
          right: pointToCssPixel(composition.page.margins.right),
          bottom: pointToCssPixel(composition.page.margins.bottom),
          left: pointToCssPixel(composition.page.margins.left),
        },
        header: band(composition.header, ctx),
        footer: band(composition.footer, ctx),
        fonts: compositionFonts(),
        images: { sources: images },
        metadata: { title: composition.title, creator: "cabinet-documents" },
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`render timed out after ${timeoutMs}ms`)), timeoutMs),
      ),
    ]),
  );

  // Exact page geometry from the produced bytes (pdf-lib is already a
  // worker-side dep; Takumi exposes no per-page or per-node boxes).
  const { PDFDocument } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  const pages = doc.getPages().map((p, index) => ({
    index,
    widthPt: p.getWidth(),
    heightPt: p.getHeight(),
  }));

  if (input.outputPath) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(input.outputPath, bytes);
  }
  return {
    pageCount: pages.length,
    pages,
    warnings,
    renderer: { ...PDF_RENDERER },
    fontsUsed: [...new Set(FONT_FILES.map(([n]) => n))],
    bytes,
  };
}
