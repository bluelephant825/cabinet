import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RssStore } from "../server/rss/store";
import { emptyConfig } from "../src/lib/rss/types";

test("RSS store isolates rooms, serializes mutations, rejects symlinks and refuses page overwrites", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-rss-"));
  const store = new RssStore(root, async () => [{ path: "a" }, { path: "b" }], async () => {});
  try {
    await store.save("a", { ...emptyConfig(), automatic: true });
    assert.equal((await store.config("b")).automatic, false);
    await assert.rejects(store.config(".."));
    await assert.rejects(store.file("a", "../escape"));
    await Promise.all(Array.from({ length: 5 }, () => store.locked("a", async () => { const config = await store.config("a"); config.revision++; await store.save("a", config); })));
    assert.equal((await store.config("a")).revision, 5);
    await store.publish("a", "Briefs/page.md", "Original");
    await assert.rejects(store.publish("a", "Briefs/page.md", "Replacement"));
    assert.equal(await fs.readFile(path.join(root, "a/Briefs/page.md"), "utf8"), "Original");
    await fs.mkdir(path.join(root, "b"), { recursive: true });
    await fs.symlink(path.join(root, "a/.agents"), path.join(root, "b/.agents"));
    await assert.rejects(store.config("b"), /symbolic links/);
    await fs.writeFile(path.join(root, "a/.agents/.config/rss.json"), "bad");
    await assert.rejects(store.config("a"), /corrupt/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
