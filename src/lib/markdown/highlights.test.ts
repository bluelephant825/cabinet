import { test } from "node:test";
import assert from "node:assert/strict";
import { extractHighlights } from "./highlights";

test("keeps the full nemesis annotation, decoding HTML entities", () => {
  const [highlight] = extractHighlights(`<mark data-note="***&#x54;he inescapable agent of someone's or something's downfall.">nemesis</mark>`);
  assert.equal(highlight.text, "nemesis");
  assert.equal(highlight.note, "***The inescapable agent of someone's or something's downfall.");
});

test("handles both attribute delimiters, angle brackets, and encoded quotes", () => {
  const highlights = extractHighlights(`<mark data-note='She said "a > b" &amp; left.'>one</mark>
<mark data-note="It's &quot;quoted&quot; &lt;twice&gt;.">two</mark>`);
  assert.deepEqual(highlights.map((h) => h.note), [
    'She said "a > b" & left.',
    'It\'s "quoted" <twice>.',
  ]);
});

test("retains highlight text, colors, tags, order, and empty filtering", () => {
  const highlights = extractHighlights(`<mark data-color="yellow" data-tags="#one, two one"><b>A &amp; B</b></mark>
<mark color=blue>second</mark>
<mark style="background-color: rgb(1, 2, 3);">third</mark>
<mark data-note="empty"> </mark>`);
  assert.deepEqual(highlights, [
    { id: 0, text: "A & B", color: "yellow", note: null, tags: ["one", "two"] },
    { id: 1, text: "second", color: "blue", note: null, tags: [] },
    { id: 2, text: "third", color: "rgb(1, 2, 3)", note: null, tags: [] },
  ]);
});
