import test from "node:test";
import assert from "node:assert/strict";

import {
  draftMeasureFont,
  widthCalibration,
} from "../src/components/editor/documents/pdf-reflow-metrics";
import type { DraftStyle } from "../src/components/editor/documents/pdf-draft-style";

const base: DraftStyle = {
  fontSize: 12,
  color: null,
  font: null,
  bold: false,
  italic: false,
};

test("draftMeasureFont maps curated ids, installed families, and keep-original", () => {
  const arial = draftMeasureFont({ ...base, font: "arial", bold: true }, "UI Sans");
  assert.equal(arial.cssFamily, "Arial, 'Helvetica Neue', sans-serif");
  assert.equal(arial.cssStyle, "bold");
  assert.equal(arial.exact, true);

  const family = draftMeasureFont({ ...base, font: "Avenir Next" }, "UI Sans");
  assert.equal(family.cssFamily, '"Avenir Next", sans-serif');
  assert.equal(family.cssStyle, "");
  assert.equal(family.exact, true);

  const keep = draftMeasureFont(
    { ...base, bold: true, italic: true },
    "UI Sans",
  );
  assert.equal(keep.cssFamily, "UI Sans");
  assert.equal(keep.cssStyle, "italic bold");
  assert.equal(keep.exact, false);
});

test("widthCalibration maps measured widths onto true PDF widths", () => {
  // True PDF widths are 0.8x what the measuring font reports.
  const measure = (text: string, fontSizePt: number) =>
    (text.length * fontSizePt * 0.5) / 0.8;
  const lines = [
    { text: "hello", widthPt: 25, fontSize: 10 },
    { text: "world line", widthPt: 50, fontSize: 10 },
  ];
  assert.ok(Math.abs(widthCalibration(lines, measure) - 0.8) < 1e-9);
});

test("widthCalibration ignores blank and zero-width lines", () => {
  const measure = () => 10;
  const lines = [
    { text: "   ", widthPt: 100, fontSize: 10 },
    { text: "", widthPt: 100, fontSize: 10 },
    { text: "gone", widthPt: 0, fontSize: 10 },
    { text: "ok", widthPt: 20, fontSize: 10 },
  ];
  assert.equal(widthCalibration(lines, measure), 2);
});

test("widthCalibration returns 1 for empty input and clamps to [0.5, 2]", () => {
  assert.equal(widthCalibration([], () => 5), 1);
  assert.equal(
    widthCalibration([{ text: "a", widthPt: 0, fontSize: 10 }], () => 5),
    1,
  );
  // Extreme under-measure clamps at 0.5; extreme over-measure at 2.
  assert.equal(
    widthCalibration([{ text: "a", widthPt: 1, fontSize: 10 }], () => 10),
    0.5,
  );
  assert.equal(
    widthCalibration([{ text: "a", widthPt: 100, fontSize: 10 }], () => 10),
    2,
  );
});
