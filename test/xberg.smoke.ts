/** Optional real-binary integration check. Set CABINET_XBERG_PATH to xberg 1.1.5.
 * The normal unit suite uses deterministic subprocess fixtures, not downloads.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { createXbergNormalization } from "../server/ingestion/xberg";

const bytes = (text: string) => new TextEncoder().encode(text);
const sha = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

function pdf(): Uint8Array {
  const stream = "BT /F1 18 Tf 30 150 Td (Cabinet evidence) Tj ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let text = "%PDF-1.4\n"; const offsets = [0];
  for (const [i, object] of objects.entries()) { offsets.push(text.length); text += `${i + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return bytes(text);
}

async function office(format: "docx" | "odt" | "pptx"): Promise<Uint8Array> {
  const zip = new JSZip();
  if (format === "odt") {
    zip.file("mimetype", "application/vnd.oasis.opendocument.text");
    zip.file("META-INF/manifest.xml", '<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/></manifest:manifest>');
    zip.file("content.xml", '<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0"><office:body><office:text><text:p>Cabinet evidence</text:p></office:text></office:body></office:document-content>');
  } else {
    const main = format === "docx" ? "word/document.xml" : "ppt/presentation.xml";
    zip.file("[Content_Types].xml", `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${format === "docx" ? "wordprocessingml.document" : "presentationml.presentation"}.main+xml"/></Types>`);
    zip.file("_rels/.rels", `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${main}"/></Relationships>`);
    if (format === "docx") zip.file(main, '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Cabinet evidence</w:t></w:r></w:p></w:body></w:document>');
    else {
      zip.file(main, '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>');
      zip.file("ppt/_rels/presentation.xml.rels", '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>');
      zip.file("ppt/slides/slide1.xml", '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:t>Cabinet evidence</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');
    }
  }
  return zip.generateAsync({ type: "uint8array" });
}

test("real xberg converts HTML, PDF, Office, LaTeX, Typst and notebook evidence", async () => {
  const composed = createXbergNormalization();
  const notebook = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
    { cell_type: "markdown", metadata: {}, source: ["# Cabinet evidence"] },
    { cell_type: "code", metadata: {}, execution_count: null, source: ['raise RuntimeError("Never execute")'],
      outputs: [{ output_type: "display_data", metadata: {}, data: { "image/png": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=" } }] },
  ] };
  const fixtures = [
    ["html", bytes("<html><head><title>Cabinet evidence</title></head><body><h1>Cabinet evidence</h1></body></html>")],
    ["pdf", pdf()], ["docx", await office("docx")], ["odt", await office("odt")], ["pptx", await office("pptx")],
    ["tex", bytes("\\documentclass{article}\n\\begin{document}\n\\section{Cabinet evidence}\nText.\n\\end{document}")],
    ["typ", bytes("= Cabinet evidence\nText.")], ["ipynb", bytes(JSON.stringify(notebook))],
  ] as const;
  try {
    for (const [extension, original] of fixtures) {
      const result = await composed.normalizer.normalize({ path: `document.${extension}`, bytes: original, contentHash: sha(original) });
      assert.match(result.markdown, /Cabinet evidence/, extension);
      assert.deepEqual(result.original.bytes, original, extension);
      assert.deepEqual(result.converter, { name: "xberg", version: "1.1.5" });
      if (extension === "ipynb") { assert.match(result.markdown, /Never execute/); assert.equal(result.assets.length, 1); }
    }
  } finally { await composed.close(); }
});
