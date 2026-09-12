import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { SourceNormalizationService, CONVERSION_FORMATS, type SourceFile, type DocumentConverter } from "./normalizers";

const bytes = (text: string) => new TextEncoder().encode(text);
const hash = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const file = (path: string, text: string, assets?: SourceFile["assets"]): SourceFile => {
  const original = bytes(text);
  return { path, bytes: original, contentHash: hash(original), assets };
};
const service = new SourceNormalizationService();

test("Markdown preserves original bytes, prose, front matter and code while normalizing line endings", async () => {
  const text = '\uFEFF---\r\ntitle: Test\r\ndate: 2026-09-11\r\ntags: [one, two]\r\n---\r\n\r\n# Heading\r\n\r\n  Exact **formatting**.\r\n```jsx live\r\nthrow new Error("never execute");\r\n```\r';
  const input = file("notes/Note.MD", text);
  const result = await service.normalize(input);
  assert.deepEqual(result.original.bytes, bytes(text));
  assert.equal(result.original.contentHash, hash(bytes(text)));
  assert.equal(result.original.format, "md");
  assert.equal(result.original.filename, "Note.MD");
  assert.equal(result.original.path, "notes/Note.MD");
  assert.equal(result.markdown, text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
  assert.deepEqual(result.metadata, { title: "Test", date: "2026-09-11", tags: ["one", "two"] });
  assert.deepEqual(result.converter, { name: "cabinet-markdown", version: "1" });
  input.bytes.fill(0);
  assert.deepEqual(result.original.bytes, bytes(text));
});

test("asset normalization rewrites inline, reference and attachment destinations without rewriting prose", async () => {
  const image = bytes("image");
  const pdf = bytes("pdf");
  const text = '[![Picture](../media/pic%20one.png "caption")](../media/report.pdf#page=2)\n\n![Again][pic]\n\n[pic]: <../media/pic one.png> "title"\n\n`![code](../media/pic%20one.png)`\n';
  const result = await service.normalize(file("notes/note.md", text, [
    { path: "media/pic one.png", bytes: image }, { path: "media/report.pdf", bytes: pdf },
  ]));
  assert.equal(result.markdown, `[![Picture](assets/${hash(image)}.png "caption")](assets/${hash(pdf)}.pdf#page=2)\n\n![Again][pic]\n\n[pic]: <assets/${hash(image)}.png> "title"\n\n\`![code](../media/pic%20one.png)\`\n`);
  assert.equal(result.assets.length, 2);
  assert.deepEqual(result.original.assets.map((asset) => asset.path), ["media/pic one.png", "media/report.pdf"]);
  assert.deepEqual(result.warnings, []);
  image.fill(0); pdf.fill(0);
  assert.equal(new TextDecoder().decode(result.assets.find((asset) => asset.path.endsWith(".png"))!.bytes), "image");
});

test("escaped and nested destinations retain titles, query strings, reference labels and line formatting", async () => {
  const asset = bytes("a");
  const text = '![a](./pic\\(1\\).png?size=2#view \'caption\')\n\n[id]: pic(1).png\n';
  const result = await service.normalize(file("note.md", text, [{ path: "pic(1).png", bytes: asset }]));
  assert.equal(result.markdown, `![a](assets/${hash(asset)}.png?size=2#view 'caption')\n\n[id]: assets/${hash(asset)}.png\n`);
});

test("identical assets deduplicate deterministically and unreferenced captured dependencies are retained", async () => {
  const assets = [{ path: "a.png", bytes: bytes("same") }, { path: "b.png", bytes: bytes("same") }, { path: "dep.bin", bytes: bytes("dep") }];
  const input = file("note.md", "![a](a.png) ![b](b.png)", assets);
  const first = await service.normalize(input);
  const second = await service.normalize({ ...input, assets: [...assets].reverse() });
  assert.equal(first.markdown, second.markdown);
  assert.deepEqual(first.assets, second.assets);
  assert.equal(first.assets.length, 2);
});

test("link-like text in labels and titles cannot redirect an asset edit into prose", async () => {
  const asset = bytes("image");
  const target = `assets/${hash(asset)}.png`;
  const cases = [
    ['[a](pic.png \'title ](pic.png)\')', `[a](${target} 'title ](pic.png)')`],
    ['[a](pic.png "title ](pic.png \'x\')")', `[a](${target} "title ](pic.png 'x')")`],
    ['![a \\] b](pic.png)', `![a \\] b](${target})`],
    ['[a `](pic.png)`](pic.png)', `[a \`](pic.png)\`](${target})`],
    ['[id]:\n  <pic.png>\n  "title"', `[id]:\n  <${target}>\n  "title"`],
  ];
  for (const [text, expected] of cases) {
    const result = await service.normalize(file("note.md", text, [{ path: "pic.png", bytes: asset }]));
    assert.equal(result.markdown, expected);
    assert.deepEqual(result.warnings, []);
  }
});

test("uncaptured, escaping, remote, HTML and wiki references remain inert and produce warnings", async () => {
  const text = '![missing](missing.png)\n![escape](../private.png)\n![remote](https://example.invalid/a.png)\n[run](javascript:alert)\n![absolute](/secret.png)\n![bad](%ZZ.png)\n<a href="secret">HTML</a>\n![[vault.png]]\n';
  const result = await service.normalize(file("note.md", text));
  assert.equal(result.markdown, text);
  assert.equal(result.assets.length, 0);
  assert.ok(result.warnings.some((warning) => warning.code === "unresolved-asset"));
  assert.ok(result.warnings.some((warning) => warning.code === "external-reference"));
  assert.ok(result.warnings.some((warning) => warning.code === "unsupported-embed"));
});

test("invalid metadata fails explicitly instead of silently stripping source content", async () => {
  for (const text of ["---\ntitle: [broken\n---\nBody", "---\ntitle: missing close", "---\n- sequence\n---\n", "---\nvalue: !!js/function function() {}\n---\n", "---\ncycle: &a [*a]\n---\n"]) {
    await assert.rejects(service.normalize(file("n.md", text)));
  }
  const result = await service.normalize(file("n.md", "---\n\n---\nBody"));
  assert.deepEqual(result.metadata, {});
  assert.equal(result.markdown, "---\n\n---\nBody");
});

test("hash mismatch, invalid UTF-8, traversal, ambiguous assets and size limits reject normalization", async () => {
  await assert.rejects(service.normalize({ ...file("n.md", "x"), contentHash: "0".repeat(64) }), /hash mismatch/);
  const invalid = new Uint8Array([0xc3, 0x28]);
  await assert.rejects(service.normalize({ path: "n.md", bytes: invalid, contentHash: hash(invalid) }), /encoded data/);
  await assert.rejects(service.normalize(file("../n.md", "x")), /relative path/);
  await assert.rejects(service.normalize(file("n.md", "x", [{ path: "../escape", bytes: bytes("x") }])), /relative path/);
  await assert.rejects(service.normalize(file("n.md", "x", [{ path: "A.png", bytes: bytes("a") }, { path: "a.png", bytes: bytes("b") }])), /ambiguous/);
  const oversized = new Uint8Array(20 * 1024 * 1024 + 1);
  await assert.rejects(service.normalize({ path: "n.md", bytes: oversized, contentHash: hash(oversized) }), /20 MB/);
  await assert.rejects(service.normalize(file("n.md", "x", Array.from({ length: 257 }, (_, i) => ({ path: `${i}.png`, bytes: bytes("") })))), /Too many/);
});

test("all planned document formats dispatch through the converter while Markdown bypasses it", async () => {
  const seen: string[] = [];
  const converter: DocumentConverter = { async convert(input) {
    seen.push(input.path);
    input.bytes.fill(0); // A faulty adapter cannot damage returned original evidence.
    return { markdown: "---\ntitle: Extracted\n---\nBody\r\n![a](images/p.png)", metadata: { language: "en" },
      assets: [{ path: "images/p.png", bytes: bytes("p") }], warnings: ["OCR may be incomplete"], converter: { name: "test-converter", version: "1.2" } };
  } };
  const converted = new SourceNormalizationService(converter);
  for (const extension of CONVERSION_FORMATS) {
    const input = file(`source.${extension.toUpperCase()}`, "original bytes");
    assert.equal(converted.supports(input), true);
    const result = await converted.normalize(input);
    assert.deepEqual(result.original.bytes, bytes("original bytes"));
    assert.equal(result.original.contentHash, input.contentHash);
    assert.equal(result.original.format, extension);
    assert.deepEqual(result.metadata, { language: "en", title: "Extracted" });
    assert.equal(result.assets.length, 1);
    assert.equal(result.warnings[0].message, "OCR may be incomplete");
    assert.deepEqual(result.converter, { name: "test-converter", version: "1.2" });
    assert.ok(result.markdown.endsWith(`Body\n![a](assets/${hash(bytes("p"))}.png)`));
  }
  await converted.normalize(file("native.md", "Markdown"));
  assert.equal(seen.length, CONVERSION_FORMATS.length);
});

test("missing converter, unsupported formats, converter failures and invalid results never fabricate Markdown", async () => {
  await assert.rejects(service.normalize(file("source.pdf", "pdf")), /converter unavailable/);
  for (const extension of ["exe", "mdx", "xyz"]) {
    const input = file(`source.${extension}`, "text");
    assert.equal(service.supports(input), false);
    await assert.rejects(service.normalize(input), /Unsupported source format/);
  }
  const failure = new SourceNormalizationService({ async convert() { throw new Error("Extraction failed"); } });
  await assert.rejects(failure.normalize(file("source.ipynb", "notebook")), /Extraction failed/);
  const invalid = new SourceNormalizationService({ async convert() {
    return { markdown: "Body", assets: [], metadata: {}, warnings: [], converter: { name: "", version: "" } };
  } });
  await assert.rejects(invalid.normalize(file("source.docx", "doc")), /name and version/);
});
