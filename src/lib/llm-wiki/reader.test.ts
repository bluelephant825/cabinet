import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { initializeWikiCabinet, setWikiEnabled } from "./config";
import { SourceStore } from "./source-store";
import { RawPublicationStore } from "./raw-publication";
import { SourceNormalizationService } from "./normalizers";
import { readRawSource } from "./raw-reader";
import { readerHtml, safeHtml, originalDocument, notebookHtml } from "./reader-html";
import { isProtectedRawPath } from "./raw-write-guard";

test("reader renders ordinary Markdown features without MDX, scripts or remote images", async () => {
  const output = await readerHtml('# Heading\n\n| A | B |\n|---|---|\n| 1 | 2 |\n\n> [!NOTE]\n> Safe\n\n```jsx live\nalert(1)\n```\n\n<script>alert(2)</script>\n\n![remote](https://tracker.test/x)\n\n[Link](https://example.org)\n\nFootnote[^1]\n\n[^1]: Note', async () => null);
  assert.match(output, /<table>/); assert.match(output, /<blockquote>/); assert.match(output, /<pre><code>/);
  assert.doesNotMatch(output, /<script|src="https|data-live-code|<iframe/);
  assert.match(output, /noopener noreferrer/); assert.match(output, /user-content-fn/);
  assert.match(output, /<strong>Note: <\/strong>/);
});

test("notebooks display captured cells and text outputs without executable rich outputs", async () => {
  const output = await notebookHtml(JSON.stringify({ cells: [
    { cell_type: "markdown", source: ["# Notebook"] },
    { cell_type: "code", source: ["print('result')"], outputs: [{ text: ["result"] }, { data: { "text/html": "<script>bad()</script>" } }] },
  ] }));
  assert.match(output, /<h1>Notebook<\/h1>/);
  assert.match(output, /print\('result'\)/);
  assert.match(output, /<pre>result<\/pre>/);
  assert.doesNotMatch(output, /<script>|bad\(\)/);
});

test("original preview strips active content, forms, navigation, CSS and privileged URL schemes", async () => {
  const output = await safeHtml('<script>bad()</script><style>@import "https://tracker"</style><iframe src="/api"></iframe><form action="/api"><input></form><meta http-equiv="refresh" content="0;url=/api"><a href="/api">link</a><img src="file:///etc/passwd" onerror="bad()"><svg onload="bad()"></svg><p onclick="bad()">Safe</p>', async () => null, true);
  assert.doesNotMatch(output, /script|style|iframe|form|meta|href=|onerror|onclick|svg|file:/);
  assert.match(output, /Safe/);
  assert.match(originalDocument(output), /default-src 'none'/);
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-reader-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: Reader\n");
  await initializeWikiCabinet(root, { enabled: true, paths: { raw: "evidence/raw" } });
  const registered = await new SourceStore(root).register({ mode: "snapshot", title: "Captured article", classification: "research", roomPath: null });
  const bytes = Buffer.from("# Article\n\nOriginal body.");
  const normalized = await new SourceNormalizationService().normalize({ path: "article.md", bytes, contentHash: createHash("sha256").update(bytes).digest("hex") });
  const entry = await new RawPublicationStore(root).publishInitial(registered.source.id, normalized);
  return { root, entry };
}

test("viewer resolves Source paths to verified current evidence and still works with ingestion disabled", async (t) => {
  const f = await fixture(t);
  await setWikiEnabled(f.root, false);
  const result = await readRawSource(f.root, f.entry.versions[0].markdownPath);
  assert.equal(result.kind, "source");
  if (result.kind !== "source") return;
  assert.match(result.readerHtml, /<h1>Article<\/h1>/);
  assert.match(result.markdown, /source_version_id:/);
  assert.equal(result.original.content, "# Article\n\nOriginal body.");
  assert.equal(result.versionId, f.entry.versions[0].id);
  assert.equal((await readRawSource(f.root, "evidence/raw")).kind, "directory");
  assert.equal((await readRawSource(f.root, "ordinary.md")).kind, "ordinary");
  await fs.appendFile(path.join(f.root, f.entry.versions[0].markdownPath), "tampered");
  await assert.rejects(readRawSource(f.root, f.entry.source.rawPath), /integrity/);
});

test("read-only guard protects custom Raw paths, containing folders and symlink aliases", async (t) => {
  const f = await fixture(t);
  for (const name of ["evidence", "evidence/raw", f.entry.versions[0].markdownPath]) assert.equal(await isProtectedRawPath(f.root, name), true);
  assert.equal(await isProtectedRawPath(f.root, "ordinary.md"), false);
  await fs.symlink(path.join(f.root, "evidence/raw"), path.join(f.root, "alias"));
  assert.equal(await isProtectedRawPath(f.root, "alias/new.md"), true);
  await assert.rejects(new RawPublicationStore(f.root).readCapturedFile(f.entry.source.id, f.entry.versions[0].id, "../manifest.yaml"));
  await assert.rejects(new RawPublicationStore(f.root).readCapturedFile(f.entry.source.id, f.entry.versions[0].id, "missing.txt"), /not found/);
});

test("Reader embeds only receipt-verified captured raster images", async (t) => {
  const f = await fixture(t);
  const registered = await new SourceStore(f.root).register({ mode: "snapshot", title: "Illustrated", classification: "research", roomPath: null });
  const bytes = Buffer.from("![Local](pixel.png)\n\n![Remote](https://tracker.invalid/pixel.png)");
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=", "base64");
  const normalized = await new SourceNormalizationService().normalize({ path: "article.md", bytes,
    contentHash: createHash("sha256").update(bytes).digest("hex"), assets: [{ path: "pixel.png", bytes: pixel }] });
  await new RawPublicationStore(f.root).publishInitial(registered.source.id, normalized);
  const result = await readRawSource(f.root, registered.source.rawPath);
  assert.equal(result.kind, "source");
  if (result.kind !== "source") return;
  assert.match(result.readerHtml, /src="data:image\/png;base64,/);
  assert.doesNotMatch(result.readerHtml, /src="https:/);
});

test("version selection binds all previews to the requested Source version and leaves current unchanged", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, "managed.md"), "working");
  const registered = await new SourceStore(f.root).register({ mode: "managed", title: "History", classification: "research", roomPath: null,
    managedLocation: { kind: "cabinet", path: "managed.md" } });
  const publication = new RawPublicationStore(f.root);
  const normalize = async (value: string, format = "md") => {
    const bytes = Buffer.from(value);
    return new SourceNormalizationService({ async convert() {
      return { markdown: "# Converted second", metadata: {}, assets: [], warnings: [], converter: { name: "fixture", version: "1" } };
    } }).normalize({ path: `document.${format}`, bytes, contentHash: createHash("sha256").update(bytes).digest("hex") });
  };
  const first = await publication.publishInitial(registered.source.id, await normalize("# First"));
  const second = await publication.publishUpdate(registered.source.id, first.versions[0].id, await normalize("<h1>Second original</h1>", "html"));
  const third = await publication.publishUpdate(registered.source.id, second.versions[1].id, await normalize("# Third"));
  const before = await fs.readFile(path.join(f.root, registered.source.rawPath, "manifest.yaml"));
  for (const [index, expected] of ["First", "Converted second", "Third"].entries()) {
    const data = await readRawSource(f.root, registered.source.rawPath, third.versions[index].id);
    assert.equal(data.kind, "source");
    if (data.kind !== "source") return;
    assert.equal(data.versionId, third.versions[index].id);
    assert.match(data.readerHtml, new RegExp(expected));
    assert.ok(data.markdown.includes(third.versions[index].id));
    assert.equal(data.currentVersionId, third.versions[2].id);
    assert.deepEqual(data.versions.map((version) => [version.version, version.status]), [[3, "current"], [2, "superseded"], [1, "superseded"]]);
    if (index === 1) { assert.equal(data.format, "html"); assert.match(data.original.content!, /Second original/); }
    else assert.equal(data.original.content, `# ${expected}`);
  }
  const current = await readRawSource(f.root, registered.source.rawPath);
  assert.equal(current.kind === "source" && current.version, 3);
  const linked = await readRawSource(f.root, first.versions[0].markdownPath);
  assert.equal(linked.kind === "source" && linked.version, 1);
  const override = await readRawSource(f.root, first.versions[0].markdownPath, third.versions[2].id);
  assert.equal(override.kind === "source" && override.version, 3);
  await assert.rejects(readRawSource(f.root, `${registered.source.rawPath}/v999/source.md`), /does not belong/);
  await assert.rejects(readRawSource(f.root, registered.source.rawPath, f.entry.versions[0].id), /does not belong/);
  await assert.rejects(readRawSource(f.root, registered.source.rawPath, "invalid-id"));
  assert.deepEqual(await fs.readFile(path.join(f.root, registered.source.rawPath, "manifest.yaml")), before);
  await fs.appendFile(path.join(f.root, first.versions[0].markdownPath), "tampered");
  await assert.rejects(readRawSource(f.root, registered.source.rawPath, first.versions[0].id), /integrity/);
  assert.equal((await readRawSource(f.root, registered.source.rawPath)).kind, "source");
});

test("Raw sidebar files show their actual contents and Markdown has one original copy", async (t) => {
  const f = await fixture(t);
  const base = `${f.entry.source.rawPath}/v1`;
  const metadata = await readRawSource(f.root, `${base}/capture.json`);
  assert.equal(metadata.kind, "file");
  assert.equal(metadata.kind === "file" && JSON.parse(metadata.text!).original, "original.md");
  const original = await readRawSource(f.root, `${base}/original`);
  assert.equal(original.kind === "file" && original.text, "# Article\n\nOriginal body.");
  const manifest = await readRawSource(f.root, `${f.entry.source.rawPath}/manifest.yaml`);
  assert.equal(manifest.kind, "file");
  assert.match(manifest.kind === "file" ? manifest.text! : "", /schemaVersion: 1/);
  await assert.rejects(fs.access(path.join(f.root, base, "capture/article.md")));
  await fs.appendFile(path.join(f.root, base, "capture.json"), "tamper");
  await assert.rejects(readRawSource(f.root, `${base}/capture.json`), /integrity/);
});
