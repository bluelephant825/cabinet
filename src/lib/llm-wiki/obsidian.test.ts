import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { ObsidianManagedSourceService } from "./obsidian";
import { initializeWikiCabinet } from "./config";
import { SourceStore } from "./source-store";
import { SourceLifecycleStore } from "./source-lifecycle";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-obsidian-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: Vault\n");
  await initializeWikiCabinet(root, { enabled: true });
  await fs.mkdir(path.join(root, ".obsidian"));
  await fs.writeFile(path.join(root, ".obsidian/app.json"), '{"useMarkdownLinks":false}');
  await fs.mkdir(path.join(root, "Notes"));
  const note = "---\ntitle: Original title\naliases: [Alias]\n---\n# Note\n[[Other#Heading|Label]] and ![[photo.png]]\n";
  await fs.writeFile(path.join(root, "Notes/Note.md"), note);
  await fs.writeFile(path.join(root, "Other.md"), "# Other\n");
  await fs.writeFile(path.join(root, "photo.png"), "captured fixture asset");
  return { root, note, service: new ObsidianManagedSourceService(root) };
}

test("vault inventory and selective import preserve notes, links, settings and folder structure", async (t) => {
  const f = await fixture(t);
  const inventory = await f.service.inspect();
  assert.deepEqual(inventory.notes.map((note) => note.path), ["Notes/Note.md", "Other.md"]);
  assert.equal((await new SourceStore(f.root).list()).length, 0);
  const result = await f.service.importNotes(inventory, ["Notes/Note.md"]);
  assert.equal(result.length, 1);
  assert.ok(result[0].warnings.some((warning) => warning.code === "unsupported-embed"));
  const stored = (await new SourceStore(f.root).get(result[0].sourceId))!;
  assert.equal(stored.source.mode, "managed");
  assert.equal(stored.source.roomPath, null);
  if (stored.source.mode === "managed") assert.deepEqual(stored.source.managedLocation, { kind: "cabinet", path: "Notes/Note.md" });
  assert.equal(stored.versions.length, 1);
  assert.equal(await fs.readFile(path.join(f.root, stored.versions[0].originalPath), "utf8"), f.note);
  assert.equal(await fs.readFile(path.join(f.root, "Notes/Note.md"), "utf8"), f.note);
  assert.equal(await fs.readFile(path.join(f.root, ".obsidian/app.json"), "utf8"), '{"useMarkdownLinks":false}');
  assert.equal(await fs.readFile(path.join(f.root, "photo.png"), "utf8"), "captured fixture asset");
  assert.equal(stored.source.lastCompiledVersionId, null);
  assert.deepEqual(await f.service.importNotes(inventory, ["Notes/Note.md"]), result);
  assert.equal((await new SourceStore(f.root).list()).length, 1);
});

test("explicit save capture reuses managed identity and immutable history with predecessor checks", async (t) => {
  const f = await fixture(t);
  const [imported] = await f.service.importNotes(await f.service.inspect(), ["Notes/Note.md"]);
  const changed = f.note + "New knowledge.\n";
  await fs.writeFile(path.join(f.root, "Notes/Note.md"), changed);
  await assert.rejects(f.service.captureNote("Notes/Note.md", hash(changed)), /explicit predecessor/);
  const { manifest } = await f.service.captureNote("Notes/Note.md", hash(changed), "obsidian", imported.versionId!);
  assert.equal(manifest.source.id, imported.sourceId);
  assert.equal(manifest.versions.length, 2);
  assert.equal(await fs.readFile(path.join(f.root, manifest.versions[0].originalPath), "utf8"), f.note);
  assert.equal(await fs.readFile(path.join(f.root, manifest.versions[1].originalPath), "utf8"), changed);
  await assert.rejects(f.service.captureNote("Notes/Note.md", hash(changed), "obsidian", imported.versionId!), /predecessor changed/);
});

test("vault excludes generated layers, symlinks, nested rooms/vaults and hidden settings", async (t) => {
  const f = await fixture(t);
  for (const folder of ["wiki", "raw", "inbox", "Room", "Nested"]) await fs.mkdir(path.join(f.root, folder), { recursive: true });
  await fs.writeFile(path.join(f.root, "wiki/generated.md"), "generated");
  await fs.writeFile(path.join(f.root, "Room/.cabinet"), "kind: room\nname: Room\n");
  await fs.writeFile(path.join(f.root, "Room/hidden.md"), "room");
  await fs.mkdir(path.join(f.root, "Nested/.obsidian"));
  await fs.writeFile(path.join(f.root, "Nested/note.md"), "nested");
  await fs.symlink(path.join(f.root, "Other.md"), path.join(f.root, "Alias.md"));
  const inventory = await f.service.inspect();
  assert.equal(inventory.notes.length, 2);
  assert.ok(inventory.skipped.some((item) => item.path === "Alias.md"));
  for (const file of ["wiki/generated.md", "Room/hidden.md", "Nested/note.md", "Alias.md", "../outside.md", ".obsidian/app.json"]) await assert.rejects(f.service.captureNote(file, hash("generated")));
});

test("stale inventories and removed Sources fail without silent restoration or extra snapshots", async (t) => {
  const f = await fixture(t);
  const old = await f.service.inspect();
  await fs.writeFile(path.join(f.root, "Other.md"), "Changed\n");
  await assert.rejects(f.service.importNotes(old, ["Notes/Note.md"]), /inventory changed/);
  assert.equal((await new SourceStore(f.root).list()).length, 0);
  const [entry] = await f.service.importNotes(await f.service.inspect(), ["Notes/Note.md"]);
  await new SourceLifecycleStore(f.root).remove(entry.sourceId, 0);
  await assert.rejects(f.service.importNotes(await f.service.inspect(), ["Notes/Note.md"]), /lifecycle/);
  assert.equal((await new SourceStore(f.root).get(entry.sourceId))?.versions.length, 1);
});
