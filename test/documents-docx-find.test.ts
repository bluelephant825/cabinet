import test from "node:test";
import assert from "node:assert/strict";

import { getSchema } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";

import { editorExtensions } from "../src/vendor/genoffice/apps/docs/src/renderer/editor/extensions";
import {
  currentMatchIndex,
  findMatches,
  replaceTransaction,
  selectMatch,
  stepMatch,
} from "../src/components/editor/documents/docx-find";

const schema = getSchema(editorExtensions);
const opts = { matchCase: false, wholeWord: false };

const text = (t: string, marks?: { type: string; attrs?: Record<string, unknown> }[]) => ({
  type: "text",
  text: t,
  ...(marks ? { marks } : {}),
});
const p = (...content: Record<string, unknown>[]) => ({ type: "docParagraph", content });
const docOf = (...blocks: Record<string, unknown>[]) =>
  schema.nodeFromJSON({ type: "doc", content: blocks });
const slice = (doc: ReturnType<typeof docOf>, m: { from: number; to: number }) =>
  doc.textBetween(m.from, m.to);

test("findMatches: case, whole word and empty query", () => {
  const doc = docOf(p(text("Cat concat cat")));
  assert.equal(findMatches(doc, "", opts).length, 0);
  assert.equal(findMatches(doc, "cat", opts).length, 3);
  assert.equal(findMatches(doc, "cat", { ...opts, matchCase: true }).length, 2);
  assert.equal(findMatches(doc, "cat", { ...opts, wholeWord: true }).length, 2);
});

test("findMatches: positions map back to the doc, across paragraphs", () => {
  const doc = docOf(p(text("alpha beta")), p(text("beta gamma")));
  const ms = findMatches(doc, "beta", opts);
  assert.equal(ms.length, 2);
  for (const m of ms) assert.equal(slice(doc, m), "beta");
});

test("findMatches: a match may span differently-marked runs", () => {
  const doc = docOf(p(text("foo"), text("bar", [{ type: "bold" }]), text("baz")));
  const ms = findMatches(doc, "obarb", opts);
  assert.equal(ms.length, 1);
  assert.equal(slice(doc, ms[0]!), "obarb");
});

test("findMatches: tracked-deleted runs are invisible and do not join neighbours", () => {
  const doc = docOf(p(text("ab"), text("XX", [{ type: "del" }]), text("cd")));
  assert.equal(findMatches(doc, "abcd", opts).length, 0);
  assert.equal(findMatches(doc, "XX", opts).length, 0);
  assert.equal(findMatches(doc, "cd", opts).length, 1);
});

test("stepMatch wraps in both directions and selectMatch selects the range", () => {
  const doc = docOf(p(text("a a a")));
  const ms = findMatches(doc, "a", opts);
  assert.equal(ms.length, 3);
  assert.equal(stepMatch([], { from: 1, to: 1 }, 1), null);
  assert.deepEqual(stepMatch(ms, { from: 1, to: 1 }, 1), ms[0]);
  assert.deepEqual(stepMatch(ms, ms[0]!, 1), ms[1]);
  assert.deepEqual(stepMatch(ms, ms[2]!, 1), ms[0], "next wraps to the first");
  assert.deepEqual(stepMatch(ms, ms[0]!, -1), ms[2], "previous wraps to the last");
  assert.deepEqual(stepMatch(ms, ms[2]!, -1), ms[1]);

  const state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1) });
  const tr = selectMatch(state, ms[1]!);
  const next = state.apply(tr);
  assert.equal(currentMatchIndex(ms, next.selection), 1);
});

test("replaceTransaction replaces all matches back-to-front and keeps marks", () => {
  const doc = docOf(
    p(text("cat ", [{ type: "bold" }]), text("dog cat")),
    p(text("a cat")),
  );
  const state = EditorState.create({ schema, doc });
  const ms = findMatches(doc, "cat", opts);
  assert.equal(ms.length, 3);
  const tr = replaceTransaction(state, ms, "tiger");
  assert.ok(tr);
  const out = tr!.doc;
  assert.equal(out.child(0).textContent, "tiger dog tiger");
  assert.equal(out.child(1).textContent, "a tiger");
  // The replacement inherits the first replaced character's marks (bold).
  const first = out.child(0).child(0);
  assert.equal(first.text, "tiger ");
  assert.ok(first.marks.some((m) => m.type.name === "bold"));
  assert.ok(!out.child(0).child(out.child(0).childCount - 1).marks.some((m) => m.type.name === "bold"));
});

test("replaceTransaction with an empty replacement deletes; no matches yields null", () => {
  const doc = docOf(p(text("keep drop keep")));
  const state = EditorState.create({ schema, doc });
  const tr = replaceTransaction(state, findMatches(doc, " drop", opts), "");
  assert.equal(tr!.doc.textContent, "keep keep");
  assert.equal(replaceTransaction(state, [], "x"), null);
});
