/**
 * Step-7a composition-model tests: validateComposition's rejection matrix,
 * the pure tree ops, template validity, and the v1 migrate passthrough.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  duplicateNode,
  insertNode,
  migrateComposition,
  moveNode,
  newComposition,
  removeNode,
  updateNode,
  validateComposition,
  type PdfComposition,
  type PdfNode,
} from "../src/lib/documents/pdf-composition";
import { PDFCN_CATALOG_VERSION, PDF_COMPONENTS } from "../src/lib/documents/pdf-component-catalog";

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    documentId: "doc-1",
    catalogVersion: PDFCN_CATALOG_VERSION,
    page: {
      size: "A4",
      orientation: "portrait",
      margins: { top: 56, right: 48, bottom: 56, left: 48 },
    },
    theme: "professional",
    body: [{ type: "text", id: "t1", props: { text: "hi" } }],
    ...overrides,
  };
}

const codes = (r: { ok: boolean; errors?: { code: string }[] }) =>
  (r.errors ?? []).map((e) => e.code);

// ── validation matrix ─────────────────────────────────────────────────────

test("validate: a minimal composition passes", () => {
  const r = validateComposition(base());
  assert.equal(r.ok, true, JSON.stringify(r.ok ? null : r.errors));
});

test("validate: rejects non-object, bad schemaVersion, bad documentId", () => {
  assert.equal(validateComposition("x").ok, false);
  assert.ok(codes(validateComposition(base({ schemaVersion: 2 }))).includes("unsupported"));
  assert.ok(codes(validateComposition(base({ documentId: "Bad Id!" }))).includes("invalid-id"));
});

test("validate: unknown component type", () => {
  const r = validateComposition(
    base({ body: [{ type: "nope", id: "x1" }] }),
  );
  assert.ok(codes(r).includes("unknown-type"));
});

test("validate: bad node id + duplicate id", () => {
  const bad = validateComposition(base({ body: [{ type: "text", id: "BAD!" }] }));
  assert.ok(codes(bad).includes("invalid-id"));
  const dup = validateComposition(
    base({
      body: [
        { type: "text", id: "t1", props: { text: "a" } },
        { type: "text", id: "t1", props: { text: "b" } },
      ],
    }),
  );
  assert.ok(codes(dup).includes("duplicate-id"));
});

test("validate: depth and node-count limits", () => {
  // Depth: wrap a text in 14 sections.
  let node: Record<string, unknown> = { type: "text", id: "leaf", props: { text: "x" } };
  for (let i = 0; i < 14; i++) {
    node = { type: "section", id: `s${i}`, children: [node] };
  }
  const deep = validateComposition(base({ body: [node] }));
  assert.ok(codes(deep).includes("too-deep"));

  // Node count: 2100 texts (under table caps).
  const many = validateComposition(
    base({
      body: Array.from({ length: 2100 }, (_, i) => ({
        type: "text",
        id: `t${i}`,
        props: { text: "x" },
      })),
    }),
  );
  assert.ok(codes(many).includes("too-large"));
});

test("validate: table row/cell caps", () => {
  const rows = validateComposition(
    base({
      body: [
        {
          type: "table",
          id: "tb",
          data: { columns: ["a"], rows: Array.from({ length: 5001 }, () => ["x"]) },
        },
      ],
    }),
  );
  assert.ok(codes(rows).includes("too-large"));
});

test("validate: link schemes", () => {
  const mk = (href: string) =>
    validateComposition(
      base({ body: [{ type: "link", id: "l1", props: { text: "x", href } }] }),
    );
  assert.equal(mk("https://example.com").ok, true);
  assert.equal(mk("mailto:a@b.c").ok, true);
  assert.equal(mk("notes/other-page").ok, true);
  assert.ok(codes(mk("javascript:alert(1)")).includes("bad-link"));
  assert.ok(codes(mk("http://example.com")).includes("bad-link"));
  assert.ok(codes(mk("../../etc/passwd")).includes("bad-link"));
});

test("validate: oversized inline data URL rejected", () => {
  const big = `data:image/png;base64,${"A".repeat(2 * 1024 * 1024 + 16)}`;
  const r = validateComposition(
    base({ body: [{ type: "text", id: "t1", props: { text: big } }] }),
  );
  assert.ok(codes(r).includes("too-large"));
});

test("validate: on* handler props rejected, import strings allowed as text", () => {
  const onProp = validateComposition(
    base({ body: [{ type: "text", id: "t1", props: { text: "x", onClick: "y" } }] }),
  );
  assert.ok(codes(onProp).includes("bad-prop"));
  // Component text is rendered as text, never evaluated — allowed.
  const codeText = validateComposition(
    base({ body: [{ type: "text", id: "t1", props: { text: "call import x" } }] }),
  );
  assert.equal(codeText.ok, true);
});

test("validate: remote asset paths rejected", () => {
  const r = validateComposition(
    base({ assets: { logo: { path: "https://evil.example/x.png" } } }),
  );
  assert.ok(codes(r).includes("bad-asset"));
  const traversal = validateComposition(
    base({ assets: { logo: { path: "../secret.png" } } }),
  );
  assert.ok(codes(traversal).includes("bad-asset"));
});

test("validate: disallowed parent/child combos", () => {
  // Watermark only allowed at body root.
  const inSection = validateComposition(
    base({
      body: [
        {
          type: "section",
          id: "s1",
          children: [{ type: "watermark", id: "w1", props: { text: "x" } }],
        },
      ],
    }),
  );
  assert.ok(codes(inSection).includes("bad-parent"));
  // text cannot contain children.
  const kid = validateComposition(
    base({
      body: [
        {
          type: "text",
          id: "t1",
          props: { text: "x" },
          children: [{ type: "text", id: "t2", props: { text: "y" } }],
        },
      ],
    }),
  );
  assert.ok(codes(kid).includes("bad-parent"));
});

test("validate: unknown prop and missing required prop", () => {
  const unknown = validateComposition(
    base({ body: [{ type: "text", id: "t1", props: { text: "x", bogus: 1 } }] }),
  );
  assert.ok(codes(unknown).includes("bad-prop"));
  const missing = validateComposition(base({ body: [{ type: "text", id: "t1" }] }));
  assert.ok(codes(missing).includes("bad-prop"));
});

// ── templates ─────────────────────────────────────────────────────────────

test("templates: blank, invoice, report all validate", () => {
  const dir = path.join(__dirname, "../src/lib/documents/pdf-templates");
  for (const name of ["blank", "invoice", "report"]) {
    const json = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), "utf8"));
    const r = validateComposition(json);
    assert.equal(r.ok, true, `${name}: ${JSON.stringify(r.ok ? null : r.errors)}`);
  }
});

test("migrate: v1 passthrough returns the input", () => {
  const c = base();
  assert.equal(migrateComposition(c), c);
});

// ── tree ops ──────────────────────────────────────────────────────────────

function tree(): PdfComposition {
  const c = newComposition({ documentId: "doc-1" });
  const t1: PdfNode = { type: "text", id: "t1", props: { text: "one" } };
  const t2: PdfNode = { type: "text", id: "t2", props: { text: "two" } };
  const s1: PdfNode = { type: "section", id: "s1", children: [t2] };
  c.body = [t1, s1];
  return c;
}

test("tree ops: insert at root and into a container", () => {
  const c = tree();
  const ins = insertNode(c, null, 1, { type: "divider", id: "d1" });
  assert.equal(ins.ok, true);
  if (ins.ok) {
    assert.equal(ins.tree.body[1].id, "d1");
    // Original untouched (pure op).
    assert.equal(c.body.length, 2);
  }
  const into = insertNode(c, "s1", 0, { type: "text", id: "t3", props: { text: "three" } });
  assert.equal(into.ok, true);
  if (into.ok) {
    assert.equal(into.tree.body[1].children?.[0].id, "t3");
  }
});

test("tree ops: insert into a non-container fails and leaves tree unchanged", () => {
  const c = tree();
  const r = insertNode(c, "t1", 0, { type: "text", id: "t3" });
  assert.equal(r.ok, false);
  const bad = insertNode(c, "s1", 0, { type: "watermark", id: "w1", props: { text: "x" } });
  assert.equal(bad.ok, false); // watermark only allowed at body root
});

test("tree ops: move + remove + duplicate + update", () => {
  const c = tree();
  const moved = moveNode(c, "t2", null, 0);
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.equal(moved.tree.body[0].id, "t2");
    assert.equal(moved.tree.body[2].children?.length, 0);
  }
  const removed = removeNode(c, "s1");
  assert.equal(removed.ok, true);
  if (removed.ok) assert.equal(removed.tree.body.length, 1);

  const dup = duplicateNode(c, "s1");
  assert.equal(dup.ok, true);
  if (dup.ok) {
    const copy = dup.tree.body[2];
    assert.equal(copy.type, "section");
    assert.notEqual(copy.id, "s1");
    assert.notEqual(copy.children?.[0].id, "t2"); // subtree re-idded
    const r = validateComposition(dup.tree);
    assert.equal(r.ok, true, "duplicated tree must stay valid");
  }

  const upd = updateNode(c, "t1", { props: { text: "changed" }, hidden: true });
  assert.equal(upd.ok, true);
  if (upd.ok) {
    assert.equal(upd.tree.body[0].props?.text, "changed");
    assert.equal(upd.tree.body[0].hidden, true);
  }
  assert.equal(updateNode(c, "nope", {}).ok, false);
});

test("catalog: every component has label/icon/category", () => {
  for (const spec of PDF_COMPONENTS) {
    assert.ok(spec.type && spec.label && spec.icon && spec.category, spec.type);
    assert.ok(spec.allowedParents.length > 0, spec.type);
  }
});
