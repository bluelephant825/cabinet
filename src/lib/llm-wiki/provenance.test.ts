import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import yaml from "js-yaml";
import { SourceNormalizationService } from "./normalizers";
import { assertEvidenceMatches, parseEvidenceFrontMatter, prepareEvidenceDocument, readEvidenceDocument } from "./provenance";
import { decodeSourceManifest, encodeSourceManifest, type SourceManifest } from "./manifest";
import type { WikiCabinet } from "./config";
import type { CabinetId, SourceId, SourceVersionId, Source, SourceVersion } from "./types";

async function fixture(text = "---\ntitle: Imported title\nlanguage: en\nsource_id: forged\nsha256: forged\nentities: [one, two]\n---\n\n# Exact body\n\n```js\nthrow new Error('inert');\n```\n") {
  const cabinetId = randomUUID() as CabinetId;
  const id = randomUUID() as SourceId;
  const versionId = randomUUID() as SourceVersionId;
  const timestamp = "2026-09-11T10:00:00.000Z";
  const source: Source = { id, cabinetId, roomPath: null, mode: "snapshot", title: "Cabinet title", slug: "note",
    rawPath: `raw/research/note-${id}`, status: "active", currentVersionId: versionId, lastCompiledVersionId: null,
    createdAt: timestamp, updatedAt: timestamp };
  const original = new TextEncoder().encode(text);
  const hash = createHash("sha256").update(original).digest("hex");
  const normalized = await new SourceNormalizationService().normalize({ path: "notes/Original.MD", bytes: original, contentHash: hash });
  const version: SourceVersion = { id: versionId, sourceId: id, cabinetId, version: 1, contentHash: hash,
    originalFormat: "md", originalPath: `${source.rawPath}/v1/original.md`, markdownPath: `${source.rawPath}/v1/source.md`, createdAt: timestamp };
  const cabinet: WikiCabinet = { rootPath: "/unused", cabinetId,
    config: { schemaVersion: 1, cabinetId, enabled: true, autoIngestInbox: false, paths: { inbox: "Inbox", raw: "raw", wiki: "wiki" } } };
  return { normalized, source, version, cabinet, original };
}

test("evidence header derives identity and provenance from Cabinet and retains exact normalized body", async () => {
  const f = await fixture();
  const prepared = prepareEvidenceDocument(f.normalized, f.source, f.version);
  const read = readEvidenceDocument(prepared.markdown, { source: f.source, version: prepared.version });
  assert.equal(read.frontMatter.source_id, f.source.id);
  assert.equal(read.frontMatter.source_version_id, f.version.id);
  assert.equal(read.frontMatter.sha256, f.version.contentHash);
  assert.equal(read.frontMatter.title, "Cabinet title");
  assert.equal(read.frontMatter.original_filename, "Original.MD");
  assert.equal(read.frontMatter.language, "en");
  assert.equal(read.body, "\n# Exact body\n\n```js\nthrow new Error('inert');\n```\n");
  assert.deepEqual(read.frontMatter.conversion, { tool: "cabinet-markdown", version: "1" });
  assert.equal(Object.hasOwn(read.frontMatter, "entities"), false);
  assert.equal(Object.hasOwn(read.frontMatter, "status"), false);
  assert.deepEqual(f.normalized.original.bytes, f.original);
  assert.equal(f.version.document, undefined);
  assert.equal(prepareEvidenceDocument(f.normalized, f.source, f.version).markdown, prepared.markdown);
  const bulk = prepareEvidenceDocument({ ...f.normalized, metadata: { ...f.normalized.metadata, entities: Array(5000).fill("extracted") } }, f.source, f.version);
  assert.equal(bulk.markdown, prepared.markdown);
});

test("generated leading rules and document-looking YAML remain content when the converter did not parse them", async () => {
  const f = await fixture("# Native");
  const converter = new SourceNormalizationService({ async convert() {
    return { markdown: "---\nsource_id: untrusted\n---\n\n# Generated", metadata: {}, assets: [], warnings: [],
      converter: { name: "fixture", version: "1" }, parseFrontMatter: false };
  } });
  const original = new TextEncoder().encode("original HTML");
  const hash = createHash("sha256").update(original).digest("hex");
  const normalized = await converter.normalize({ path: "original.html", bytes: original, contentHash: hash });
  const version = { ...f.version, contentHash: hash, originalFormat: "html", originalPath: `${f.source.rawPath}/v1/original.html` };
  const prepared = prepareEvidenceDocument(normalized, f.source, version);
  assert.equal(readEvidenceDocument(prepared.markdown).body, normalized.markdown);
  assert.equal(prepared.frontMatter.source_type, "html");
});

test("historical evidence stays valid after source rename and current pointer changes", async () => {
  const f = await fixture();
  const prepared = prepareEvidenceDocument(f.normalized, f.source, f.version);
  const updated = { ...f.source, title: "Renamed later", currentVersionId: randomUUID() as SourceVersionId };
  assert.doesNotThrow(() => readEvidenceDocument(prepared.markdown, { source: updated, version: prepared.version }));
  assert.equal(prepared.version.document?.title, "Cabinet title");
});

test("foreign identity, tampered hashes, paths and converter data fail cross-validation", async () => {
  const f = await fixture();
  const prepared = prepareEvidenceDocument(f.normalized, f.source, f.version);
  for (const change of [{ source_id: randomUUID() }, { cabinet_id: randomUUID() }, { source_version_id: randomUUID() },
    { sha256: "a".repeat(64) }, { source_version: 2 }, { imported_at: "2026-09-12T10:00:00.000Z" },
    { conversion: { tool: "forged", version: "1" } }, { title: "Changed" }]) {
    assert.throws(() => assertEvidenceMatches(parseEvidenceFrontMatter({ ...prepared.frontMatter, ...change }), f.source, prepared.version));
  }
  assert.throws(() => prepareEvidenceDocument(f.normalized, f.source, { ...f.version, originalPath: "../escape" }), /paths/);
  assert.throws(() => prepareEvidenceDocument({ ...f.normalized, original: { ...f.normalized.original, bytes: new Uint8Array([0]) } }, f.source, f.version), /mismatch/);
});

test("strict header schema rejects lifecycle, bulk entities, unsafe names, malformed metadata and YAML tags", async () => {
  const f = await fixture();
  const prepared = prepareEvidenceDocument(f.normalized, f.source, f.version);
  for (const change of [{ schema_version: 2 }, { status: "current" }, { entities: Array(1000).fill("entity") },
    { original_filename: "../original.md" }, { original_format: "pdf" }, { source_type: "notebook" },
    { title: "bad\nheader" }, { language: "bad language" }, { imported_at: "today" }, { conversion: { tool: "xberg" } }]) {
    assert.throws(() => parseEvidenceFrontMatter({ ...prepared.frontMatter, ...change }));
  }
  assert.throws(() => readEvidenceDocument("---\nschema_version: 1\nschema_version: 1\n---\nBody"));
  assert.throws(() => readEvidenceDocument("---\nvalue: !!js/function function() {}\n---\nBody"));
  assert.throws(() => readEvidenceDocument("---\n" + "x".repeat(65537) + "\n---\nBody"), /header/);
});

test("manifest codec round-trips legacy and enriched versions without duplicate lifecycle state", async () => {
  const f = await fixture();
  const legacy: SourceManifest = { schemaVersion: 1, source: f.source, versions: [f.version] };
  const before = JSON.stringify(legacy);
  assert.deepEqual(decodeSourceManifest(encodeSourceManifest(legacy, f.cabinet), f.cabinet, f.source.rawPath), legacy);
  const prepared = prepareEvidenceDocument(f.normalized, f.source, f.version);
  const enriched = { ...legacy, versions: [prepared.version], extension: { retained: true } };
  const decoded = decodeSourceManifest(encodeSourceManifest(enriched, f.cabinet), f.cabinet, f.source.rawPath);
  assert.deepEqual(decoded, enriched);
  assert.equal(Object.hasOwn(decoded.versions[0], "status"), false);
  assert.equal(JSON.stringify(legacy), before);
});

test("manifest codec rejects malformed document provenance, ownership and cyclic extensions", async () => {
  const f = await fixture();
  const prepared = prepareEvidenceDocument(f.normalized, f.source, f.version);
  const base: SourceManifest = { schemaVersion: 1, source: f.source, versions: [prepared.version] };
  for (const update of [{ document: { ...prepared.version.document, entities: ["forbidden"] } },
    { document: { ...prepared.version.document, sourceType: "pdf" } }, { converter: undefined }, { status: "current" }]) {
    const value = JSON.parse(JSON.stringify({ ...base, versions: [{ ...prepared.version, ...update }] }));
    assert.throws(() => decodeSourceManifest(yaml.dump(value), f.cabinet, f.source.rawPath));
  }
  assert.throws(() => encodeSourceManifest(base, { ...f.cabinet, cabinetId: randomUUID() as CabinetId }), /ownership/);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  assert.throws(() => encodeSourceManifest({ ...base, extension: cyclic } as SourceManifest, f.cabinet), /cyclic/);
});
