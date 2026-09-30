import fs from "fs";
import path from "path";

import { PROJECT_ROOT } from "@/lib/runtime/runtime-config";
import { DATA_PARENT_DIR } from "@/lib/storage/path-utils";
import { documentToolBinDir } from "./tool-shim";

export function genofficeToolArgv(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1],
): string[] {
  const node = process.execPath;
  const envTarget = env.CABINET_GENOFFICE_TOOL?.trim();
  if (envTarget) return [node, envTarget];
  if (argv1) {
    const sibling = path.join(path.dirname(argv1), "genoffice-tool.mjs");
    if (fs.existsSync(sibling)) return [node, sibling];
  }
  const distBundle = path.join(PROJECT_ROOT, "dist", "genoffice-tool.mjs");
  if (fs.existsSync(distBundle)) return [node, distBundle];
  return [
    node,
    path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    "--tsconfig",
    path.join(PROJECT_ROOT, "tsconfig.json"),
    path.join(PROJECT_ROOT, "scripts", "genoffice-tool.ts"),
  ];
}

export interface EnsureGenofficeShimOptions {
  binDir?: string;
  argv?: string[];
  platform?: NodeJS.Platform;
  dataParentDir?: string;
}

export function ensureGenofficeToolShim(options: EnsureGenofficeShimOptions = {}): string {
  const binDir = options.binDir ?? documentToolBinDir();
  const argv = options.argv ?? genofficeToolArgv();
  const platform = options.platform ?? process.platform;
  const dataParent = options.dataParentDir ?? DATA_PARENT_DIR;
  fs.mkdirSync(binDir, { recursive: true });
  const quoted = argv.map((arg) => `"${arg.replace(/"/g, '\\"')}"`).join(" ");
  const posixBody = `#!/bin/sh\nexec env CABINET_DATA_DIR="${dataParent.replace(/"/g, '\\"')}" ${quoted} "$@"\n`;
  const posixPath = path.join(binDir, "genoffice");
  const existing = fs.existsSync(posixPath) ? fs.readFileSync(posixPath, "utf8") : null;
  if (existing !== posixBody) fs.writeFileSync(posixPath, posixBody, { mode: 0o755 });
  else fs.chmodSync(posixPath, 0o755);
  if (platform === "win32") {
    const cmdBody = `@echo off\r\nset "CABINET_DATA_DIR=${dataParent}"\r\n${quoted} %*\r\n`;
    const cmdPath = path.join(binDir, "genoffice.cmd");
    const existingCmd = fs.existsSync(cmdPath) ? fs.readFileSync(cmdPath, "utf8") : null;
    if (existingCmd !== cmdBody) fs.writeFileSync(cmdPath, cmdBody);
  }
  return binDir;
}
