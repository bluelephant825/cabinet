import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatNotebookJson,
  NOTEBOOK_HTML_SANDBOX,
  NotebookOutputView,
  notebookMimeText,
} from "./notebook-output";

test("notebook HTML outputs use a script-free sandbox", () => {
  const rendered = renderToStaticMarkup(createElement(NotebookOutputView, {
    output: {
      output_type: "display_data",
      data: { "text/html": "<script>window.top.pwned = true</script>" },
    },
  }));

  assert.equal(NOTEBOOK_HTML_SANDBOX, "");
  assert.match(rendered, /sandbox=""/);
  assert.doesNotMatch(rendered, /allow-scripts/);
});

test("structured JSON MIME values are formatted without string coercion", () => {
  assert.equal(
    formatNotebookJson({ safe: "<script>alert(1)</script>", nested: [true, 3] }),
    '{\n  "safe": "<script>alert(1)</script>",\n  "nested": [\n    true,\n    3\n  ]\n}',
  );
  assert.equal(formatNotebookJson(["first", "second"]), '[\n  "first",\n  "second"\n]');
  assert.equal(formatNotebookJson('{"parsed":true}'), '{\n  "parsed": true\n}');
  assert.equal(formatNotebookJson("not JSON"), "not JSON");

  const rendered = renderToStaticMarkup(createElement(NotebookOutputView, {
    output: {
      output_type: "display_data",
      data: { "application/ld+json": { safe: "<script>alert(1)</script>" } },
    },
  }));
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(rendered, /<script>/);
});

test("text MIME values only join strings and string chunks", () => {
  assert.equal(notebookMimeText(["one\n", "two"]), "one\ntwo");
  assert.equal(notebookMimeText({ unexpected: true }), "");
});
