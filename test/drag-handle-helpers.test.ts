import test from "node:test";
import assert from "node:assert/strict";
import { Schema } from "@tiptap/pm/model";
import {
  canInsertNodeAt,
  gutterProbeXs,
  markerOffsetForNodeType,
} from "@/components/editor/extensions/drag-handle";

test("gutterProbeXs scans from either gutter through nested-list indentation", () => {
  const bounds = { left: 100, right: 300 };

  assert.deepEqual(gutterProbeXs(bounds, 40), [120, 152, 184, 216, 248, 280]);
  assert.deepEqual(gutterProbeXs(bounds, 360), [280, 120, 152, 184, 216, 248]);
});

test("gutterProbeXs keeps the exact in-content probe first", () => {
  const probes = gutterProbeXs({ left: 100, right: 300 }, 233);

  assert.equal(probes[0], 233);
  assert.ok(probes.includes(120));
  assert.ok(probes.includes(280));
});

test("gutterProbeXs handles an editor narrower than its insets", () => {
  assert.deepEqual(gutterProbeXs({ left: 100, right: 120 }, 0), [110]);
});

test("marker offset distinguishes outside list markers from task checkboxes", () => {
  assert.equal(markerOffsetForNodeType("listItem"), 18);
  assert.equal(markerOffsetForNodeType("taskItem"), 0);
  assert.equal(markerOffsetForNodeType("paragraph"), 0);
});

test("canInsertNodeAt validates the boundary and complete candidate content", () => {
  const schema = new Schema({
    nodes: {
      doc: { content: "list" },
      list: { content: "item+" },
      item: { content: "paragraph" },
      paragraph: { content: "text*" },
      text: { inline: true },
    },
  });
  const item = schema.nodes.item.createAndFill()!;
  const list = schema.nodes.list.create(null, item);
  const doc = schema.nodes.doc.create(null, list);
  const afterItem = 1 + item.nodeSize;
  const validItem = schema.nodes.item.createAndFill()!;
  const invalidItem = schema.nodes.item.create(null, schema.text("not a paragraph"));

  assert.equal(canInsertNodeAt(doc, afterItem, item, validItem), true);
  assert.equal(canInsertNodeAt(doc, afterItem, item, invalidItem), false);
  assert.equal(canInsertNodeAt(doc, afterItem, validItem, validItem), false);
  assert.equal(
    canInsertNodeAt(doc, afterItem, item, schema.nodes.paragraph.create()),
    false
  );
});
