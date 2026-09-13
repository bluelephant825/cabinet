import test from "node:test";
import assert from "node:assert/strict";
import { isBinaryDocumentWrite } from "../src/lib/documents/policy";

test("isBinaryDocumentWrite", () => {
  assert.equal(isBinaryDocumentWrite(".docx", "text/plain"), true);
  assert.equal(isBinaryDocumentWrite(".docx", null), true);
  assert.equal(isBinaryDocumentWrite(".pdf", null), true);
  assert.equal(isBinaryDocumentWrite(".md", "image/svg+xml"), false);
  assert.equal(isBinaryDocumentWrite(".svg", "image/svg+xml"), false);
  assert.equal(isBinaryDocumentWrite(".md", "application/octet-stream"), true);
  assert.equal(isBinaryDocumentWrite(".md", "text/plain; charset=utf-8"), false);
  assert.equal(isBinaryDocumentWrite(".md", "application/pdf"), true);
  assert.equal(isBinaryDocumentWrite(".md", "application/zip"), true);
  assert.equal(
    isBinaryDocumentWrite(
      ".bin",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    true,
  );
  assert.equal(isBinaryDocumentWrite(".md", "application/json"), false);
  assert.equal(isBinaryDocumentWrite(".md", "application/xml"), false);
  assert.equal(isBinaryDocumentWrite(".md", null), false);
  assert.equal(isBinaryDocumentWrite(".md", ""), false);
});
