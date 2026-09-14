import test from "node:test";
import assert from "node:assert/strict";

import { emitRuns, escapeMd } from "../server/documents/markdown/inline";

test("escapeMd escapes inline-significant characters", () => {
  assert.equal(escapeMd("a*b_c[d]e`f\\g<h>~i"), "a\\*b\\_c\\[d\\]e\\`f\\\\g\\<h\\>\\~i");
  assert.equal(escapeMd("a|b"), "a|b");
  assert.equal(escapeMd("a|b", { inTable: true }), "a\\|b");
});

test("escapeMd handles line-start constructs only at line start", () => {
  assert.equal(escapeMd("# title", { lineStart: true }), "\\# title");
  assert.equal(escapeMd("a # title"), "a # title");
  assert.equal(escapeMd("> quote", { lineStart: true }), "\\> quote");
  assert.equal(escapeMd("- item", { lineStart: true }), "\\- item");
  assert.equal(escapeMd("+ item", { lineStart: true }), "\\+ item");
  assert.equal(escapeMd("1. item", { lineStart: true }), "1\\. item");
  assert.equal(escapeMd("see 1. item"), "see 1. item");
});

test("emitRuns merges adjacent runs with identical marks", () => {
  assert.equal(
    emitRuns([
      { text: "Hel", bold: true },
      { text: "lo", bold: true },
      { text: " world" },
    ]),
    "**Hello** world",
  );
});

test("emitRuns moves flanking whitespace outside delimiters", () => {
  assert.equal(
    emitRuns([{ text: " bold ", bold: true }]),
    " **bold** ",
  );
  assert.equal(
    emitRuns([{ text: "ital", italic: true }, { text: "ic", italic: true }]),
    "*italic*",
  );
  assert.equal(emitRuns([{ text: "gone", strike: true }]), "~~gone~~");
});

test("emitRuns emits links only for allowed schemes", () => {
  assert.equal(
    emitRuns([{ text: "site", link: { href: "https://example.com" } }]),
    "[site](https://example.com)",
  );
  assert.equal(
    emitRuns([{ text: "mail", link: { href: "mailto:a@b.c" } }]),
    "[mail](mailto:a@b.c)",
  );
  assert.equal(
    emitRuns([{ text: "bad", link: { href: "javascript:alert(1)" } }]),
    "bad",
  );
  assert.equal(
    emitRuns([{ text: "bad", link: { href: "file:///etc/passwd" } }]),
    "bad",
  );
});

test("emitRuns emits footnote refs", () => {
  assert.equal(
    emitRuns([{ text: "note" }, { text: "", noteRef: "3" }]),
    "note[^3]",
  );
});
