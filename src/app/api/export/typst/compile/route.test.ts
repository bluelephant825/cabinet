import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

type Route = typeof import("./route");
let route: Route;

before(async () => {
  route = await import("./route");
});

let nativeTypstAvailable = true;
try {
  execFileSync("typst", ["--version"], { stdio: "ignore" });
} catch {
  nativeTypstAvailable = false;
}

function post(body: unknown): NextRequest {
  return new NextRequest("http://127.0.0.1:4000/api/export/typst/compile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function listTypstTempDirs(): Promise<string[]> {
  const matches: string[] = [];
  for (const [root, prefix] of [
    [os.tmpdir(), "cabinet-typst-"],
    [path.join(process.cwd(), "tmp"), "typst-comp-"],
  ]) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    matches.push(
      ...entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
        .map((entry) => path.join(root, entry.name)),
    );
  }
  return matches.sort();
}

test("missing code remains a 400 response", async () => {
  const response = await route.POST(post({}));
  assert.equal(response.status, 400);
});

test(
  "native Typst compiles with a restricted PATH",
  { skip: !nativeTypstAvailable },
  async () => {
    const beforeDirs = await listTypstTempDirs();
    const originalPath = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const response = await route.POST(
        post({ code: "#set page(width: 100pt, height: 100pt)\nHello" }),
      );
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("content-type"), "application/pdf");
      const pdf = Buffer.from(await response.arrayBuffer());
      assert.equal(pdf.subarray(0, 4).toString(), "%PDF");
      assert.deepEqual(await listTypstTempDirs(), beforeDirs);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  },
);

test(
  "invalid Typst returns 500 and leaves no temporary directories",
  { skip: !nativeTypstAvailable },
  async () => {
    const beforeDirs = await listTypstTempDirs();
    const response = await route.POST(post({ code: "#let =" }));
    assert.equal(response.status, 500);
    const body = await response.json();
    assert.match(body.error, /Typst compilation failed.*Details:/s);
    assert.deepEqual(await listTypstTempDirs(), beforeDirs);
  },
);
