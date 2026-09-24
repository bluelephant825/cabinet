import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import { DATA_DIR } from "@/lib/storage/path-utils";
import {
  ClipboardUnavailableError,
  setClipboardReaderForTests,
} from "@/lib/clipper/read-clipboard";

type Route = typeof import("./route");
let route: Route;

before(async () => {
  route = await import("./route");
});

after(() => setClipboardReaderForTests(null));

const URL = "http://127.0.0.1:4000/api/clip";

function post(body: unknown): NextRequest {
  return new NextRequest(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("a non-cabinet uri is rejected with 400", async () => {
  const res = await route.POST(
    post({ uri: "obsidian://new?file=Clips/Nope&content=x" }),
  );
  assert.equal(res.status, 400);
});

test("a body without uri or file+markdown is rejected with 400", async () => {
  const res = await route.POST(post({ nope: true }));
  assert.equal(res.status, 400);
});

test("a uri with no content and no clipboard flag is rejected with 400", async () => {
  const res = await route.POST(post({ uri: "cabinet://new?file=Clips/Nada" }));
  assert.equal(res.status, 400);
});

test("content param saves the page and returns 200", async () => {
  const uri =
    "cabinet://new?file=Clips/Route Clip&content=" +
    encodeURIComponent("---\ntitle: Route Clip\n---\n# hi");
  const res = await route.POST(post({ uri }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.path, "Clips/Route Clip");
  assert.equal(body.title, "Route Clip");
  assert.equal(body.silent, false);
  assert.ok(
    fs.existsSync(path.join(DATA_DIR, "Clips", "Route Clip.md")),
    "page file should exist under DATA_DIR",
  );
});

test("clipboard=true with a failing reader returns 422", async () => {
  setClipboardReaderForTests(async () => {
    throw new ClipboardUnavailableError("no clipboard");
  });
  const res = await route.POST(
    post({ uri: "cabinet://new?file=Clips/Clip Fail&clipboard=true" }),
  );
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.errorKind, "clipboard");
});

test("clipboard=true with a stubbed reader saves the page", async () => {
  setClipboardReaderForTests(async () => "---\ntitle: From Clipboard\n---\nhi");
  const res = await route.POST(
    post({ uri: "cabinet://new?file=Clips/Clip OK&clipboard=true&silent=true" }),
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.path, "Clips/Clip OK");
  assert.equal(body.title, "From Clipboard");
  assert.equal(body.silent, true);
});

test("clipboard=true with empty clipboard text returns 422", async () => {
  setClipboardReaderForTests(async () => "   ");
  const res = await route.POST(
    post({ uri: "cabinet://new?file=Clips/Clip Empty&clipboard=true" }),
  );
  assert.equal(res.status, 422);
});
