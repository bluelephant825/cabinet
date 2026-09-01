import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { POST } from "./route";

function request(body: string): NextRequest {
  return new NextRequest("http://localhost/api/system/clone-repo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

test("clone-repo route returns 400 for malformed JSON", async () => {
  const response = await POST(request("{"));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Request body must be valid JSON." });
});

test("clone-repo route returns 400 for a disallowed remote protocol", async () => {
  const response = await POST(
    request(
      JSON.stringify({
        remote: "file:///tmp/repository.git",
        destinationParent: "/tmp",
      }),
    ),
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "Only HTTPS and SSH Git repository URLs are allowed.",
  });
});
