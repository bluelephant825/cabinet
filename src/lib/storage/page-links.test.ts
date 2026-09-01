import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import path from "path";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/pages/links/route";
import { DATA_DIR } from "./path-utils";
import {
  discoverPageLinks,
  extractOutgoingLinks,
  resolveMarkdownPageLink,
} from "./page-links";
import type { PageRef } from "./references";

const pages: PageRef[] = [
  { path: "room/notes/source", name: "source" },
  { path: "room/notes/target", name: "target" },
  { path: "room/shared", name: "shared" },
  { path: "other/target", name: "target" },
];

test("Markdown links resolve exact, relative, parent, encoded, and slug targets", () => {
  assert.equal(
    resolveMarkdownPageLink("room/shared.md", "room/notes/source", pages),
    "room/shared"
  );
  assert.equal(
    resolveMarkdownPageLink("./target.md#section", "room/notes/source", pages),
    "room/notes/target"
  );
  assert.equal(
    resolveMarkdownPageLink("../shared", "room/notes/source", pages),
    "room/shared"
  );
  assert.equal(
    resolveMarkdownPageLink("%74arget.md", "room/notes/source", pages),
    "room/notes/target"
  );
  assert.equal(resolveMarkdownPageLink("https://example.com", "room/notes/source", pages), null);
  assert.equal(resolveMarkdownPageLink("#heading", "room/notes/source", pages), null);
});

test("outgoing extraction combines wiki and Markdown links without images or duplicates", () => {
  const markdown = [
    "See [[Target]], [target](./target.md), and [shared](../shared.md).",
    "![not a page](./target.md)",
    "[external](https://example.com)",
  ].join("\n");

  assert.deepEqual(
    extractOutgoingLinks(markdown, "room/notes/source", pages).sort(),
    ["room/notes/target", "room/shared"]
  );
});

test("links API requires a path and rejects path traversal", async () => {
  const missing = await GET(new NextRequest("http://localhost/api/pages/links"));
  assert.equal(missing.status, 400);

  const traversal = await GET(
    new NextRequest("http://localhost/api/pages/links?path=..%2F..%2Foutside")
  );
  assert.equal(traversal.status, 400);
});

test("link discovery returns titled backlinks and outgoing links and rejects traversal", async () => {
  const root = `__page-links-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const writePage = async (relative: string, title: string, body: string) => {
    const directory = path.join(DATA_DIR, root, relative);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, "index.md"),
      `---\ntitle: ${title}\n---\n\n${body}\n`,
      "utf8"
    );
  };

  try {
    await writePage("target", "Target page", "No links here.");
    await writePage("source", "Source page", "See [[Target]] and [Target](./target.md).");
    await writePage("other", "Other page", "See [Source](./source).");

    const result = await discoverPageLinks(`${root}/source`);
    assert.deepEqual(result.incoming, [
      { path: `${root}/other`, title: "Other page" },
    ]);
    assert.deepEqual(result.outgoing, [
      { path: `${root}/target`, title: "Target page" },
    ]);

    await assert.rejects(
      () => discoverPageLinks("../../outside"),
      /Path traversal detected/
    );
  } finally {
    await fs.rm(path.join(DATA_DIR, root), { recursive: true, force: true });
  }
});
