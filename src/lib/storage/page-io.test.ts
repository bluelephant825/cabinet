import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ensureContainerDir, readPage, writePage } from "@/lib/storage/page-io";

const exists = (p: string) => fs.access(p).then(() => true, () => false);

test("ensureContainerDir promotes a standalone page into a container", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pageio-"));
  try {
    const page = path.join(root, "Day 264");
    await fs.writeFile(`${page}.md`, "# Day 264\nbody\n");
    await ensureContainerDir(page);
    assert.equal(await fs.readFile(path.join(page, "index.md"), "utf8"), "# Day 264\nbody\n");
    assert.equal(await exists(`${page}.md`), false);
    // idempotent
    await ensureContainerDir(page);
    assert.equal(await fs.readFile(path.join(page, "index.md"), "utf8"), "# Day 264\nbody\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ensureContainerDir heals an already-broken dir+sibling pair", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pageio-"));
  try {
    const page = path.join(root, "Day 264");
    // a sub-page already created (the broken state), but the original is orphaned
    await fs.mkdir(path.join(page, "Day 265"), { recursive: true });
    await fs.writeFile(path.join(page, "Day 265", "index.md"), "# child\n");
    await fs.writeFile(`${page}.md`, "# Day 264\norphaned\n");
    await ensureContainerDir(page);
    assert.equal(await fs.readFile(path.join(page, "index.md"), "utf8"), "# Day 264\norphaned\n");
    assert.equal(await exists(`${page}.md`), false);
    assert.ok(await exists(path.join(page, "Day 265", "index.md")), "child untouched");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("ensureContainerDir is a no-op without a sibling .md", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pageio-"));
  try {
    const page = path.join(root, "Folder");
    await fs.mkdir(page);
    await ensureContainerDir(page);
    assert.equal(await exists(path.join(page, "index.md")), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("read and write preserve arbitrary nested metadata without inventing type", async () => {
  const virtualPath = `metadata-roundtrip-${Date.now()}-${process.pid}`;
  const root = process.env.CABINET_DATA_DIR;
  assert.ok(root, "test requires isolated CABINET_DATA_DIR");
  const pageDir = path.join(root, virtualPath);

  try {
    await fs.mkdir(pageDir, { recursive: true });
    await fs.writeFile(
      path.join(pageDir, "index.md"),
      [
        "---",
        "title: Metadata roundtrip",
        "created: '2026-07-15T00:00:00.000Z'",
        "modified: '2026-07-15T00:00:00.000Z'",
        "tags: [one]",
        "workflow:",
        "  owner:",
        "    name: Ada",
        "    active: true",
        "  stages:",
        "    - draft",
        "    - review: 2",
        "---",
        "Body",
        "",
      ].join("\n")
    );

    const first = await readPage(virtualPath);
    assert.deepEqual(first.frontmatter.workflow, {
      owner: { name: "Ada", active: true },
      stages: ["draft", { review: 2 }],
    });
    assert.equal(Object.hasOwn(first.frontmatter, "type"), false);

    await writePage(virtualPath, first.content, first.frontmatter);
    const second = await readPage(virtualPath);
    assert.deepEqual(second.frontmatter.workflow, first.frontmatter.workflow);
    assert.equal(Object.hasOwn(second.frontmatter, "type"), false);
  } finally {
    await fs.rm(pageDir, { recursive: true, force: true });
  }
});
