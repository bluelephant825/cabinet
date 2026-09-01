import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { NextRequest } from "next/server";
import { DATA_DIR } from "@/lib/storage/path-utils";
import type { MystCompileRequest } from "@/lib/myst/export-compiler";
import {
  createMystExportHandler,
  MAX_MYST_EXPORT_BYTES,
  MAX_MYST_SOURCE_BYTES,
} from "./route";

const ENDPOINT = "http://127.0.0.1:4000/api/export/myst";

function request(query: string): NextRequest {
  return new NextRequest(`${ENDPOINT}?${query}`);
}

async function withSource(
  body: string,
  run: (virtualPath: string, absolutePath: string) => Promise<void>
): Promise<void> {
  const name = `myst-route-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.md`;
  const absolutePath = path.join(DATA_DIR, name);
  await fs.writeFile(absolutePath, body, { flag: "wx" });
  try {
    await run(name, absolutePath);
  } finally {
    await fs.rm(absolutePath, { force: true });
  }
}

test("route compiles each allowlisted format in an OS temp directory and cleans it", async () => {
  await withSource("# Safe export\n", async (virtualPath) => {
    for (const format of ["pdf", "docx", "tex"] as const) {
      let compileRequest: MystCompileRequest | undefined;
      const handler = createMystExportHandler(async (value) => {
        compileRequest = value;
        assert.equal(path.dirname(value.inputPath), value.cwd);
        assert.equal(path.dirname(value.outputPath), value.cwd);
        assert.ok(await fs.stat(value.inputPath));
        await fs.writeFile(value.outputPath, `compiled-${value.format}`);
      });

      const response = await handler(
        request(new URLSearchParams({ path: virtualPath, format }).toString())
      );
      assert.equal(response.status, 200);
      assert.equal(await response.text(), `compiled-${format}`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
      assert.ok(compileRequest);
      assert.equal(compileRequest.format, format);
      await assert.rejects(fs.stat(compileRequest.cwd));
    }
  });
});

test("route rejects unsupported, duplicate, traversal, and non-Markdown requests before compile", async () => {
  let compileCount = 0;
  const handler = createMystExportHandler(async () => {
    compileCount += 1;
  });
  const cases = [
    "path=page.md&format=html",
    "path=page.md&path=other.md&format=pdf",
    "path=page.md&format=pdf&unexpected=true",
    "path=..%2Foutside.md&format=pdf",
    "path=page.txt&format=pdf",
    `path=${"x".repeat(2049)}.md&format=pdf`,
  ];

  for (const query of cases) {
    const response = await handler(request(query));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid export request" });
  }
  assert.equal(compileCount, 0);
});

test("route bounds source and compiler output sizes", async () => {
  await withSource("# resize me\n", async (virtualPath, absolutePath) => {
    await fs.truncate(absolutePath, MAX_MYST_SOURCE_BYTES + 1);
    const sourceResponse = await createMystExportHandler(async () => {
      assert.fail("oversized source must not compile");
    })(request(new URLSearchParams({ path: virtualPath, format: "pdf" }).toString()));
    assert.equal(sourceResponse.status, 413);
  });

  await withSource("# bounded output\n", async (virtualPath) => {
    let temporaryRoot = "";
    const handler = createMystExportHandler(async ({ cwd, outputPath }) => {
      temporaryRoot = cwd;
      await fs.writeFile(outputPath, "x");
      await fs.truncate(outputPath, MAX_MYST_EXPORT_BYTES + 1);
    });
    const response = await handler(
      request(new URLSearchParams({ path: virtualPath, format: "pdf" }).toString())
    );
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: "Export failed" });
    await assert.rejects(fs.stat(temporaryRoot));
  });
});

test("route rejects symlinked output and returns generic compiler errors with cleanup", async () => {
  await withSource("# output safety\n", async (virtualPath) => {
    const outside = path.join(DATA_DIR, `myst-output-${process.pid}-${Date.now()}.pdf`);
    await fs.writeFile(outside, "outside");
    let temporaryRoot = "";
    try {
      const symlinkHandler = createMystExportHandler(async ({ cwd, outputPath }) => {
        temporaryRoot = cwd;
        await fs.symlink(outside, outputPath);
      });
      const symlinkResponse = await symlinkHandler(
        request(new URLSearchParams({ path: virtualPath, format: "pdf" }).toString())
      );
      assert.equal(symlinkResponse.status, 500);
      assert.deepEqual(await symlinkResponse.json(), { error: "Export failed" });
      await assert.rejects(fs.stat(temporaryRoot));

      const failureHandler = createMystExportHandler(async ({ cwd }) => {
        temporaryRoot = cwd;
        throw new Error("secret compiler diagnostics");
      });
      const failureResponse = await failureHandler(
        request(new URLSearchParams({ path: virtualPath, format: "pdf" }).toString())
      );
      assert.equal(failureResponse.status, 500);
      const errorBody = await failureResponse.json();
      assert.deepEqual(errorBody, { error: "Export failed" });
      assert.ok(!JSON.stringify(errorBody).includes("secret"));
      await assert.rejects(fs.stat(temporaryRoot));
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});
