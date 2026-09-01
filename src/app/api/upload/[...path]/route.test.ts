import test from "node:test";
import assert from "node:assert/strict";
import {
  MAX_MULTIPART_BYTES,
  MultipartUploadError,
  parseBoundedMultipartFile,
} from "./multipart";

const URL = "http://127.0.0.1:4000/api/upload/notes";

function assertUploadError(
  error: unknown,
  status: MultipartUploadError["status"]
): boolean {
  assert.ok(error instanceof MultipartUploadError);
  assert.equal(error.status, status);
  return true;
}

test("bounded multipart parser returns the uploaded file", async () => {
  const form = new FormData();
  form.append("file", new File(["audio bytes"], "note.mp3", { type: "audio/mpeg" }));

  const file = await parseBoundedMultipartFile(
    new Request(URL, { method: "POST", body: form })
  );

  assert.equal(file.name, "note.mp3");
  assert.equal(file.type, "audio/mpeg");
  assert.equal(await file.text(), "audio bytes");
});

test("bounded multipart parser rejects oversized Content-Length", async () => {
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.close();
    },
  });
  const req = new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=test",
      "content-length": String(MAX_MULTIPART_BYTES + 1),
    },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    parseBoundedMultipartFile(req),
    (error) => assertUploadError(error, 413)
  );
});

test("bounded multipart parser caps chunked bodies when Content-Length is absent", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_MULTIPART_BYTES + 1));
      controller.close();
    },
  });
  const req = new Request(URL, {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=test" },
    body,
    duplex: "half",
  } as RequestInit & { duplex: "half" });

  await assert.rejects(
    parseBoundedMultipartFile(req),
    (error) => assertUploadError(error, 413)
  );
});

test("bounded multipart parser rejects invalid Content-Length", async () => {
  const req = new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "multipart/form-data; boundary=test",
      "content-length": "not-a-number",
    },
    body: "ignored",
  });

  await assert.rejects(
    parseBoundedMultipartFile(req),
    (error) => assertUploadError(error, 400)
  );
});

test("bounded multipart parser requires a file field", async () => {
  const form = new FormData();
  form.append("description", "missing file");

  await assert.rejects(
    parseBoundedMultipartFile(new Request(URL, { method: "POST", body: form })),
    (error) => assertUploadError(error, 400)
  );
});

test("bounded multipart parser rejects non-multipart requests", async () => {
  const req = new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: "not multipart",
  });

  await assert.rejects(
    parseBoundedMultipartFile(req),
    (error) => assertUploadError(error, 415)
  );
});
