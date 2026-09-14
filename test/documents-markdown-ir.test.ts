import test from "node:test";
import assert from "node:assert/strict";

import type { IrDocument } from "../src/vendor/genoffice/packages/pdf2docx/src/pipeline";
import type {
  IrPage,
  PageBlock,
  Span,
  TextBlock,
} from "../src/vendor/genoffice/packages/pdf2docx/src/ir";
import type { Rect } from "../src/vendor/genoffice/packages/pdf2docx/src/geometry";
import { irToMarkdown } from "../server/documents/markdown/from-ir";
import type { AssetSink } from "../server/documents/markdown/assets";

const BOX: Rect = { x0: 0, y0: 0, x1: 100, y1: 12 };

function span(text: string, over: Partial<Span> = {}): Span {
  return {
    text,
    box: BOX,
    fontSize: 12,
    fontFamily: "Helvetica",
    bold: false,
    italic: false,
    color: "000000",
    dir: "ltr",
    script: "latin",
    ...over,
  };
}

function textBlock(lines: Span[][], over: Partial<TextBlock> = {}): TextBlock {
  return {
    kind: "text",
    lines: lines.map((spans) => ({ spans, box: BOX, baseline: 0, endsWithHyphen: false })),
    box: BOX,
    align: "left",
    firstLineIndentPt: 0,
    dir: "ltr",
    ...over,
  };
}

function page(blocks: PageBlock[], over: Partial<IrPage> = {}): IrPage {
  return {
    index: 0,
    widthPt: 595,
    heightPt: 842,
    rotation: 0,
    blocks,
    degraded: false,
    scanned: false,
    hasStructTree: false,
    ...over,
  };
}

function doc(pages: IrPage[]): IrDocument {
  return { irPages: pages, warnings: [], pageResults: [], furnitureHf: [] };
}

function fakeSink(): AssetSink {
  const files: string[] = [];
  return {
    files,
    async add(_data, ext, name) {
      const file = name ?? `img-0${files.length + 1}.${ext}`;
      files.push(file);
      return `./a-assets/${file}`;
    },
  };
}

/** Body text (12pt) used to give the heading inference enough paragraphs. */
const body1 = textBlock([[span("Regular body paragraph one with several words in it")]]);
const body2 = textBlock([[span("Regular body paragraph two with several words in it")]]);

test("ir → markdown: heading size clustering maps to # / ##", async () => {
  const h1 = textBlock([[span("Big Title", { fontSize: 24 })]]);
  const h2 = textBlock([[span("Section", { fontSize: 16 })]]);
  const { markdown, title } = await irToMarkdown(
    doc([page([h1, h2, body1, body2])]),
    { target: "md", assets: fakeSink() },
  );
  assert.equal(title, "Big Title");
  assert.ok(markdown.includes("# Big Title"), markdown);
  assert.ok(markdown.includes("## Section"), markdown);
});

test("ir → markdown: no-inference guard keeps slides as paragraphs", async () => {
  const { markdown, warnings } = await irToMarkdown(
    doc([page([textBlock([[span("Only Big", { fontSize: 28 })]])])]),
    { target: "md", assets: fakeSink() },
  );
  assert.ok(!markdown.includes("# "), markdown);
  assert.ok(warnings.some((w) => w.includes("headings")), String(warnings));
});

test("ir → markdown: lists, hyphenation join, hard break", async () => {
  const bullet = textBlock([[span("item one")]], {
    list: { kind: "bullet", level: 0, marker: "-" },
  });
  const ordered = textBlock([[span("step")]], {
    list: { kind: "ordered", level: 0, seqId: 3, start: 4, marker: "4." },
  });
  const ordered2 = textBlock([[span("next")]], {
    list: { kind: "ordered", level: 0, seqId: 3, marker: "5." },
  });
  const hyphenated: TextBlock = {
    ...textBlock([[span("hyph-")], [span("enated")]]),
    lines: [
      { spans: [span("hyph-")], box: BOX, baseline: 0, endsWithHyphen: true },
      { spans: [span("enated")], box: BOX, baseline: 0, endsWithHyphen: false },
    ],
  };
  const hardBreak: TextBlock = {
    ...textBlock([[span("first")], [span("second")]]),
    lines: [
      { spans: [span("first")], box: BOX, baseline: 0, endsWithHyphen: false },
      { spans: [span("second")], box: BOX, baseline: 0, endsWithHyphen: false, hardBreakBefore: true },
    ],
  };
  const { markdown } = await irToMarkdown(
    doc([page([bullet, ordered, ordered2, body1, body2, hyphenated, hardBreak])]),
    { target: "md", assets: fakeSink() },
  );
  assert.ok(markdown.includes("- item one"), markdown);
  assert.ok(markdown.includes("4. step\n5. next"), markdown);
  assert.ok(markdown.includes("hyphenated"), markdown);
  assert.ok(markdown.includes("first  \nsecond"), markdown);
});

test("ir → markdown: table gridSpan/vMerge; escaping in text", async () => {
  const cell = (text: string, over: object = {}) => ({
    box: BOX,
    gridSpan: 1,
    blocks: [textBlock([[span(text)]])],
    ...over,
  });
  const table: PageBlock = {
    kind: "table",
    box: BOX,
    colWidthsPt: [100, 100, 100],
    rows: [
      [cell("H1"), cell("H2", { gridSpan: 2 })],
      [cell("a"), cell("", { vMerge: "continue" }), cell("b")],
    ],
  };
  const esc = textBlock([[span("stars *and* _bars_ #tag | pipe [x]")]]);
  const { markdown } = await irToMarkdown(doc([page([table, body1, body2, esc])]), {
    target: "md",
    assets: fakeSink(),
  });
  assert.ok(markdown.includes("| H1 | H2 |  |"), markdown);
  assert.ok(markdown.includes("| a |  | b |"), markdown);
  assert.ok(markdown.includes("stars \\*and\\* \\_bars\\_ #tag | pipe \\[x\\]"), markdown);
});

test("ir → markdown: footnote refs + definitions", async () => {
  const anchor = textBlock([[span("text"), span("", { noteRef: "n1" })]]);
  const pg = page([anchor, body1, body2], {
    footnotes: [{ id: "n1", blocks: [textBlock([[span("note body")]])] }],
  });
  const { markdown } = await irToMarkdown(doc([pg]), { target: "md", assets: fakeSink() });
  assert.ok(markdown.includes("text[^n1]"), markdown);
  assert.ok(markdown.includes("[^n1]: note body"), markdown);
});

test("ir → markdown: scanned page renders to page-01.png; behind image skipped", async () => {
  const scanned = page([], {
    index: 0,
    scanned: true,
    render: { data: new Uint8Array([1, 2, 3]), mime: "image/png", pixelWidth: 600, pixelHeight: 800 },
  });
  const behind = page(
    [
      {
        kind: "image",
        box: BOX,
        data: new Uint8Array([9]),
        mime: "image/png",
        pixelWidth: 100,
        pixelHeight: 100,
        float: { wrap: "behind", xOffsetPt: 0 },
      },
      body1,
      body2,
    ],
    { index: 1 },
  );
  const sink = fakeSink();
  const { markdown, warnings } = await irToMarkdown(doc([scanned, behind]), {
    target: "md",
    assets: sink,
  });
  assert.ok(sink.files.includes("page-01.png"));
  assert.ok(markdown.includes("![Page 1](./a-assets/page-01.png)"), markdown);
  assert.ok(!sink.files.some((f) => f.startsWith("img-")), String(sink.files));
  assert.ok(warnings.some((w) => w.includes("page image")), String(warnings));
});

test("ir → markdown vs mdx: card becomes blockquote vs Callout", async () => {
  const card = textBlock([[span("card body")]], { cardId: 0 });
  const pg = page([card, body1, body2], {
    cards: [{ box: BOX, color: "EEEEEE" }],
  });
  const md = await irToMarkdown(doc([pg]), { target: "md", assets: fakeSink() });
  assert.ok(md.markdown.includes("> card body"), md.markdown);
  const mdx = await irToMarkdown(doc([pg]), { target: "mdx", assets: fakeSink() });
  assert.ok(mdx.markdown.includes("<Callout>\n\ncard body\n\n</Callout>"), mdx.markdown);
});

test("ir → markdown: toc entries skipped with one warning", async () => {
  const toc = textBlock([[span("Chapter One")]], {
    tocEntry: { level: 1, pageNumber: "3" },
  });
  const { markdown, warnings } = await irToMarkdown(doc([page([toc, body1, body2])]), {
    target: "md",
    assets: fakeSink() },
  );
  assert.ok(!markdown.includes("Chapter One"), markdown);
  assert.ok(warnings.some((w) => w.includes("table of contents")), String(warnings));
});
