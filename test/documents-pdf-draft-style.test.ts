import test from "node:test";
import assert from "node:assert/strict";

import {
  blockDraftStyle,
  DEFAULT_INSERT_STYLE,
  defaultInsertFont,
  draftStyleToEditFields,
  hasStyleChanges,
  hexToRgb,
  resolveInsertFont,
  rgbCss,
  rgbToHex,
  scaledLineLeading,
  type DraftStyle,
} from "../src/components/editor/documents/pdf-draft-style";

test("draftStyleToEditFields emits only real changes", () => {
  const base: DraftStyle = { fontSize: 12, color: null, font: null, bold: false, italic: false };
  assert.deepEqual(draftStyleToEditFields(base, 12), {});
  assert.equal(hasStyleChanges(draftStyleToEditFields(base, 12)), false);

  const grown = draftStyleToEditFields({ ...base, fontSize: 18 }, 12);
  assert.deepEqual(grown, { newFontSize: 18 });
  assert.equal(hasStyleChanges(grown), true);

  const full = draftStyleToEditFields(
    { fontSize: 20, color: [255, 0, 0], font: "times", bold: true, italic: true },
    12,
  );
  assert.deepEqual(full, {
    newFontSize: 20,
    newColor: [255, 0, 0],
    newFont: "times",
    newBold: true,
    newItalic: true,
  });
});

test("blockDraftStyle restores an existing edit's new* fields", () => {
  const restored = blockDraftStyle(12, {
    pageIndex: 0,
    rect: [0, 0, 1, 1],
    oldText: "a",
    newText: "a",
    fontSize: 12,
    newFontSize: 22,
    newColor: [9, 9, 9],
    newFont: "courier",
    newBold: true,
  });
  assert.deepEqual(restored, {
    fontSize: 22,
    color: [9, 9, 9],
    font: "courier",
    bold: true,
    italic: false,
  });

  assert.deepEqual(blockDraftStyle(16), {
    fontSize: 16,
    color: null,
    font: null,
    bold: false,
    italic: false,
  });
});

test("scaledLineLeading scales with size and stays put when unchanged", () => {
  assert.equal(scaledLineLeading(18, 12, 12), 18);
  assert.equal(scaledLineLeading(18, 12, 24), 36);
  assert.equal(scaledLineLeading(18, 0, 24), 18);
});

test("resolveInsertFont only forces a face when a style toggle needs one", () => {
  const fonts = ["arial", "times", "courier"];
  // Plain insert: engine fallback face is fine — no explicit font.
  assert.equal(resolveInsertFont({ ...DEFAULT_INSERT_STYLE }, fonts), undefined);
  // Bold/italic inserts would land on a regular fallback face — force one.
  assert.equal(
    resolveInsertFont({ ...DEFAULT_INSERT_STYLE, bold: true }, fonts),
    "arial",
  );
  assert.equal(
    resolveInsertFont({ ...DEFAULT_INSERT_STYLE, italic: true }, ["courier", "times"]),
    "courier",
  );
  assert.equal(
    resolveInsertFont({ ...DEFAULT_INSERT_STYLE, bold: true, font: "times" }, fonts),
    "times",
  );
  assert.equal(resolveInsertFont({ ...DEFAULT_INSERT_STYLE, bold: true }, []), undefined);
});

test("defaultInsertFont prefers arial", () => {
  assert.equal(defaultInsertFont(["times", "arial"]), "arial");
  assert.equal(defaultInsertFont(["courier"]), "courier");
  assert.equal(defaultInsertFont([]), null);
});

test("hex/rgb conversions round-trip", () => {
  assert.deepEqual(hexToRgb("#ff0080"), [255, 0, 128]);
  assert.deepEqual(hexToRgb("ff0000"), [255, 0, 0]);
  assert.equal(rgbToHex([255, 0, 128]), "#ff0080");
  assert.equal(rgbToHex(hexToRgb("#0a1b2c")), "#0a1b2c");
  assert.equal(rgbCss([1, 2, 3]), "rgb(1, 2, 3)");
});
