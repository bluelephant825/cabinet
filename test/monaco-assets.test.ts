import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { copyInstalledMonacoAssets } from "../scripts/copy-monaco-assets.mjs";

test("copyInstalledMonacoAssets stages Monaco's AMD runtime under public/monaco/vs", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-monaco-assets-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const source = path.join(root, "node_modules", "monaco-editor", "min", "vs");
  fs.mkdirSync(path.join(source, "editor"), { recursive: true });
  fs.writeFileSync(path.join(source, "loader.js"), "loader");
  fs.writeFileSync(path.join(source, "editor", "editor.main.js"), "editor");

  const destination = copyInstalledMonacoAssets(root);

  assert.equal(destination, path.join(root, "public", "monaco", "vs"));
  assert.equal(fs.readFileSync(path.join(destination, "loader.js"), "utf8"), "loader");
  assert.equal(
    fs.readFileSync(path.join(destination, "editor", "editor.main.js"), "utf8"),
    "editor",
  );
});

test("copyInstalledMonacoAssets fails when the dependency assets are missing", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-monaco-missing-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  assert.throws(() => copyInstalledMonacoAssets(root), /Monaco editor assets not found/);
});
