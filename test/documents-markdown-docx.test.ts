import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";

import { buildBlankDocx } from "../src/vendor/genoffice/packages/docx-engine/src/blank";
import {
  parseDocx,
  saveDocx,
  type Block,
  type ParsedDoc,
  type SaveBlock,
} from "../src/vendor/genoffice/packages/docx-engine/src/index";
import type { GeneratedBlock } from "../src/vendor/genoffice/packages/docx-engine/src/types";
import { docxToMarkdown } from "../server/documents/markdown/from-docx";
import type { AssetSink } from "../server/documents/markdown/assets";

function makePngDataUrl(): string {
  const png = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200;
    png.data[i + 1] = 60;
    png.data[i + 2] = 40;
    png.data[i + 3] = 255;
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

function fakeSink(): AssetSink & { added: { name?: string; ext: string }[] } {
  const added: { name?: string; ext: string }[] = [];
  let n = 0;
  return {
    added,
    files: [],
    async add(_data, ext, name) {
      added.push({ ext, name });
      const file = name ?? `img-0${++n}.${ext}`;
      this.files.push(file);
      return `./assets/${file}`;
    },
  };
}

function gen(block: GeneratedBlock): SaveBlock {
  return { kind: "generated", block };
}

async function docxFromBlocks(blocks: SaveBlock[]): Promise<ParsedDoc> {
  const blank = await buildBlankDocx();
  const doc = await parseDocx(blank);
  const bytes = await saveDocx(doc, blocks);
  return parseDocx(bytes);
}

test("docx → markdown: headings, paragraphs, lists, links", async () => {
  const doc = await docxFromBlocks([
    gen({ type: "heading", level: 1, runs: [{ text: "Report" }] }),
    gen({
      type: "paragraph",
      runs: [
        { text: "Hello " },
        { text: "world", bold: true },
        { text: " and " },
        { text: "link", link: { href: "https://example.com" } },
      ],
    }),
    gen({ type: "listItem", list: { kind: "bullet", numId: "1", ilvl: 0 }, runs: [{ text: "apple" }] }),
    gen({ type: "listItem", list: { kind: "bullet", numId: "1", ilvl: 1 }, runs: [{ text: "nested" }] }),
    gen({ type: "listItem", list: { kind: "ordered", numId: "2", ilvl: 0 }, runs: [{ text: "first" }] }),
    gen({ type: "listItem", list: { kind: "ordered", numId: "2", ilvl: 0 }, runs: [{ text: "second" }] }),
  ]);

  const sink = fakeSink();
  const { markdown, warnings, title } = await docxToMarkdown(doc, {
    target: "md",
    assets: sink,
  });
  assert.equal(title, "Report");
  assert.deepEqual(warnings, []);
  assert.ok(markdown.includes("# Report"), markdown);
  assert.ok(markdown.includes("Hello **world** and [link](https://example.com)"), markdown);
  assert.ok(markdown.includes("- apple\n  - nested"), markdown);
  assert.ok(markdown.includes("1. first\n2. second"), markdown);
});

function minimalDoc(blocks: Partial<Block>[]): ParsedDoc {
  return {
    blocks: blocks.map((b, i) => ({
      id: `b${i}`,
      docxIndex: null,
      originalXml: null,
      ...b,
    })) as Block[],
    comments: [],
    footnotes: [],
    endnotes: [],
    sources: [],
    inks: [],
    styles: new Map(),
    headingStyleIds: new Map(),
    protection: null,
    writeProtection: null,
    removePersonalInfo: false,
    numbering: new Map(),
    internal: {} as ParsedDoc["internal"],
  };
}

test("docx → markdown: table with colSpan and vMerge", async () => {
  const doc = minimalDoc([
    {
      type: "table",
      table: {
        rows: [
          [
            { paras: ["Name"], colSpan: 2 },
            { paras: ["Age"] },
          ],
          [
            { paras: ["Ada"] },
            { paras: [""], vMerge: "continue" },
            { paras: ["36"] },
          ],
        ],
      },
    },
  ]);
  const { markdown } = await docxToMarkdown(doc, { target: "md", assets: fakeSink() });
  assert.ok(markdown.includes("| Name |  | Age |"), markdown);
  assert.ok(markdown.includes("| --- | --- | --- |"), markdown);
  assert.ok(markdown.includes("| Ada |  | 36 |"), markdown);
});

test("docx → markdown: richParas cell escapes pipes", async () => {
  const doc = minimalDoc([
    {
      type: "table",
      table: {
        rows: [
          [{ paras: [], richParas: [{ runs: [{ text: "a | b", bold: true }] }] }],
          [{ paras: [], richParas: [{ runs: [{ text: "x" }] }] }],
        ],
      },
    },
  ]);
  const { markdown } = await docxToMarkdown(doc, { target: "md", assets: fakeSink() });
  assert.ok(markdown.includes("| **a \\| b** |"), markdown);
});

test("docx → markdown: image goes through the asset sink", async () => {
  const doc = minimalDoc([
    { type: "image", imageDataUrl: makePngDataUrl(), label: "logo" },
    { type: "paragraph", runs: [{ text: "after" }] },
  ]);
  const sink = fakeSink();
  const { markdown } = await docxToMarkdown(doc, { target: "md", assets: sink });
  assert.equal(sink.added.length, 1);
  assert.equal(sink.added[0]!.ext, "png");
  assert.ok(markdown.includes("![logo](./assets/img-01.png)"), markdown);
});

test("docx → mdx: textbox becomes Callout; md becomes blockquote", async () => {
  const box = {
    paras: [{ runs: [{ text: "boxed note" }] }],
  };
  const doc = minimalDoc([
    { type: "paragraph", runs: [{ text: "body" }], textboxes: [box as never] },
  ]);
  const md = await docxToMarkdown(doc, { target: "md", assets: fakeSink() });
  assert.ok(md.markdown.includes("> boxed note"), md.markdown);
  const mdx = await docxToMarkdown(doc, { target: "mdx", assets: fakeSink() });
  assert.ok(mdx.markdown.includes("<Callout>\n\nboxed note\n\n</Callout>"), mdx.markdown);
});

test("docx → markdown: footnote refs and definitions", async () => {
  const doc = minimalDoc([
    {
      type: "paragraph",
      runs: [
        { text: "claim" },
        { text: "1", noteRef: { kind: "footnote", id: "2" } },
      ],
    },
  ]);
  doc.footnotes = [{ id: "2", text: "the note text" } as never];
  const { markdown } = await docxToMarkdown(doc, { target: "md", assets: fakeSink() });
  assert.ok(markdown.includes("claim[^2]"), markdown);
  assert.ok(markdown.includes("[^2]: the note text"), markdown);
});
