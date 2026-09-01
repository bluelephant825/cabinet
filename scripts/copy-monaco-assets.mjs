#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function copyMonacoAssets({ source, destination }) {
  if (!fs.existsSync(source)) {
    throw new Error(`Monaco editor assets not found at ${source}`);
  }

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true });
}

export function copyInstalledMonacoAssets(root = process.cwd()) {
  const source = path.join(root, "node_modules", "monaco-editor", "min", "vs");
  const destination = path.join(root, "public", "monaco", "vs");
  copyMonacoAssets({ source, destination });
  return destination;
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const destination = copyInstalledMonacoAssets();
  console.log(`[cabinet] Monaco editor assets copied to ${path.relative(process.cwd(), destination)}/`);
}
