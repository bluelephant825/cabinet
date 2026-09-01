import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compileTypstSource,
  MAX_TYPST_SOURCE_BYTES,
  TYPST_COMPILE_TIMEOUT_MS,
  typstErrorMessage,
  validateTypstSource,
} from "./compiler";

test("compileTypstSource invokes Typst without a shell and removes its temp directory", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-typst-test-"));
  let compileDir = "";
  try {
    const pdf = await compileTypstSource("= Hello", {
      tempRoot,
      runTypst: async (args, options) => {
        compileDir = options.cwd;
        assert.deepEqual(args, ["compile", "--root", compileDir, "document.typ", "document.pdf"]);
        assert.equal(options.timeout, TYPST_COMPILE_TIMEOUT_MS);
        assert.equal(await fs.readFile(path.join(compileDir, "document.typ"), "utf8"), "= Hello");
        await fs.writeFile(path.join(compileDir, "document.pdf"), "%PDF-test");
      },
    });
    assert.equal(pdf.toString(), "%PDF-test");
    await assert.rejects(fs.access(compileDir));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("compileTypstSource removes its temp directory after compiler failure", async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-typst-test-"));
  let compileDir = "";
  try {
    await assert.rejects(
      compileTypstSource("= Broken", {
        tempRoot,
        runTypst: async (_args, options) => {
          compileDir = options.cwd;
          throw new Error("bad syntax");
        },
      }),
      /bad syntax/
    );
    await assert.rejects(fs.access(compileDir));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test("Typst source and diagnostics are bounded", () => {
  assert.throws(() => validateTypstSource(undefined), /Missing code parameter/);
  assert.throws(() => validateTypstSource("x".repeat(MAX_TYPST_SOURCE_BYTES + 1)), /too large/);
  assert.equal(typstErrorMessage({ killed: true }), "Typst compilation timed out");
  assert.match(typstErrorMessage({ code: "ENOENT" }), /not installed/);
  assert.equal(typstErrorMessage({ stderr: "x".repeat(9_000) }).length, 8_000);
});
