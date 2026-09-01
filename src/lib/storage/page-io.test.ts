import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  deletePage,
  ensureContainerDir,
  movePage,
  readPage,
  renamePage,
  writePage,
} from "@/lib/storage/page-io";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { buildTree, invalidateTreeCache } from "@/lib/storage/tree-builder";
import { scanCabinet } from "@/lib/storage/references";

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

function fixtureName(label: string): string {
  return `mdx-${label}-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

async function tempArtifacts(dir: string): Promise<string[]> {
  return (await fs.readdir(dir)).filter((name) => name.includes(".tmp-"));
}

test("writePage converts extensions atomically in both directions and preserves mode", async () => {
  const name = fixtureName("roundtrip");
  const mdPath = path.join(DATA_DIR, `${name}.md`);
  const mdxPath = path.join(DATA_DIR, `${name}.mdx`);
  try {
    await fs.writeFile(mdPath, "---\ntitle: Before\n---\nold\n", { mode: 0o640 });

    await writePage(name, "<Callout type=\"info\">New body</Callout>", { title: "MDX" });
    assert.equal(await exists(mdPath), false);
    assert.equal(await exists(mdxPath), true);
    assert.match((await readPage(name)).content, /<Callout/);
    assert.equal((await fs.stat(mdxPath)).mode & 0o777, 0o640);

    await writePage(name, "Plain markdown", { title: "Markdown" });
    assert.equal(await exists(mdxPath), false);
    assert.equal(await exists(mdPath), true);
    assert.equal((await readPage(name)).content, "Plain markdown");
    assert.equal((await fs.stat(mdPath)).mode & 0o777, 0o640);
    assert.deepEqual(await tempArtifacts(DATA_DIR), []);
  } finally {
    await fs.rm(mdPath, { force: true });
    await fs.rm(mdxPath, { force: true });
  }
});

test("writePage refuses an opposite-extension collision without changing either file", async () => {
  const name = fixtureName("collision");
  const mdPath = path.join(DATA_DIR, `${name}.md`);
  const mdxPath = path.join(DATA_DIR, `${name}.mdx`);
  try {
    await fs.writeFile(mdPath, "original markdown");
    await fs.writeFile(mdxPath, "existing mdx");
    await assert.rejects(
      writePage(name, "<Callout>replacement</Callout>", {}),
      /Cannot convert page/
    );
    assert.equal(await fs.readFile(mdPath, "utf8"), "original markdown");
    assert.equal(await fs.readFile(mdxPath, "utf8"), "existing mdx");
    assert.deepEqual(await tempArtifacts(DATA_DIR), []);
  } finally {
    await fs.rm(mdPath, { force: true });
    await fs.rm(mdxPath, { force: true });
  }
});

test("writePage preflights read-only pages before creating conversion artifacts", async () => {
  const name = fixtureName("readonly");
  const mdPath = path.join(DATA_DIR, `${name}.md`);
  const mdxPath = path.join(DATA_DIR, `${name}.mdx`);
  try {
    await fs.writeFile(mdPath, "read only");
    await fs.chmod(mdPath, 0o444);
    await assert.rejects(
      writePage(name, "<Callout>blocked</Callout>", {}),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EACCES"
    );
    assert.equal(await fs.readFile(mdPath, "utf8"), "read only");
    assert.equal(await exists(mdxPath), false);
    assert.deepEqual(await tempArtifacts(DATA_DIR), []);
  } finally {
    await fs.chmod(mdPath, 0o644).catch(() => {});
    await fs.rm(mdPath, { force: true });
    await fs.rm(mdxPath, { force: true });
  }
});

test("failed source removal rolls extension conversion back and cleans its temp", async () => {
  const name = fixtureName("rollback");
  const mdPath = path.join(DATA_DIR, `${name}.md`);
  const mdxPath = path.join(DATA_DIR, `${name}.mdx`);
  const realUnlink = fs.unlink;
  try {
    await fs.writeFile(mdPath, "original");
    fs.unlink = async (target: Parameters<typeof fs.unlink>[0]) => {
      if (target === mdPath) {
        const error = new Error("injected unlink failure") as NodeJS.ErrnoException;
        error.code = "EIO";
        throw error;
      }
      return realUnlink(target);
    };
    await assert.rejects(
      writePage(name, "<Callout>new</Callout>", {}),
      /injected unlink failure/
    );
    assert.equal(await fs.readFile(mdPath, "utf8"), "original");
    assert.equal(await exists(mdxPath), false);
    assert.deepEqual(await tempArtifacts(DATA_DIR), []);
  } finally {
    fs.unlink = realUnlink;
    await fs.rm(mdPath, { force: true });
    await fs.rm(mdxPath, { force: true });
  }
});

test("tree, references, read, rename, move, and delete share one MDX page identity", async () => {
  const name = fixtureName("identity");
  const renamed = `${name}-renamed`;
  const parent = fixtureName("parent");
  const referrer = fixtureName("referrer");
  const sourcePath = path.join(DATA_DIR, `${name}.mdx`);
  const referrerPath = path.join(DATA_DIR, `${referrer}.mdx`);
  const parentPath = path.join(DATA_DIR, parent);
  try {
    await fs.writeFile(sourcePath, `---\ntitle: MDX identity\n---\n<Callout>Body</Callout>\n`);
    await fs.writeFile(referrerPath, `[[${name}]]\n<Callout>Reference</Callout>\n`);
    await fs.mkdir(parentPath);

    invalidateTreeCache();
    const tree = await buildTree(false, true);
    const pending = [...tree];
    let node: (typeof tree)[number] | undefined;
    while (pending.length > 0) {
      const candidate = pending.shift()!;
      if (candidate.path === name) {
        node = candidate;
        break;
      }
      pending.push(...(candidate.children ?? []));
    }
    assert.equal(node?.type, "file");
    assert.equal(node?.frontmatter?.title, "MDX identity");

    const scan = await scanCabinet();
    assert.equal(scan.pages.filter((page) => page.path === name).length, 1);
    assert.ok(scan.markdownFiles.includes(sourcePath));
    assert.equal((await readPage(name)).frontmatter.title, "MDX identity");

    const renamedResult = await renamePage(name, renamed);
    assert.equal(renamedResult.newPath, renamed);
    assert.match(await fs.readFile(referrerPath, "utf8"), new RegExp(`\\[\\[${renamed}\\]\\]`));

    const movedPath = await movePage(renamed, parent);
    assert.equal(movedPath, `${parent}/${renamed}`);
    assert.equal(await exists(path.join(parentPath, `${renamed}.mdx`)), true);
    await deletePage(movedPath);
    assert.equal(await exists(path.join(parentPath, `${renamed}.mdx`)), false);
  } finally {
    await fs.rm(sourcePath, { force: true });
    await fs.rm(path.join(DATA_DIR, `${renamed}.mdx`), { force: true });
    await fs.rm(referrerPath, { force: true });
    await fs.rm(parentPath, { recursive: true, force: true });
  }
});
