import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { getSchema } from "@tiptap/core";

import {
  buildBlankDocx,
  parseDocx,
  saveDocx,
  type SaveBlock,
} from "../src/vendor/genoffice/packages/docx-engine/src/index";
import { editorExtensions } from "../src/vendor/genoffice/apps/docs/src/renderer/editor/extensions";
import {
  buildThreads,
  commentAnchors,
  initialsOf,
  withReply,
  withResolved,
  type DocxComment,
} from "../src/components/editor/documents/docx-comments";
import type { DocxDocumentModel } from "../src/lib/documents/types";
import { runOp } from "../server/documents/worker-ops";

const schema = getSchema(editorExtensions);
const text = (t: string, ids?: string) => ({
  type: "text",
  text: t,
  ...(ids ? { marks: [{ type: "comment", attrs: { ids } }] } : {}),
});
const p = (...content: Record<string, unknown>[]) => ({ type: "docParagraph", content });
const docOf = (...blocks: Record<string, unknown>[]) =>
  schema.nodeFromJSON({ type: "doc", content: blocks });

const c = (id: string, extra: Partial<DocxComment> = {}): DocxComment => ({
  id,
  author: "Ada Lovelace",
  text: `comment ${id}`,
  ...extra,
});

test("commentAnchors collects each id's range across runs and shared marks", () => {
  const doc = docOf(p(text("a "), text("one", "1"), text(" two ", "1 2"), text("z")), p(text("later", "3")));
  const anchors = commentAnchors(doc);
  assert.equal(anchors.get("1")!.text, "one two ");
  assert.equal(anchors.get("2")!.text, " two ");
  assert.equal(anchors.get("3")!.text, "later");
  assert.ok(anchors.get("1")!.from < anchors.get("3")!.from);
  assert.equal(doc.textBetween(anchors.get("1")!.from, anchors.get("1")!.to), "one two ");
});

test("buildThreads orders roots by document position, nests replies, keeps orphans", () => {
  const doc = docOf(p(text("x", "2")), p(text("y", "1")));
  const comments = [
    c("1"),
    c("2"),
    c("3", { parentId: "1" }),
    c("4", { parentId: "2" }),
    c("5", { parentId: "99" }), // parent missing → its own thread
    c("6"), // no anchor
  ];
  const threads = buildThreads(comments, commentAnchors(doc));
  assert.deepEqual(
    threads.map((t) => t.root.id),
    ["2", "1", "5", "6"],
    "anchored roots in document order, unanchored after",
  );
  assert.deepEqual(threads.find((t) => t.root.id === "1")!.replies.map((r) => r.id), ["3"]);
  assert.deepEqual(threads.find((t) => t.root.id === "2")!.replies.map((r) => r.id), ["4"]);
  assert.equal(threads.find((t) => t.root.id === "6")!.anchor, null);
});

test("withReply appends a reply to the thread root with a fresh id; rejects empty/unknown", () => {
  const list = [c("1"), c("4", { parentId: "1" })];
  const now = new Date("2026-09-29T10:00:00Z");
  const out = withReply(list, "1", "  thanks!  ", "Grace Hopper", now)!;
  assert.equal(out.id, "5");
  const added = out.comments[out.comments.length - 1]!;
  assert.deepEqual(added, {
    id: "5",
    author: "Grace Hopper",
    initials: "GH",
    date: now.toISOString(),
    text: "thanks!",
    parentId: "1",
  });
  assert.equal(list.length, 2, "input list is not mutated");
  assert.equal(withReply(list, "1", "   ", "x"), null);
  assert.equal(withReply(list, "nope", "hi", "x"), null);
});

test("withResolved flips the flag on the root only", () => {
  const list = [c("1"), c("2", { parentId: "1" })];
  const done = withResolved(list, "1", true);
  assert.equal(done[0]!.done, true);
  assert.equal(done[1]!.done, undefined);
  assert.equal(withResolved(done, "1", false)[0]!.done, false);
});

test("initialsOf handles single names, extra spaces and empty input", () => {
  assert.equal(initialsOf("ada"), "A");
  assert.equal(initialsOf("  Ada   Byron  Lovelace "), "AB");
  assert.equal(initialsOf(""), "?");
});

// ── worker round trip: load exposes comments; a comments save is written back ──

const dir = path.join(os.tmpdir(), `documents-docx-comments-${process.pid}`);
mkdirSync(dir, { recursive: true });

async function commentedDocx(): Promise<string> {
  const doc = await parseDocx(await buildBlankDocx());
  const blocks: SaveBlock[] = [
    {
      kind: "generated",
      block: {
        type: "paragraph",
        runs: [{ text: "Plain " }, { text: "anchored", commentIds: ["1"] }, { text: " tail" }],
      },
    },
  ];
  const bytes = await saveDocx(doc, blocks, {
    comments: [{ id: "1", author: "Ada Lovelace", text: "First note", date: "2026-09-01T09:00:00Z" }],
  });
  const file = path.join(dir, "commented.docx");
  writeFileSync(file, bytes);
  return file;
}

test("docxLoad returns the document's comments", async () => {
  const inputPath = await commentedDocx();
  const model = (await runOp("docxLoad", { inputPath })) as DocxDocumentModel;
  assert.equal(model.comments?.length, 1);
  assert.equal(model.comments![0]!.author, "Ada Lovelace");
  assert.equal(model.comments![0]!.text, "First note");
});

test("a save carrying the comment list persists a reply and a resolved flag", async () => {
  const inputPath = await commentedDocx();
  const model = (await runOp("docxLoad", { inputPath })) as DocxDocumentModel;
  const withR = withReply(model.comments!, "1", "Agreed", "Grace Hopper")!;
  const comments = withResolved(withR.comments, "1", true);
  const outputPath = path.join(dir, "commented-out.docx");
  await runOp("docxSave", {
    inputPath,
    outputPath,
    plan: {
      saveBlocks: (model.blocks as { docxIndex?: number | null }[]).map((b, i) => ({
        kind: "original",
        docxIndex: b.docxIndex ?? i,
      })),
      options: { comments },
    },
  });
  assert.ok(readFileSync(outputPath).length > 0);
  const reloaded = (await runOp("docxLoad", { inputPath: outputPath })) as DocxDocumentModel;
  const list = reloaded.comments!;
  assert.equal(list.length, 2);
  const root = list.find((x) => x.id === "1")!;
  const reply = list.find((x) => x.parentId === root.id)!;
  assert.equal(root.done, true);
  assert.equal(reply.text, "Agreed");
  assert.equal(reply.author, "Grace Hopper");
});
