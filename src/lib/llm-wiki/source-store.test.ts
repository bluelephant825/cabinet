import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { initializeWikiCabinet, readWikiCabinet, setWikiEnabled } from "./config";
import { SourceStore } from "./source-store";
import type { SourceId } from "./types";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-source-store-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".cabinet"), "schemaVersion: 1\nkind: root\nname: Research\ncustom:\n  retained: true\n");
  return root;
}

const snapshot = { mode: "snapshot" as const, title: "Same title", classification: "research", roomPath: null };

test("initialization preserves metadata, defaults off and persists identity across reopen", async (t) => {
  const root = await fixture(t);
  assert.equal(await readWikiCabinet(root), null);
  const first = await initializeWikiCabinet(root);
  assert.equal(first.config.enabled, false);
  assert.equal(first.config.autoIngestInbox, false);
  assert.equal((await initializeWikiCabinet(root)).cabinetId, first.cabinetId);
  const saved = yaml.load(await fs.readFile(path.join(root, ".cabinet"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(saved.custom, { retained: true });
  assert.deepEqual((await fs.readdir(root)).sort(), [".cabinet"]);
  await assert.rejects(new SourceStore(root).register(snapshot), /disabled/);
  await setWikiEnabled(root, true);
  assert.equal((await readWikiCabinet(root))?.cabinetId, first.cabinetId);
  await new SourceStore(root).register(snapshot);
  await setWikiEnabled(root, false);
  assert.equal((await new SourceStore(root).list()).length, 1);
});

test("conflicting folders are never adopted or overwritten; custom paths are supported", async (t) => {
  const root = await fixture(t);
  const before = await fs.readFile(path.join(root, ".cabinet"), "utf8");
  await fs.mkdir(path.join(root, "raw"));
  await fs.writeFile(path.join(root, "raw", "existing.md"), "untouched");
  await assert.rejects(initializeWikiCabinet(root), /nonempty/);
  assert.equal(await fs.readFile(path.join(root, ".cabinet"), "utf8"), before);
  await initializeWikiCabinet(root, { paths: { raw: "evidence" }, enabled: true });
  const registered = await new SourceStore(root).register(snapshot);
  assert.match(registered.source.rawPath, /^evidence\/research\//);
  assert.equal(await fs.readFile(path.join(root, "raw", "existing.md"), "utf8"), "untouched");
});

test("path validation rejects traversal, Windows paths, overlaps, hidden layers, and symlinks", async (t) => {
  for (const raw of ["../escape", "/absolute", "C:/escape", "raw\\escape", "a//b", ".agents/raw", "wiki", "wiki/child", "WIKI", "wiki./child"]) {
    const root = await fixture(t);
    await assert.rejects(initializeWikiCabinet(root, { paths: { raw } }));
    assert.equal(await readWikiCabinet(root), null);
  }
  const root = await fixture(t);
  const outside = await fixture(t);
  await fs.symlink(outside, path.join(root, "raw"), "dir");
  await assert.rejects(initializeWikiCabinet(root), /Symlink/);
  assert.deepEqual(await fs.readdir(outside), [".cabinet"]);
});

test("invalid config and non-root Cabinets fail closed", async (t) => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, ".cabinet"), "kind: room\n");
  await assert.rejects(initializeWikiCabinet(root), /root Cabinet/);
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nllmWiki: {schemaVersion: 99}\n");
  await assert.rejects(initializeWikiCabinet(root), /object|config/);
});

test("snapshots with identical titles get different identities; registry rebuilds from manifests", async (t) => {
  const root = await fixture(t);
  await initializeWikiCabinet(root, { enabled: true });
  const store = new SourceStore(root);
  const first = await store.register(snapshot);
  const second = await store.register(snapshot);
  assert.notEqual(first.source.id, second.source.id);
  assert.notEqual(first.source.rawPath, second.source.rawPath);
  assert.deepEqual(first.versions, []);
  assert.equal(first.source.currentVersionId, null);
  assert.deepEqual(await new SourceStore(root).get(first.source.id), first);
  assert.equal((await new SourceStore(root).list()).length, 2);
  assert.equal(await store.get(randomUUID() as SourceId), null);
  await assert.rejects(store.get("../escape" as SourceId), /identity/);
  await assert.rejects(store.register({ ...snapshot, classification: "research/manifest.yaml" }), /manifest filename/);
  await assert.rejects(store.register({ ...snapshot, classification: `${first.source.rawPath.slice(4)}/nested` }), /existing Source/);
});

test("managed registration and rebinding preserve working bytes and logical identity", async (t) => {
  const root = await fixture(t);
  await initializeWikiCabinet(root, { enabled: true });
  await fs.mkdir(path.join(root, "notes"));
  const original = "---\ntitle: Original\n---\nDo not rewrite me.\n";
  await fs.writeFile(path.join(root, "notes/a.md"), original);
  const store = new SourceStore(root);
  const managedLocation = { kind: "cabinet" as const, path: "notes/a.md" };
  const first = await store.register({ ...snapshot, mode: "managed", managedLocation });
  assert.equal((await store.findManaged(managedLocation))?.id, first.source.id);
  await assert.rejects(store.register({ ...snapshot, mode: "managed", managedLocation }), /already registered/);
  await fs.rename(path.join(root, "notes/a.md"), path.join(root, "notes/b.md"));
  // A missing working file does not destroy registration or require a read.
  assert.equal((await store.get(first.source.id))?.source.status, "active");
  const rebound = await store.rebind(first.source.id, { kind: "cabinet", path: "notes/b.md" });
  assert.equal(rebound.source.id, first.source.id);
  assert.equal(rebound.source.rawPath, first.source.rawPath);
  assert.equal(await store.findManaged(managedLocation), null);
  assert.equal(await fs.readFile(path.join(root, "notes/b.md"), "utf8"), original);
  assert.deepEqual(await fs.readdir(path.join(root, first.source.rawPath)), ["manifest.yaml"]);
});

test("managed inputs cannot come from generated layers or escaping symlinks", async (t) => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await initializeWikiCabinet(root, { enabled: true });
  const store = new SourceStore(root);
  for (const inputPath of ["raw/a.md", "RAW/a.md", "wiki/a.md", "Inbox/a.md", ".cabinet", "../escape"]) {
    await assert.rejects(store.register({ ...snapshot, mode: "managed", managedLocation: { kind: "cabinet", path: inputPath } }));
  }
  await fs.symlink(outside, path.join(root, "linked"), "dir");
  await assert.rejects(store.register({ ...snapshot, mode: "managed", managedLocation: { kind: "cabinet", path: "linked/file.md" } }), /Symlink/);
  assert.deepEqual(await store.list(), []);
});

test("foreign, duplicate, corrupt manifests and invalid version pointers are surfaced", async (t) => {
  const root = await fixture(t);
  await initializeWikiCabinet(root, { enabled: true });
  const store = new SourceStore(root);
  const entry = await store.register(snapshot);
  const target = path.join(root, entry.source.rawPath, "manifest.yaml");
  for (const patch of [{ cabinetId: randomUUID() }, { currentVersionId: randomUUID() }, { status: "nonsense" }]) {
    await fs.writeFile(target, yaml.dump({ ...entry, source: { ...entry.source, ...patch } }));
    await assert.rejects(store.list());
  }
  await fs.writeFile(target, "source: [broken");
  await assert.rejects(store.list());
  await fs.writeFile(target, yaml.dump(entry));
  const copyPath = `raw/other/${path.basename(entry.source.rawPath)}`;
  await fs.mkdir(path.join(root, copyPath), { recursive: true });
  await fs.writeFile(path.join(root, copyPath, "manifest.yaml"), yaml.dump({ ...entry, source: { ...entry.source, rawPath: copyPath } }));
  await assert.rejects(store.list(), /Duplicate Source ID/);
});

test("registry is root-isolated and detects post-initialization symlink replacement", async (t) => {
  const root = await fixture(t);
  const other = await fixture(t);
  await initializeWikiCabinet(root, { enabled: true });
  await initializeWikiCabinet(other, { enabled: true });
  const source = await new SourceStore(root).register(snapshot);
  assert.equal(await new SourceStore(other).get(source.source.id), null);
  await fs.symlink(path.join(root, "raw"), path.join(other, "raw"), "dir");
  await assert.rejects(new SourceStore(other).list(), /Symlink/);
});

test("cross-process lock refuses competing writes without changing evidence", async (t) => {
  const root = await fixture(t);
  await initializeWikiCabinet(root, { enabled: true });
  await fs.writeFile(path.join(root, ".llm-wiki.lock"), "unverified previous owner");
  await assert.rejects(new SourceStore(root).register(snapshot), /locked/);
  assert.deepEqual(await new SourceStore(root).list(), []);
  assert.equal(await fs.readFile(path.join(root, ".llm-wiki.lock"), "utf8"), "unverified previous owner");
});

test("version lookup validates ownership, hashes, paths and latest pointer without rewriting evidence", async (t) => {
  const root = await fixture(t);
  await initializeWikiCabinet(root, { enabled: true });
  const store = new SourceStore(root);
  const entry = await store.register(snapshot);
  const version = {
    id: randomUUID(), sourceId: entry.source.id, cabinetId: entry.source.cabinetId,
    version: 1, contentHash: "a".repeat(64), originalFormat: "md",
    originalPath: `${entry.source.rawPath}/v1/original.md`,
    markdownPath: `${entry.source.rawPath}/v1/source.md`, createdAt: new Date().toISOString(),
  };
  const target = path.join(root, entry.source.rawPath, "manifest.yaml");
  const manifest = { ...entry, source: { ...entry.source, currentVersionId: version.id }, versions: [version] };
  const raw = yaml.dump(manifest);
  await fs.writeFile(target, raw);
  assert.deepEqual((await store.get(entry.source.id))?.versions, [version]);
  assert.equal(await fs.readFile(target, "utf8"), raw);
  for (const patch of [{ sourceId: randomUUID() }, { contentHash: "bad" }, { version: 0 }, { markdownPath: "../escape" }, { status: "current" }]) {
    await fs.writeFile(target, yaml.dump({ ...manifest, versions: [{ ...version, ...patch }] }));
    await assert.rejects(store.list());
  }
  const nextVersion = {
    ...version, id: randomUUID(), version: 2,
    originalPath: `${entry.source.rawPath}/v2/original.md`,
    markdownPath: `${entry.source.rawPath}/v2/source.md`,
  };
  await fs.writeFile(target, yaml.dump({ ...manifest, versions: [version, nextVersion] }));
  await assert.rejects(store.list(), /latest/);
  await fs.writeFile(target, yaml.dump({
    ...manifest, versions: [version, nextVersion],
    source: { ...manifest.source, currentVersionId: nextVersion.id, lastCompiledVersionId: version.id },
  }));
  const lagging = await store.get(entry.source.id);
  assert.equal(lagging?.source.currentVersionId, nextVersion.id);
  assert.equal(lagging?.source.lastCompiledVersionId, version.id);
});

test("an interrupted registration leaves no phantom Source and can be retried", async (t) => {
  const root = await fixture(t);
  await initializeWikiCabinet(root, { enabled: true });
  // Simulate a crash before the atomic manifest rename. Unpublished bytes are
  // retained for inspection but are never adopted as a complete registration.
  const orphan = path.join(root, "raw/research", `interrupted-${randomUUID()}`);
  await fs.mkdir(orphan, { recursive: true });
  await fs.writeFile(path.join(orphan, "manifest.yaml.tmp-interrupted"), "partial");
  const store = new SourceStore(root);
  assert.deepEqual(await store.list(), []);
  await store.register(snapshot);
  assert.equal((await store.list()).length, 1);
  assert.equal(await fs.readFile(path.join(orphan, "manifest.yaml.tmp-interrupted"), "utf8"), "partial");
});
