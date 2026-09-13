/**
 * Composer-store tests: catalog-checked edits through the store, undo/redo
 * exactness, drop validity (siblings, containers, leaves, descendants,
 * header/footer region rules), and dirtyGeneration semantics.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  computeDropValidity,
  locateIn,
  usePdfComposerStore,
} from "../src/lib/documents/pdf-composer-store";
import { newComposition, type PdfComposition } from "../src/lib/documents/pdf-composition";
import { PDFCN_CATALOG_VERSION } from "../src/lib/documents/pdf-component-catalog";

function tree(): PdfComposition {
  return {
    ...newComposition(),
    documentId: "doc-test",
    catalogVersion: PDFCN_CATALOG_VERSION,
    header: [{ type: "text", id: "h1", props: { text: "hdr" } }],
    body: [
      { type: "heading", id: "hd1", props: { level: 1, text: "Title" } },
      {
        type: "section",
        id: "s1",
        children: [
          { type: "text", id: "t1", props: { text: "inside" } },
          { type: "page-break", id: "pb1" },
        ],
      },
      { type: "text", id: "t2", props: { text: "tail" } },
    ],
  };
}

function load(composition: PdfComposition = tree()) {
  usePdfComposerStore.getState().load("test.pdf.source.json", composition, "rev-1");
  return usePdfComposerStore.getState();
}

test("insertPalette appends to body when nothing is selected", () => {
  const s = load();
  const err = s.insertPalette("heading");
  assert.equal(err, null);
  const c = usePdfComposerStore.getState().composition!;
  assert.equal(c.body.length, 4);
  assert.equal(c.body[3].type, "heading");
  assert.equal(c.body[3].props?.level, 1); // catalog default applied
  assert.equal(usePdfComposerStore.getState().selectedId, c.body[3].id);
});

test("insertPalette goes into a selected container that accepts the type", () => {
  const s = load();
  s.select("s1");
  const err = usePdfComposerStore.getState().insertPalette("text");
  assert.equal(err, null);
  const c = usePdfComposerStore.getState().composition!;
  const section = c.body[1];
  assert.equal(section.children!.length, 3);
  assert.equal(section.children![2].type, "text");
});

test("insertPalette inserts after the selected leaf", () => {
  const s = load();
  s.select("t1");
  usePdfComposerStore.getState().insertPalette("divider");
  const c = usePdfComposerStore.getState().composition!;
  const section = c.body[1];
  assert.equal(section.children![1].type, "divider");
  assert.equal(section.children![2].id, "pb1");
});

test("remove, duplicate (re-ids subtree), and update keep validity", () => {
  const s = load();
  assert.equal(s.remove("pb1"), null);
  let c = usePdfComposerStore.getState().composition!;
  assert.equal(c.body[1].children!.length, 1);

  assert.equal(usePdfComposerStore.getState().duplicate("s1"), null);
  c = usePdfComposerStore.getState().composition!;
  assert.equal(c.body.length, 4);
  const dup = c.body[2];
  assert.equal(dup.type, "section");
  assert.notEqual(dup.id, "s1");
  assert.notEqual(dup.children![0].id, "t1");

  assert.equal(usePdfComposerStore.getState().updateProps("hd1", { text: "Renamed" }), null);
  c = usePdfComposerStore.getState().composition!;
  assert.equal(c.body[0].props?.text, "Renamed");
});

test("undo/redo restores exact trees", () => {
  load();
  const original = structuredClone(usePdfComposerStore.getState().composition!);
  usePdfComposerStore.getState().insertPalette("badge");
  usePdfComposerStore.getState().remove("hd1");
  assert.equal(usePdfComposerStore.getState().composition!.body.length, 3);
  usePdfComposerStore.getState().undo();
  usePdfComposerStore.getState().undo();
  assert.deepEqual(usePdfComposerStore.getState().composition, original);
  usePdfComposerStore.getState().redo();
  assert.equal(usePdfComposerStore.getState().composition!.body.length, 4);
  usePdfComposerStore.getState().redo();
  const final = usePdfComposerStore.getState().composition!;
  assert.equal(final.body.length, 3);
  assert.equal(final.body.some((n) => n.id === "hd1"), false);
  assert.equal(final.body.some((n) => n.type === "badge"), true);
});

test("prop edits with the same merge key batch into one undo step", () => {
  load();
  usePdfComposerStore.getState().updateProps("hd1", { text: "a" });
  usePdfComposerStore.getState().updateProps("hd1", { text: "ab" });
  usePdfComposerStore.getState().updateProps("hd1", { text: "abc" });
  assert.equal(usePdfComposerStore.getState().undoStack.length, 1);
  usePdfComposerStore.getState().undo();
  assert.equal(usePdfComposerStore.getState().composition!.body[0].props?.text, "Title");
});

test("invalid edit is rejected and the previous tree kept", () => {
  const s = load();
  const before = usePdfComposerStore.getState().composition!;
  // A text prop exceeding limits would fail validation; simulate via a
  // catalog-invalid prop type through commit.
  const bad = structuredClone(before);
  (bad.body[0].props as Record<string, unknown>).level = 99; // enum violation
  const err = s.commit(bad);
  assert.ok(err);
  assert.equal(usePdfComposerStore.getState().composition, before);
  assert.equal(usePdfComposerStore.getState().dirty, false);
});

test("move + moveOut + moveIntoPrev", () => {
  load();
  // Move t2 into s1 at index 0.
  assert.equal(
    usePdfComposerStore.getState().move("t2", { parentId: "s1", region: "body" }, 0),
    null,
  );
  let c = usePdfComposerStore.getState().composition!;
  assert.equal(c.body[1].children![0].id, "t2");
  assert.equal(c.body.length, 2);

  // Out of parent → lands after s1 in the body.
  assert.equal(usePdfComposerStore.getState().moveOut("t2"), null);
  c = usePdfComposerStore.getState().composition!;
  assert.equal(c.body[2].id, "t2");

  // Into previous sibling: pb1 → previous sibling of t1 is nothing at index0;
  // move t2 back in via prev sibling (s1 is a container).
  assert.equal(usePdfComposerStore.getState().moveIntoPrev("t2"), null);
  c = usePdfComposerStore.getState().composition!;
  assert.equal(c.body[1].children!.some((n) => n.id === "t2"), true);
});

test("moveBy reorders within the parent list", () => {
  load();
  assert.equal(usePdfComposerStore.getState().moveBy("t2", -1), null);
  const c = usePdfComposerStore.getState().composition!;
  assert.equal(c.body[1].id, "t2");
  assert.equal(c.body[2].id, "s1");
});

test("computeDropValidity: between siblings and into containers", () => {
  const c = tree();
  assert.deepEqual(
    computeDropValidity(c, { kind: "palette", type: "heading" }, { parentId: null, region: "body" }),
    { ok: true },
  );
  assert.deepEqual(
    computeDropValidity(c, { kind: "node", id: "t2" }, { parentId: "s1", region: "body" }),
    { ok: true },
  );
});

test("computeDropValidity: leaf and descendant targets are invalid", () => {
  const c = tree();
  // Into a leaf (page-break allows no children / heading can't parent).
  const leaf = computeDropValidity(
    c,
    { kind: "palette", type: "heading" },
    { parentId: "pb1", region: "body" },
  );
  assert.equal(leaf.ok, false);
  // Into own descendant.
  const own = computeDropValidity(
    c,
    { kind: "node", id: "s1" },
    { parentId: "t1", region: "body" },
  );
  assert.equal(own.ok, false);
  const self = computeDropValidity(
    c,
    { kind: "node", id: "s1" },
    { parentId: "s1", region: "body" },
  );
  assert.equal(self.ok, false);
});

test("computeDropValidity: header region rejects body-only types", () => {
  const c = tree();
  const bad = computeDropValidity(
    c,
    { kind: "palette", type: "watermark" },
    { parentId: null, region: "header" },
  );
  assert.equal(bad.ok, false);
  const good = computeDropValidity(
    c,
    { kind: "palette", type: "text" },
    { parentId: null, region: "header" },
  );
  assert.equal(good.ok, true);
});

test("store.move rejects a catalog-forbidden target and leaves the tree unchanged", () => {
  const s = load();
  const before = usePdfComposerStore.getState().composition!;
  const err = s.move("hd1", { parentId: "pb1", region: "body" }, 0);
  assert.ok(err);
  assert.equal(usePdfComposerStore.getState().composition, before);
});

test("dirtyGeneration increments per mutation and markSaved clears dirty", () => {
  load();
  const g0 = usePdfComposerStore.getState().dirtyGeneration;
  usePdfComposerStore.getState().insertPalette("divider");
  assert.equal(usePdfComposerStore.getState().dirtyGeneration, g0 + 1);
  assert.equal(usePdfComposerStore.getState().dirty, true);
  usePdfComposerStore.getState().markSaved("rev-2");
  assert.equal(usePdfComposerStore.getState().dirty, false);
  assert.equal(usePdfComposerStore.getState().sourceRevision, "rev-2");
});

test("setDoc updates document-level props and validates", () => {
  const s = load();
  const err = s.setDoc({ theme: "elegant" });
  assert.equal(err, null);
  assert.equal(usePdfComposerStore.getState().composition!.theme, "elegant");
  const bad = usePdfComposerStore.getState().setDoc({ theme: "nope" });
  assert.ok(bad);
  assert.equal(usePdfComposerStore.getState().composition!.theme, "elegant");
});

test("locateIn reports region and parent", () => {
  const c = tree();
  assert.deepEqual(locateIn(c, "h1"), {
    parentId: null,
    region: "header",
    index: 0,
    node: c.header![0],
  });
  assert.equal(locateIn(c, "t1")?.parentId, "s1");
  assert.equal(locateIn(c, "t1")?.region, "body");
});
