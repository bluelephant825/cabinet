import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";

import { DATA_DIR } from "../src/lib/storage/path-utils";
import { buildBlankDocx } from "../src/vendor/genoffice/packages/docx-engine/src/blank";
import { DocumentService } from "../server/documents/service";
import { DocumentBroker } from "../server/documents/broker";
import { handleDocumentsRequest } from "../server/documents/http";
import { revisionOf } from "../src/lib/documents/revision";

process.env.CABINET_DAEMON_TOKEN ??= "test-doc-token";
const TOKEN = process.env.CABINET_DAEMON_TOKEN;

let server: http.Server;
let base: string;
let service: DocumentService;

test.before(async () => {
  service = new DocumentService(new DocumentBroker({ concurrency: 1 }));
  server = http.createServer((req, res) => {
    void handleDocumentsRequest(req, res, service).then((handled) => {
      if (!handled) {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
  await service.shutdown();
});

const auth = (extra?: Record<string, string>) => ({
  authorization: `Bearer ${TOKEN}`,
  ...extra,
});

async function writeFixture(rel: string, bytes: Uint8Array): Promise<string> {
  const abs = path.join(DATA_DIR, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, bytes);
  return abs;
}

test("missing bearer → 401; invalid bearer → 401", async () => {
  const noAuth = await fetch(`${base}/documents/health`);
  assert.equal(noAuth.status, 401);
  const badAuth = await fetch(`${base}/documents/health`, {
    headers: { authorization: "Bearer wrong" },
  });
  assert.equal(badAuth.status, 401);
});

test("PUT /documents/save binary body → 200, byte-identical output", async () => {
  const bytes = await buildBlankDocx();
  const abs = await writeFixture("http/up.docx", bytes);
  const res = await fetch(
    `${base}/documents/save?path=${encodeURIComponent("http/up.docx")}&baseRevision=${encodeURIComponent(revisionOf(bytes))}`,
    { method: "PUT", headers: auth({ "content-type": "application/octet-stream" }), body: bytes as unknown as BodyInit },
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.revision, revisionOf(bytes));
  assert.deepEqual(await fs.readFile(abs), Buffer.from(bytes));
});

test("PUT /documents/save stale revision → 409 with currentRevision", async () => {
  const bytes = await buildBlankDocx();
  const abs = await writeFixture("http/stale.docx", bytes);
  const res = await fetch(
    `${base}/documents/save?path=${encodeURIComponent("http/stale.docx")}&baseRevision=${encodeURIComponent("sha256:stale")}`,
    { method: "PUT", body: bytes as unknown as BodyInit, headers: auth() },
  );
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.code, "conflict");
  assert.equal(body.details.currentRevision, revisionOf(bytes));
  assert.deepEqual(await fs.readFile(abs), Buffer.from(bytes));
});

test("PUT /documents/save over cap → 413, no temp file left", async () => {
  process.env.CABINET_DOC_MAX_BYTES = "16";
  try {
    const bytes = await buildBlankDocx();
    const res = await fetch(
      `${base}/documents/save?path=${encodeURIComponent("http/big.docx")}`,
      { method: "PUT", body: bytes as unknown as BodyInit, headers: auth() },
    );
    assert.equal(res.status, 413);
    const dir = path.join(DATA_DIR, "http");
    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith(".tmp") || f.endsWith(".docwork"));
    assert.deepEqual(leftovers, []);
  } finally {
    delete process.env.CABINET_DOC_MAX_BYTES;
  }
});

test("error bodies contain no absolute paths", async () => {
  const res = await fetch(`${base}/documents/open`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({ virtualPath: "../x.docx" }),
  });
  assert.equal(res.status, 401);
  const text = await res.text();
  assert.equal(text.includes(DATA_DIR), false, `error leaked ${DATA_DIR}: ${text}`);
});

test("POST /documents/open round trip", async () => {
  const bytes = await buildBlankDocx();
  await writeFixture("http/open.docx", bytes);
  const res = await fetch(`${base}/documents/open`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({ virtualPath: "http/open.docx" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.format, "docx");
  assert.ok(body.sessionId);
  assert.equal(body.revision, revisionOf(bytes));
});

test("POST /documents/patch response carries virtualPath", async () => {
  const bytes = await buildBlankDocx();
  await writeFixture("http/patch.docx", bytes);
  const openRes = await fetch(`${base}/documents/open`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({ virtualPath: "http/patch.docx" }),
  });
  const opened = await openRes.json();
  const inspectRes = await fetch(`${base}/documents/inspect`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({ sessionId: opened.sessionId }),
  });
  const inspected = await inspectRes.json();
  const para = inspected.paragraphs[0];
  const patchRes = await fetch(`${base}/documents/patch`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({
      sessionId: opened.sessionId,
      baseRevision: opened.revision,
      ops: [
        {
          kind: "replaceParagraphText",
          paragraphId: para.id,
          expectedText: para.text,
          newText: "patched via http",
        },
      ],
    }),
  });
  assert.equal(patchRes.status, 200);
  const patched = await patchRes.json();
  assert.equal(patched.virtualPath, "http/patch.docx");
  assert.notEqual(patched.revision, opened.revision);
});
