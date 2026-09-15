import test from "node:test";
import assert from "node:assert/strict";

import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { CellSelection, isInTable, mergeCells, splitCell } from "@tiptap/pm/tables";

import { editorExtensions } from "../src/vendor/genoffice/apps/docs/src/renderer/editor/extensions";
import {
  findNumIdOfKindInDoc,
  linkHrefAllowed,
  makePendingNumberingDef,
  nextNumId,
} from "../src/components/editor/documents/docx-toolbar-commands";

const schema = getSchema(editorExtensions);

function docWith(...content: Record<string, unknown>[]) {
  return schema.nodeFromJSON({ type: "doc", content });
}

const para = (text: string) => ({
  type: "docParagraph",
  content: text ? [{ type: "text", text }] : [],
});

test("nextNumId skips existing, pending and floor", () => {
  assert.equal(nextNumId([], [], 0), "3");
  assert.equal(nextNumId(["3", "9"], [], 0), "10");
  assert.equal(nextNumId(["3"], ["10", "4"], 0), "11");
  assert.equal(nextNumId(["3"], [], 20), "21");
  assert.equal(nextNumId(["abc"], [], 0), "3");
});

test("findNumIdOfKindInDoc returns the first same-kind item's numId", () => {
  const doc = docWith(
    para("intro"),
    { type: "docListItem", attrs: { kind: "ordered", numId: "7", ilvl: 0 }, content: [{ type: "text", text: "one" }] },
    { type: "docListItem", attrs: { kind: "bullet", numId: "4", ilvl: 0 }, content: [{ type: "text", text: "a" }] },
    { type: "docListItem", attrs: { kind: "bullet", numId: "5", ilvl: 0 }, content: [{ type: "text", text: "b" }] },
  );
  assert.equal(findNumIdOfKindInDoc(doc, "bullet"), "4");
  assert.equal(findNumIdOfKindInDoc(doc, "ordered"), "7");
  assert.equal(
    findNumIdOfKindInDoc(docWith(para("plain")), "bullet"),
    null,
  );
});

test("findNumIdOfKindInDoc skips items of the other kind and numId-less items", () => {
  const doc = docWith(
    { type: "docListItem", attrs: { kind: "ordered", numId: "2", ilvl: 0 }, content: [{ type: "text", text: "x" }] },
    { type: "docListItem", attrs: { kind: "bullet", numId: null, ilvl: 0 }, content: [{ type: "text", text: "y" }] },
  );
  assert.equal(findNumIdOfKindInDoc(doc, "bullet"), null);
});

test("linkHrefAllowed accepts http/https/mailto only", () => {
  assert.ok(linkHrefAllowed("https://example.com/x"));
  assert.ok(linkHrefAllowed("http://example.com"));
  assert.ok(linkHrefAllowed("mailto:a@b.c"));
  assert.ok(linkHrefAllowed("  HTTPS://EXAMPLE.COM "));
  assert.ok(!linkHrefAllowed("javascript:alert(1)"));
  assert.ok(!linkHrefAllowed("ftp://x"));
  assert.ok(!linkHrefAllowed("file:///etc/passwd"));
  assert.ok(!linkHrefAllowed(""));
  assert.ok(!linkHrefAllowed("not a url"));
});

test("makePendingNumberingDef emits five blank-template levels", () => {
  const def = makePendingNumberingDef("9", "ordered");
  assert.equal(def.numId, "9");
  assert.equal(def.abstractNumId, "pending-9");
  assert.equal(Object.keys(def.levels).length, 5);
  assert.equal(def.levels[0]!.numFmt, "decimal");
  assert.equal(def.levels[0]!.lvlText, "%1.");
  assert.equal(def.levels[4]!.indentLeft, 3600);
  const bullet = makePendingNumberingDef("3", "bullet");
  assert.equal(bullet.levels[0]!.numFmt, "bullet");
});

// ── table commands against a bare EditorState (no view/DOM needed) ─────────

function tableDoc() {
  return schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "docTable",
        content: [
          {
            type: "docTableRow",
            content: [
              { type: "docTableCell", content: [para("a1")] },
              { type: "docTableCell", content: [para("b1")] },
            ],
          },
          {
            type: "docTableRow",
            content: [
              { type: "docTableCell", content: [para("a2")] },
              { type: "docTableCell", content: [para("b2")] },
            ],
          },
        ],
      },
      para("after"),
    ],
  });
}

test("isInTable / mergeCells / splitCell behave per selection", () => {
  const doc = tableDoc();
  // Caret inside first cell → in-table, single cell can not merge.
  const inCell = EditorState.create({
    schema,
    doc,
    selection: TextSelection.create(doc, 4),
  });
  assert.ok(isInTable(inCell));
  assert.equal(mergeCells(inCell), false);
  assert.equal(splitCell(inCell), false);

  // Cell selection spanning both cells of row 1 → merge allowed. Anchors are
  // the positions just before each cell node.
  const cellPositions: number[] = [];
  doc.nodesBetween(0, doc.content.size, (node, pos) => {
    if (node.type.name === "docTableCell") cellPositions.push(pos);
  });
  const rectSel = EditorState.create({
    schema,
    doc,
    selection: CellSelection.create(doc, cellPositions[0]!, cellPositions[1]!),
  });
  assert.ok(mergeCells(rectSel));
});

test("splitCell allowed only on a colSpan cell", () => {
  const doc = schema.nodeFromJSON({
    type: "doc",
    content: [
      {
        type: "docTable",
        content: [
          {
            type: "docTableRow",
            content: [
              { type: "docTableCell", attrs: { colspan: 2 }, content: [para("wide")] },
            ],
          },
        ],
      },
      para("after"),
    ],
  });
  const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 3) });
  assert.equal(splitCell(state), true);
});
