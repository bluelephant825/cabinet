import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  compileMystExport,
  MYST_MAX_LOG_BYTES,
  MYST_TIMEOUT_MS,
  type ExecuteFile,
} from "./export-compiler";

test("compileMystExport invokes the pinned CLI with argv and hard process bounds", async () => {
  const cwd = path.join(path.sep, "tmp", "myst work;echo unsafe");
  const calls: Parameters<ExecuteFile>[] = [];
  const execute: ExecuteFile = async (...args) => {
    calls.push(args);
  };

  await compileMystExport(
    {
      cwd,
      format: "docx",
      inputPath: path.join(cwd, "input.md"),
      outputPath: path.join(cwd, "output.docx"),
    },
    execute
  );

  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0];
  assert.equal(executable, process.execPath);
  assert.deepEqual(args.slice(1), [
    "build",
    "input.md",
    "--docx",
    "--output",
    "output.docx",
    "--force",
    "--ci",
  ]);
  assert.equal(path.basename(args[0]), "myst.cjs");
  assert.ok(args[0].includes(`${path.sep}node_modules${path.sep}mystmd${path.sep}`));
  assert.deepEqual(options, {
    cwd,
    timeout: MYST_TIMEOUT_MS,
    maxBuffer: MYST_MAX_LOG_BYTES,
    windowsHide: true,
  });
});

test("compileMystExport rejects input or output paths outside its working directory", async () => {
  let invoked = false;
  const execute: ExecuteFile = async () => {
    invoked = true;
  };
  const cwd = path.join(path.sep, "tmp", "myst-safe");

  await assert.rejects(
    compileMystExport(
      {
        cwd,
        format: "pdf",
        inputPath: path.join(cwd, "input.md"),
        outputPath: path.join(cwd, "..", "escaped.pdf"),
      },
      execute
    )
  );
  assert.equal(invoked, false);
});
