import test from "node:test";
import assert from "node:assert/strict";

import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { setCellAttr } from "@tiptap/pm/tables";

import {
  buildBlankDocx,
  parseDocx,
  saveDocx,
  type SaveBlock,
} from "../src/vendor/genoffice/packages/docx-engine/src/index";
import { editorExtensions } from "../src/vendor/genoffice/apps/docs/src/renderer/editor/extensions";
import {
  blocksToPmDoc,
  pmDocToSavePlan,
  tableModelToPmNode,
  type PmNode,
} from "../src/vendor/genoffice/apps/docs/src/renderer/editor/convert";
import {
  caretTableInfo,
  fitImageSize,
  horizontalRuleTransaction,
  imageBlockJson,
  listParagraphStyles,
  paragraphStyleCss,
  parseImageDataUrl,
  repeatHeaderTransaction,
  tableAttrsTransaction,
  tableBordersTransaction,
  tableIsBordered,
  type StyleEntry,
} from "../src/components/editor/documents/docx-toolbar-commands";
import {
  headerFooterLines,
  summarizeHeaderFooter,
} from "../src/lib/documents/docx-header-footer";

const schema = getSchema(editorExtensions);
const stateOf = (doc: Record<string, unknown>) =>
  EditorState.create({ schema, doc: schema.nodeFromJSON(doc) });
const p = (text = "") => ({ type: "docParagraph", content: text ? [{ type: "text", text }] : [] });

// 1x1 PNG
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

async function roundTrip(mutate: (doc: PmNode) => Promise<PmNode> | PmNode) {
  const parsed = await parseDocx(await buildBlankDocx());
  const base = await saveDocx(
    parsed,
    [{ kind: "generated", block: { type: "paragraph", runs: [{ text: "Body" }] } }] as SaveBlock[],
    {},
  );
  const doc = await parseDocx(base);
  const pm = blocksToPmDoc(doc.blocks as never, [] as never) as unknown as PmNode;
  const next = await mutate(pm);
  const plan = pmDocToSavePlan(next, doc.blocks as never) as unknown as { saveBlocks: SaveBlock[] };
  return parseDocx(await saveDocx(doc, plan.saveBlocks, {}));
}

// ── horizontal rule ────────────────────────────────────────────────────────

test("horizontal rule after a text paragraph adds a bordered empty paragraph and an empty caret paragraph", () => {
  const state = stateOf({ type: "doc", content: [p("hello")] });
  const at = TextSelection.create(state.doc, 3);
  const tr = horizontalRuleTransaction(state.apply(state.tr.setSelection(at)))!;
  const doc = tr.doc;
  assert.equal(doc.childCount, 3);
  assert.equal(doc.child(0).textContent, "hello");
  assert.equal(doc.child(0).attrs.borders, null);
  assert.equal(doc.child(1).attrs.borders, "b");
  assert.equal(doc.child(1).textContent, "");
  assert.equal(doc.child(2).attrs.borders, null);
  assert.equal(tr.selection.$from.parent, doc.child(2));
});

test("horizontal rule on an empty paragraph turns it into the rule", () => {
  const state = stateOf({ type: "doc", content: [p("a"), p()] });
  const s2 = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(state.doc.content.size - 1))));
  const doc = horizontalRuleTransaction(s2)!.doc;
  assert.equal(doc.childCount, 3);
  assert.equal(doc.child(1).attrs.borders, "b");
  assert.equal(doc.child(2).attrs.borders, null);
});

test("a horizontal rule survives save and reload as a bottom paragraph border", async () => {
  const reloaded = await roundTrip((pm) => {
    const state = EditorState.create({ schema, doc: schema.nodeFromJSON(pm) });
    const s2 = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 2)));
    return horizontalRuleTransaction(s2)!.doc.toJSON() as PmNode;
  });
  const bordered = (reloaded.blocks as { originalXml?: string }[]).filter((b) =>
    /<w:pBdr><w:bottom /.test(b.originalXml ?? ""),
  );
  assert.equal(bordered.length, 1);
});

// ── insert image ───────────────────────────────────────────────────────────

test("parseImageDataUrl accepts png/jpeg/gif data URLs only", () => {
  assert.equal(parseImageDataUrl(PNG)?.mime, "image/png");
  assert.equal(parseImageDataUrl("data:image/svg+xml;base64,AAAA"), null);
  assert.equal(parseImageDataUrl("https://x.test/a.png"), null);
  assert.equal(parseImageDataUrl("data:image/png;base64,<script>"), null);
});

test("fitImageSize scales to the column and never upscales", () => {
  assert.deepEqual(fitImageSize(1200, 600), { widthPx: 600, heightPx: 300 });
  assert.deepEqual(fitImageSize(100, 50), { widthPx: 100, heightPx: 50 });
  assert.deepEqual(fitImageSize(0, 0), { widthPx: 1, heightPx: 1 });
});

test("an inserted image is embedded on save and comes back as an image block", async () => {
  const node = imageBlockJson(PNG, { widthPx: 40, heightPx: 20 }, "logo");
  assert.ok(node);
  assert.equal(imageBlockJson("data:text/plain;base64,AAAA", { widthPx: 1, heightPx: 1 }), null);
  const reloaded = await roundTrip((pm) => ({
    ...pm,
    content: [...(pm.content ?? []), node as unknown as PmNode],
  }));
  const img = (reloaded.blocks as { type: string; imageDataUrl?: string }[]).find((b) => b.type === "image");
  assert.ok(img?.imageDataUrl?.startsWith("data:image/png;base64,"));
});

// ── styles gallery ─────────────────────────────────────────────────────────

const style = (over: Partial<StyleEntry> & { styleId: string }): [string, StyleEntry] => [
  over.styleId,
  { name: over.styleId, type: "paragraph", ...over },
];

test("listParagraphStyles keeps default, headings and quick styles, ordered", () => {
  const list = listParagraphStyles([
    style({ styleId: "Zeta", qFormat: true }),
    style({ styleId: "Heading2", name: "Heading 2", headingLevel: 2 }),
    style({ styleId: "Hidden", qFormat: true, semiHidden: true }),
    style({ styleId: "Plain" }),
    style({ styleId: "Normal", isDefault: true }),
    style({ styleId: "Heading1", name: "Heading 1", headingLevel: 1 }),
    style({ styleId: "Char", type: "character", qFormat: true }),
    style({ styleId: "Alpha", qFormat: true }),
  ]);
  assert.deepEqual(list.map((s) => s.styleId), ["Normal", "Heading1", "Heading2", "Alpha", "Zeta"]);
});

test("paragraphStyleCss emits allow-listed declarations keyed on data-style", () => {
  const css = paragraphStyleCss([
    { styleId: "Normal", name: "Normal", type: "paragraph", isDefault: true, display: { bold: true } },
    {
      styleId: "Heading1",
      name: "Heading 1",
      type: "paragraph",
      display: { sizeHalfPoints: 32, bold: true, color: "2F5496", fontAscii: "Calibri Light" },
    },
    { styleId: "Bad\"}x", name: "x", type: "paragraph", display: { bold: true } },
    { styleId: "Evil", name: "e", type: "paragraph", display: { color: "red;}", fontAscii: 'a"};b' } },
  ]);
  assert.match(css, /\.doc-page \[data-style="Heading1"\]\{font-size:16pt;font-weight:700;color:#2F5496;font-family:"Calibri Light",sans-serif\}/);
  assert.doesNotMatch(css, /Normal|Bad|Evil/);
});

// ── header / footer summary ────────────────────────────────────────────────

test("headerFooterLines prefers rich paragraphs, names the page fields and trims trailing blanks", () => {
  assert.deepEqual(
    headerFooterLines([{ runs: [{ text: "Page " }, { text: "\uE001" }, { text: " of " }, { text: "\uE000" }] }, { runs: [] }], null),
    ["Page {page} of {pages}"],
  );
  assert.deepEqual(headerFooterLines(null, "a\nb\n"), ["a", "b"]);
  assert.deepEqual(headerFooterLines(null, null), []);
});

test("a real document's header and footer text is summarized from the parsed parts", async () => {
  const parsed = await parseDocx(await buildBlankDocx());
  const bytes = await saveDocx(parsed, [{ kind: "generated", block: { type: "paragraph", runs: [{ text: "x" }] } }] as SaveBlock[], {
    header: { text: "Quarterly report" },
    footer: { text: "Confidential", pageNumber: true },
  } as never);
  const info = summarizeHeaderFooter(await parseDocx(bytes));
  assert.deepEqual(info.header, ["Quarterly report"]);
  assert.match(info.footer.join("\n"), /Confidential/);
  assert.equal(info.differentFirstPage, false);
});

// ── table properties ───────────────────────────────────────────────────────

function tableState(rows = 2, cols = 2) {
  const line = { style: "single", szEighths: 4, color: "auto" };
  const table = tableModelToPmNode({
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ paras: ["c"] }))),
    colWidthsPct: Array.from({ length: cols }, () => 100 / cols),
    widthPct: 100,
    autoFit: "window",
    borders: { top: line, bottom: line, left: line, right: line, insideH: line, insideV: line },
  } as never) as unknown as PmNode;
  const state = stateOf({ type: "doc", content: [p("before"), table as never] });
  let cellPos = -1;
  state.doc.descendants((n, pos) => {
    if (cellPos < 0 && n.type.name === "docTableCell") cellPos = pos;
    return cellPos < 0;
  });
  return state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(cellPos + 2))));
}

test("caretTableInfo finds the table, row and cell around the caret", () => {
  const info = caretTableInfo(tableState())!;
  assert.equal(info.table.type.name, "docTable");
  assert.equal(info.row?.type.name, "docTableRow");
  assert.equal(info.cell?.type.name, "docTableCell");
  assert.equal(caretTableInfo(stateOf({ type: "doc", content: [p("x")] })), null);
});

test("table borders toggle writes explicit lines on the table and every cell", () => {
  const off = tableBordersTransaction(tableState(), false)!;
  const t = off.doc.child(1);
  assert.equal(tableIsBordered(t), false);
  assert.equal(t.child(0).child(0).attrs.borders.top.style, "none");
  const back = tableBordersTransaction(tableState().apply(off), true)!;
  assert.equal(tableIsBordered(back.doc.child(1)), true);
  assert.equal(back.doc.child(1).child(1).child(1).attrs.borders.left.style, "single");
});

test("table alignment and repeat-header patch the table and the caret row", () => {
  const s = tableState();
  const aligned = tableAttrsTransaction(s, { tblAlign: "center" })!;
  assert.equal(aligned.doc.child(1).attrs.tblAlign, "center");
  assert.equal(tableAttrsTransaction(s.apply(aligned), { tblAlign: "center" }), null);
  const hdr = repeatHeaderTransaction(s, true)!;
  const row = hdr.doc.child(1).child(0);
  assert.equal(row.attrs.repeatHeader, true);
  assert.equal(row.attrs.repeatHeaderEdited, true);
  assert.equal(hdr.doc.child(1).child(1).attrs.repeatHeader, false);
  assert.equal(repeatHeaderTransaction(s.apply(hdr), true), null);
});

test("table property edits persist through save and reload", async () => {
  const reloaded = await roundTrip((pm) => {
    const s = tableState();
    const end = [...(pm.content ?? [])];
    let state = EditorState.create({ schema, doc: schema.nodeFromJSON({ type: "doc", content: [...end, s.doc.child(1).toJSON()] }) });
    let cellPos = -1;
    state.doc.descendants((n, pos) => {
      if (cellPos < 0 && n.type.name === "docTableCell") cellPos = pos;
      return cellPos < 0;
    });
    state = state.apply(state.tr.setSelection(TextSelection.near(state.doc.resolve(cellPos + 2))));
    const fill = { state } as { state: EditorState };
    setCellAttr("fill", "FFCC00")(fill.state, (tr) => (fill.state = fill.state.apply(tr)));
    setCellAttr("vAlign", "center")(fill.state, (tr) => (fill.state = fill.state.apply(tr)));
    fill.state = fill.state.apply(tableAttrsTransaction(fill.state, { tblAlign: "center" })!);
    fill.state = fill.state.apply(repeatHeaderTransaction(fill.state, true)!);
    return fill.state.doc.toJSON() as PmNode;
  });
  const table = (reloaded.blocks as { type: string; table?: Record<string, unknown> }[]).find((b) => b.type === "table")!;
  const model = table.table as {
    align?: string;
    repeatHeaderRows?: (boolean | null)[];
    rows: { fill?: string; vAlign?: string }[][];
  };
  assert.equal(model.align, "center");
  assert.equal(model.repeatHeaderRows?.[0], true);
  assert.equal(model.rows[0]![0]!.fill, "FFCC00");
  assert.equal(model.rows[0]![0]!.vAlign, "center");
});
