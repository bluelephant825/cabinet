import test, { before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { DATA_DIR } from "@/lib/storage/path-utils";

type SaveClip = typeof import("./save-clip");
let saveClipModule: SaveClip;

before(async () => {
  saveClipModule = await import("./save-clip");
});

const CLIP_MD = "---\ntitle: Saved Page\ntags: [clip]\n---\n# Hello\n\nBody text.";

test("saveClip writes <file>.md with parsed frontmatter and body", async () => {
  const saved = await saveClipModule.saveClip({
    file: "Clips/Saved Page",
    markdown: CLIP_MD,
  });
  assert.equal(saved.path, "Clips/Saved Page");
  assert.equal(saved.title, "Saved Page");

  const raw = await fs.readFile(
    path.join(DATA_DIR, "Clips", "Saved Page.md"),
    "utf8",
  );
  const parsed = matter(raw);
  assert.equal(parsed.data.title, "Saved Page");
  assert.deepEqual(parsed.data.tags, ["clip"]);
  assert.ok(typeof parsed.data.created === "string" && parsed.data.created);
  assert.equal(parsed.content.trim(), "# Hello\n\nBody text.");
});

test("a second clip to the same file uniquifies to '<name> 1'", async () => {
  await saveClipModule.saveClip({
    file: "Clips/Dupe",
    markdown: "# one",
  });
  const again = await saveClipModule.saveClip({
    file: "Clips/Dupe",
    markdown: "# two",
  });
  assert.equal(again.path, "Clips/Dupe 1");
  const raw = await fs.readFile(
    path.join(DATA_DIR, "Clips", "Dupe 1.md"),
    "utf8",
  );
  assert.match(raw, /# two/);
});

test("title falls back to the file basename when frontmatter has none", async () => {
  const saved = await saveClipModule.saveClip({
    file: "Clips/No Title",
    markdown: "no frontmatter here",
  });
  assert.equal(saved.title, "No Title");
  const raw = await fs.readFile(
    path.join(DATA_DIR, "Clips", "No Title.md"),
    "utf8",
  );
  assert.equal(matter(raw).data.title, "No Title");
});
