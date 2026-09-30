import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import {
  GenofficeOwnershipError,
  validateGenofficeArgs,
} from "../scripts/genoffice-tool";
import {
  ensureGenofficeToolShim,
  genofficeToolArgv,
} from "../src/lib/documents/genoffice-tool-shim";

const execFileAsync = promisify(execFile);
const TSX = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const TOOL = path.join(process.cwd(), "scripts", "genoffice-tool.ts");

function rejected(args: string[]): boolean {
  try {
    validateGenofficeArgs(args);
    return false;
  } catch (cause) {
    return cause instanceof GenofficeOwnershipError;
  }
}

test("GenOffice ownership guard allows XLSX/PPTX and read-only DOCX commands", () => {
  for (const args of [
    ["sheet", "read", "book.xlsx"],
    ["sheet", "apply", "book.xlsx", "--ops", "ops.json"],
    ["slides", "apply", "deck.pptx", "--ops", "ops.json"],
    ["create", "--type", "xlsx", "--from", "data.csv", "--out", "book.xlsx"],
    ["create", "--type=pptx", "--spec", "slides", "--out", "deck.pptx"],
    ["docs", "check", "report.docx"],
    ["convert", "deck.pptx", "--to", "pdf"],
    ["convert", "book.xlsx", "--to", "csv"],
    ["render", "deck.pptx", "--out", "renders"],
  ]) {
    assert.doesNotThrow(() => validateGenofficeArgs(args));
  }
});

test("GenOffice ownership guard rejects Cabinet-owned writes and unapproved commands", () => {
  for (const args of [
    ["docs", "apply", "report.docx", "--ops", "ops.json"],
    ["create", "--type", "docx", "--from", "report.md", "--out", "report.docx"],
    ["create", "--type", "pdf", "--from", "report.md", "--out", "report.pdf"],
    ["convert", "report.pdf", "--to", "docx"],
    ["convert", "deck.pptx", "--to", "docx"],
    ["convert", "book.xlsx", "--to", "md"],
    ["mcp"],
    ["search", "query"],
  ]) {
    assert.equal(rejected(args), true, args.join(" "));
  }
});

test("guarded launcher pins allowed roots and delegates through the bundled Node", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-genoffice-tool-"));
  try {
    const fake = path.join(dir, "genoffice.cjs");
    await fs.writeFile(
      fake,
      "process.stdout.write(JSON.stringify({args:process.argv.slice(2),roots:process.env.GENOFFICE_ALLOWED_ROOTS,node:process.env.GENOFFICE_NODE,app:process.env.GENOFFICE_APP_BIN}))",
    );
    const { stdout } = await execFileAsync(
      process.execPath,
      [TSX, "--tsconfig", path.join(process.cwd(), "tsconfig.json"), TOOL, "--version", "--json"],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CABINET_GENOFFICE_CLI: fake,
          GENOFFICE_ALLOWED_ROOTS: "/tmp/poisoned",
          GENOFFICE_APP_BIN: "/tmp/poisoned-app",
        },
      },
    );
    const result = JSON.parse(stdout) as { args: string[]; roots: string; node: string; app?: string };
    assert.deepEqual(result.args, ["--version", "--json"]);
    assert.ok(path.isAbsolute(result.roots));
    assert.notEqual(result.roots, "/tmp/poisoned");
    assert.equal(result.node, process.execPath);
    assert.equal(result.app, undefined);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("genoffice shim is idempotent and uses the shared document-tool bin", async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-genoffice-bin-"));
  try {
    const argv = ["/usr/bin/node", "/tmp/genoffice-tool.mjs"];
    ensureGenofficeToolShim({ binDir, argv, dataParentDir: "/tmp/cabinet data" });
    const shim = path.join(binDir, "genoffice");
    const first = await fs.readFile(shim, "utf8");
    assert.match(first, /^#!\/bin\/sh\nexec env CABINET_DATA_DIR=/);
    assert.match(first, /genoffice-tool\.mjs/);
    ensureGenofficeToolShim({ binDir, argv, dataParentDir: "/tmp/cabinet data" });
    assert.equal(await fs.readFile(shim, "utf8"), first);
    assert.equal((await fs.stat(shim)).mode & 0o777, 0o755);
    assert.ok(
      genofficeToolArgv({ ...process.env, CABINET_GENOFFICE_TOOL: "/tmp/custom.mjs" })[1]?.endsWith(
        "custom.mjs",
      ),
    );
  } finally {
    await fs.rm(binDir, { recursive: true, force: true });
  }
});
