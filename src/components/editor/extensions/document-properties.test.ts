import { test } from "node:test";
import assert from "node:assert/strict";
import {
  documentPropertiesHtml,
  frontmatterFromEditor,
  parseDocumentProperties,
  serializeDocumentProperties,
} from "./document-properties";
import type { FrontMatter } from "@/types";
import { htmlToMarkdown } from "@/lib/markdown/to-markdown";

const required = {
  title: "Metadata",
  created: "2026-07-15T00:00:00.000Z",
  modified: "2026-07-15T00:00:00.000Z",
  tags: [],
};

test("document properties escape JSON embedded in an HTML attribute", () => {
  const html = documentPropertiesHtml({
    ...required,
    note: "R&D's <draft>",
  });

  assert.match(html, /R&amp;D&#39;s &lt;draft&gt;/);
  assert.doesNotMatch(html, /R&D's <draft>/);
});

test("nested arbitrary frontmatter round-trips through editor serialization", () => {
  const frontmatter: FrontMatter = {
    ...required,
    workflow: {
      owner: { name: "Ada", active: true },
      stages: ["draft", { review: 2 }],
    },
  };

  assert.deepEqual(
    parseDocumentProperties(serializeDocumentProperties(frontmatter)),
    frontmatter
  );

  const editor = {
    state: {
      doc: {
        firstChild: {
          type: { name: "documentProperties" },
          attrs: { properties: frontmatter },
        },
      },
    },
  } as Parameters<typeof frontmatterFromEditor>[0];
  assert.deepEqual(frontmatterFromEditor(editor), frontmatter);
});

test("document properties do not leak into markdown body serialization", () => {
  const html = `${documentPropertiesHtml({ ...required, secret: "metadata only" })}<p>Body</p>`;
  const markdown = htmlToMarkdown(html);

  assert.equal(markdown, "Body");
  assert.doesNotMatch(markdown, /metadata only/);
});
