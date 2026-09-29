import test from "node:test";
import assert from "node:assert/strict";

import type { Editor } from "@tiptap/core";
import { getSchema } from "@tiptap/core";
import { EditorState } from "@tiptap/pm/state";

import { editorExtensions } from "../src/vendor/genoffice/apps/docs/src/renderer/editor/extensions";
import {
  acceptAllRevisions,
  applyRevisions,
  rejectAllRevisions,
} from "../src/vendor/genoffice/apps/docs/src/renderer/editor/revisions";
import { listRevisions, selectRevision } from "../src/components/editor/documents/docx-revisions";

const schema = getSchema(editorExtensions);
const rev = (type: "ins" | "del", author = "Ada", date = "2026-09-01T09:00:00Z") => ({
  type,
  attrs: { author, date },
});
const text = (t: string, ...marks: ReturnType<typeof rev>[]) => ({
  type: "text",
  text: t,
  ...(marks.length ? { marks } : {}),
});
const p = (...content: Record<string, unknown>[]) => ({ type: "docParagraph", content });
const docOf = (...blocks: Record<string, unknown>[]) =>
  schema.nodeFromJSON({ type: "doc", content: blocks });

/** applyRevisions only needs `state` and `view.dispatch` — a bare EditorState is enough. */
function fakeEditor(doc: ReturnType<typeof docOf>) {
  let state = EditorState.create({ schema, doc });
  const editor = {
    get state() {
      return state;
    },
    view: {
      dispatch(tr: Parameters<EditorState["apply"]>[0]) {
        state = state.apply(tr);
      },
    },
  };
  return { editor: editor as unknown as Editor, text: () => state.doc.textContent, state: () => state };
}

const sample = () =>
  docOf(p(text("Keep "), text("added", rev("ins")), text(" removed", rev("del", "Grace")), text(" end")));

test("listRevisions groups insertions and deletions with author, date and text", () => {
  const items = listRevisions(sample());
  assert.deepEqual(
    items.map((i) => [i.group, i.range.author, i.text]),
    [
      ["insert", "Ada", "added"],
      ["delete", "Grace", " removed"],
    ],
  );
  assert.equal(items[0]!.range.date, "2026-09-01T09:00:00Z");
});

test("listRevisions is empty for a clean document and truncates long text", () => {
  assert.deepEqual(listRevisions(docOf(p(text("clean")))), []);
  const long = "x".repeat(300);
  const [item] = listRevisions(docOf(p(text(long, rev("ins")))));
  assert.equal(item!.text.length, 121);
  assert.ok(item!.text.endsWith("…"));
});

test("accepting one revision keeps insertions and drops deletions; the other stays pending", () => {
  const f = fakeEditor(sample());
  const [ins] = listRevisions(f.state().doc);
  applyRevisions(f.editor, [ins!.range], "accept");
  assert.equal(listRevisions(f.state().doc).length, 1, "deletion still pending");
  assert.equal(f.text(), "Keep added removed end", "deleted text is still shown as struck");
  acceptAllRevisions(f.editor);
  assert.equal(f.text(), "Keep added end");
  assert.equal(listRevisions(f.state().doc).length, 0);
});

test("rejecting drops insertions and restores deletions", () => {
  const f = fakeEditor(sample());
  rejectAllRevisions(f.editor);
  assert.equal(f.text(), "Keep  removed end");
  assert.equal(listRevisions(f.state().doc).length, 0);
});

test("selectRevision selects the range without recording a revision", () => {
  const f = fakeEditor(sample());
  const [ins] = listRevisions(f.state().doc);
  const tr = selectRevision(f.state(), ins!.range);
  const next = f.state().apply(tr);
  assert.equal(next.doc.textBetween(next.selection.from, next.selection.to), "added");
  assert.equal(tr.getMeta("trackIgnore"), true);
});
