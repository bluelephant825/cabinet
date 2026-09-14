import test from "node:test";
import assert from "node:assert/strict";
import { readWikiFrontmatter, renderWikiIndex, slugify, sourcePageSlug } from "./wiki-index";

test("slugify produces readable lowercase-hyphen slugs", () => {
  assert.equal(slugify("Spaced Repetition"), "spaced-repetition");
  assert.equal(slugify("  The  Café — Notes! "), "the-cafe-notes");
  assert.equal(slugify("a".repeat(120)).length, 80);
  assert.equal(slugify("!!!"), "");
});

test("sourcePageSlug falls back to an identity suffix for unreadable titles", () => {
  assert.equal(sourcePageSlug("Apple study", "abc123def456"), "apple-study");
  assert.equal(sourcePageSlug("!!!", "abc123def456"), "source-abc123de");
});

test("readWikiFrontmatter tolerates missing or malformed frontmatter", () => {
  assert.equal(readWikiFrontmatter("# No frontmatter\n"), null);
  assert.equal(readWikiFrontmatter("---\n[unclosed\n"), null);
  assert.equal(readWikiFrontmatter("---\ntitle: A\ntype: concept\nsources: [s1]\n---\n\n# A\n")?.type, "concept");
});

test("renderWikiIndex groups pages by area and renders deterministically", () => {
  const pages = [
    { path: "wiki/sources/apple-study.md", meta: { title: "Apple study", type: "source-summary", created: "2026-01-02", tags: ["notes"] } },
    { path: "wiki/concepts/spaced-repetition.md", meta: { title: "Spaced repetition", type: "concept", sources: ["apple-study"] } },
    { path: "wiki/entities/test-entity.md", meta: { title: "Test Entity", type: "entity", subtype: "tool", sources: ["apple-study"] } },
  ];
  const index = renderWikiIndex("wiki", pages);
  assert.equal(index, renderWikiIndex("wiki", [...pages].reverse()));
  assert.match(index, /## Sources[\s\S]*\[apple-study\.md\]\(sources\/apple-study\.md\)/);
  assert.match(index, /## Entities[\s\S]*\[test-entity\.md\]\(entities\/test-entity\.md\)/);
  assert.match(index, /## Concepts[\s\S]*\[spaced-repetition\.md\]\(concepts\/spaced-repetition\.md\)/);
  assert.match(index, /\[overview\.md\]\(overview\.md\)/);
});
