import { test } from "node:test";
import assert from "node:assert/strict";
import type { Editor } from "@tiptap/react";
import { applyAnnotationEdit } from "@/components/editor/editor-toolbar";
import { markdownToHtml } from "@/lib/markdown/to-html";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";

function annotationEditor(active: boolean) {
  const calls: string[] = [];
  const chain = {
    focus: () => (calls.push("focus"), chain),
    extendMarkRange: (name: string) => (calls.push(`extend:${name}`), chain),
    setMark: (name: string, attrs: Record<string, unknown>) =>
      (calls.push(`set:${name}:${String(attrs.annotation)}`), chain),
    unsetMark: (name: string) => (calls.push(`unset:${name}`), chain),
    run: () => (calls.push("run"), true),
  };
  const editor = {
    chain: () => (calls.push("chain"), chain),
    isActive: (name: string) => name === "annotation" && active,
  } as unknown as Editor;
  return { calls, editor };
}

test("annotation toolbar behavior creates, edits, and removes marks", () => {
  const create = annotationEditor(false);
  assert.equal(applyAnnotationEdit(create.editor, "  New note  "), true);
  assert.deepEqual(create.calls, ["chain", "focus", "set:annotation:New note", "run"]);

  const edit = annotationEditor(true);
  applyAnnotationEdit(edit.editor, "Updated");
  assert.deepEqual(edit.calls, [
    "chain",
    "focus",
    "extend:annotation",
    "set:annotation:Updated",
    "run",
  ]);

  const remove = annotationEditor(true);
  applyAnnotationEdit(remove.editor, "  ");
  assert.deepEqual(remove.calls, [
    "chain",
    "focus",
    "extend:annotation",
    "unset:annotation",
    "run",
  ]);
});

test("htmlToMarkdown preserves only an annotation's escaped payload", () => {
  const markdown = htmlToMarkdown(
    '<p>Ask <span data-annotation="Confirm &quot;owner&quot; &amp; date &lt;today&gt;" data-lucide="alert" data-type="inline-math" data-latex="unsafe" title="editor only" class="annotation" style="color: red" onclick="alert(1)"><strong>Ada</strong></span>.</p>'
  );

  assert.match(
    markdown,
    /<span data-annotation="Confirm &quot;owner&quot; &amp; date &lt;today&gt;">\*\*Ada\*\*<\/span>/
  );
  assert.doesNotMatch(markdown, /data-lucide=|data-type=|data-latex=|title=|class=|style=|onclick=/);
});

test("htmlToMarkdown retains only highlight color attributes", () => {
  const markdown = htmlToMarkdown(
    '<p><mark data-color="#fef08a" data-note="drop me" class="decoration" title="drop me" onclick="alert(1)" style="background-color: #fef08a; color: red; background-image: url(evil)"><em>safe</em></mark></p>'
  );

  assert.match(
    markdown,
    /<mark data-color="#fef08a" style="background-color: #fef08a">\*safe\*<\/mark>/
  );
  assert.doesNotMatch(markdown, /data-note=|class=|title=|onclick=|color: red|background-image/);
});

test("annotations, text colors, and highlights survive repeated markdown round-trips", async () => {
  const source =
    'Review <span data-annotation="Needs a source &amp; owner"><strong>this</strong></span>, ' +
    '<span style="color: #2563eb">blue</span>, and ' +
    '<mark data-color="#fef08a" style="background-color: #fef08a"><em>highlighted</em></mark> text.';

  const firstHtml = await markdownToHtml(source);
  const saved = htmlToMarkdown(firstHtml);
  const secondHtml = await markdownToHtml(saved);
  const savedAgain = htmlToMarkdown(secondHtml);

  assert.match(saved, /<span data-annotation="Needs a source &amp; owner">\*\*this\*\*<\/span>/);
  assert.match(saved, /<span style="color: #2563eb">blue<\/span>/);
  assert.match(saved, /<mark data-color="#fef08a" style="background-color: #fef08a">\*highlighted\*<\/mark>/);
  assert.match(secondHtml, /data-annotation="Needs a source &amp; owner"/);
  assert.match(secondHtml, /style="color: #2563eb"/);
  assert.match(secondHtml, /data-color="#fef08a"/);
  assert.equal(savedAgain, saved);
});
