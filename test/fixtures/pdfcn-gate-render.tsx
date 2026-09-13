/**
 * Takumi gate render child. Usage:
 *   tsx pdfcn-gate-render.tsx <out.pdf> <theme:professional|minimal|elegant>
 *
 * Renders a 2+ page document through the vendored pdfcn components with the
 * bundled OFL fonts and a network-disabled fetch — proves pagination, page
 * size, searchable text, repeating footer page numbers, image/QR/graph
 * embedding, and per-render theme isolation.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { render, PageNumber as PageCounter, TotalPages } from "takumi-pdf";
import { createRequire } from "node:module";

import {
  Document,
  Page,
  View,
} from "../../src/vendor/pdfcn/registry/bases/takumi/lib/pdf-primitives";
import {
  PdfcnThemeProvider,
  runWithPdfcnTheme,
  type PdfcnTheme,
} from "../../src/vendor/pdfcn/registry/bases/takumi/components/theme-provider";
import { professionalTheme } from "../../src/vendor/pdfcn/registry/themes/professional";
import { minimalTheme } from "../../src/vendor/pdfcn/registry/themes/minimal";
import { elegantTheme } from "../../src/vendor/pdfcn/registry/themes/elegant";
import { Heading } from "../../src/vendor/pdfcn/registry/bases/takumi/components/heading/heading";
import { Text } from "../../src/vendor/pdfcn/registry/bases/takumi/components/text/text";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "../../src/vendor/pdfcn/registry/bases/takumi/components/table/table";
import { PdfGraph } from "../../src/vendor/pdfcn/registry/bases/takumi/components/graph/graph";
import { PdfImage } from "../../src/vendor/pdfcn/registry/bases/takumi/components/pdf-image/pdf-image";
import { PdfQRCode } from "../../src/vendor/pdfcn/registry/bases/takumi/components/qrcode/qrcode";

// Offline proof: nothing in the render may reach the network.
globalThis.fetch = (() => {
  throw new Error("network disabled in gate render");
}) as typeof fetch;

const require = createRequire(import.meta.url);
const FONT_DIR = require.resolve("../../resources/documents/pdf-fonts/LiberationSans-Regular.ttf").replace(/[^/\\]+$/, "");

const fontBytes = (name: string) => readFileSync(path.join(FONT_DIR, name));

// The themes name system families (Helvetica/Times/Courier/Lora/Playfair
// Display); the bundled Liberation faces are metric-compatible OFL
// substitutes, registered under the names the themes request.
const fonts = [
  { name: "Helvetica", data: fontBytes("LiberationSans-Regular.ttf"), weight: 400, style: "normal" as const },
  { name: "Helvetica", data: fontBytes("LiberationSans-Bold.ttf"), weight: 700, style: "normal" as const },
  { name: "Helvetica", data: fontBytes("LiberationSans-Italic.ttf"), weight: 400, style: "italic" as const },
  { name: "Helvetica", data: fontBytes("LiberationSans-BoldItalic.ttf"), weight: 700, style: "italic" as const },
  { name: "Times-Roman", data: fontBytes("LiberationSerif-Regular.ttf"), weight: 400, style: "normal" as const },
  { name: "Times-Roman", data: fontBytes("LiberationSerif-Bold.ttf"), weight: 700, style: "normal" as const },
  { name: "Courier", data: fontBytes("LiberationMono-Regular.ttf"), weight: 400, style: "normal" as const },
  { name: "Courier", data: fontBytes("LiberationMono-Bold.ttf"), weight: 700, style: "normal" as const },
  { name: "Lora", data: fontBytes("LiberationSerif-Regular.ttf"), weight: 400, style: "normal" as const },
  { name: "Playfair Display", data: fontBytes("LiberationSerif-Bold.ttf"), weight: 700, style: "normal" as const },
];

function makePng(): Buffer {
  const png = new PNG({ width: 64, height: 32 });
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 64; x++) {
      const i = (y * 64 + x) * 4;
      png.data[i] = 30 + x * 3;
      png.data[i + 1] = 100;
      png.data[i + 2] = 200 - y * 4;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

const THEMES: Record<string, PdfcnTheme> = {
  professional: professionalTheme,
  minimal: minimalTheme,
  elegant: elegantTheme,
};

const GateBody = () => (
  <View style={{ gap: 8 }}>
    <Heading level={1}>Gate Heading Alpha</Heading>
    <Text>Gate paragraph text proving searchable body content.</Text>
    <PdfImage src={{ uri: "gate-image.png" }} width={120} caption="Gate image" />
    <PdfQRCode value="https://cabinet.test/gate" size={64} />
    <PdfGraph
      variant="bar"
      data={[
        { label: "A", value: 3 },
        { label: "B", value: 7 },
        { label: "C", value: 5 },
      ]}
      title="Gate chart"
      height={180}
    />
    <Table variant="line">
      <TableHeader>
        <TableRow header>
          <TableCell>Row</TableCell>
          <TableCell align="right">Value</TableCell>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 60 }, (_, i) => (
          <TableRow key={i}>
            <TableCell>{`cell-${i}`}</TableCell>
            <TableCell align="right">{String(i * 7)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  </View>
);

const Doc = () => (
  <Document title="pdfcn-gate">
    <Page size="A4">
      <PdfcnThemeProvider>
        <GateBody />
      </PdfcnThemeProvider>
    </Page>
  </Document>
);

const footer = (
  <div
    style={{
      display: "flex",
      flexDirection: "row",
      justifyContent: "space-between",
      fontSize: 9,
      color: "#666666",
      fontFamily: "Helvetica",
      width: "100%",
    }}
  >
    <span>cabinet-documents gate</span>
    <span>
      Page <PageCounter /> of <TotalPages />
    </span>
  </div>
);

async function main() {
  const [outPath, themeName = "professional"] = process.argv.slice(2);
  const theme = THEMES[themeName];
  if (!outPath || !theme) {
    console.error("usage: pdfcn-gate-render.tsx <out.pdf> <theme>");
    process.exit(2);
  }
  const pdf = await runWithPdfcnTheme(theme, () =>
    render(<Doc />, {
      size: "a4",
      margin: { top: 64, bottom: 64, left: 56, right: 56 },
      footer,
      fonts,
      images: { sources: [{ src: "gate-image.png", data: makePng() }] },
      metadata: { title: "pdfcn gate", creator: "cabinet" },
    })
  );
  writeFileSync(outPath, pdf);
  console.log(`wrote ${outPath} (${pdf.length} bytes, theme=${themeName})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
