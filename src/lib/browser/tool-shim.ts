import fs from "fs";
import path from "path";
import { documentToolBinDir } from "@/lib/documents/tool-shim";
import { DATA_PARENT_DIR } from "@/lib/storage/path-utils";
import { PROJECT_ROOT } from "@/lib/runtime/runtime-config";

/**
 * The `cabinet-browser` helper is how agents drive the Chromium sidecar
 * (open/navigate/extract/screenshot) without going through the Next API. It
 * lives in the same runtime bin dir as `cabinet-documents`, so the existing
 * PATH builders already pick it up.
 */
export function browserToolBinDir(): string {
  return documentToolBinDir();
}

/**
 * How the shim should invoke the tool on this install, as argv fragments.
 * Same resolution order as documentToolArgv():
 *   1. CABINET_BROWSER_TOOL env override (explicit bundle path).
 *   2. `browser-tool.mjs` next to the daemon entrypoint (packaged app).
 *   3. `<repo>/dist/browser-tool.mjs` — produced by postbuild.
 *   4. tsx on the TS source — dev mode, before any build ran.
 */
export function browserToolArgv(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1]
): string[] {
  const node = process.execPath;
  const envTarget = env.CABINET_BROWSER_TOOL?.trim();
  if (envTarget) return [node, envTarget];

  if (argv1) {
    const sibling = path.join(path.dirname(argv1), "browser-tool.mjs");
    if (fs.existsSync(sibling)) return [node, sibling];
  }

  const distBundle = path.join(PROJECT_ROOT, "dist", "browser-tool.mjs");
  if (fs.existsSync(distBundle)) return [node, distBundle];

  return [
    node,
    path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    "--tsconfig",
    path.join(PROJECT_ROOT, "tsconfig.json"),
    path.join(PROJECT_ROOT, "scripts", "browser-tool.ts"),
  ];
}

export interface EnsureBrowserShimOptions {
  binDir?: string;
  argv?: string[];
  platform?: NodeJS.Platform;
  dataParentDir?: string;
}

/** Idempotent `cabinet-browser` launcher writer; see ensureDocumentToolShim. */
export function ensureBrowserToolShim(options: EnsureBrowserShimOptions = {}): string {
  const binDir = options.binDir ?? browserToolBinDir();
  const argv = options.argv ?? browserToolArgv();
  const platform = options.platform ?? process.platform;
  fs.mkdirSync(binDir, { recursive: true });

  const dataParent = options.dataParentDir ?? DATA_PARENT_DIR;
  const quoted = argv.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  const envPrefix = `env CABINET_DATA_DIR="${dataParent.replace(/"/g, '\\"')}" `;
  const posixBody = `#!/bin/sh\nexec ${envPrefix}${quoted} "$@"\n`;
  const posixPath = path.join(binDir, "cabinet-browser");
  const existing = fs.existsSync(posixPath)
    ? fs.readFileSync(posixPath, "utf8")
    : null;
  if (existing !== posixBody) {
    fs.writeFileSync(posixPath, posixBody, { mode: 0o755 });
  } else {
    fs.chmodSync(posixPath, 0o755);
  }

  if (platform === "win32") {
    const cmdBody = `@echo off\r\nset "CABINET_DATA_DIR=${dataParent}"\r\n${quoted} %*\r\n`;
    const cmdPath = path.join(binDir, "cabinet-browser.cmd");
    const existingCmd = fs.existsSync(cmdPath)
      ? fs.readFileSync(cmdPath, "utf8")
      : null;
    if (existingCmd !== cmdBody) {
      fs.writeFileSync(cmdPath, cmdBody);
    }
  }

  return binDir;
}
