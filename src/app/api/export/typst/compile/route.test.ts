import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { MAX_TYPST_SOURCE_BYTES } from "./compiler";
import { POST } from "./route";

const URL = "http://127.0.0.1:4000/api/export/typst/compile";

function request(body: string) {
  return new NextRequest(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("Typst compile route rejects malformed and missing source", async () => {
  assert.equal((await POST(request("{"))).status, 400);
  assert.equal((await POST(request(JSON.stringify({})))).status, 400);
});

test("Typst compile route rejects oversized source before spawning Typst", async () => {
  const response = await POST(request(JSON.stringify({ code: "x".repeat(MAX_TYPST_SOURCE_BYTES + 1) })));
  assert.equal(response.status, 413);
  assert.match((await response.json()).error, /too large/);
});
