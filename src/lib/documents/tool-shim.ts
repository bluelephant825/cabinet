import fs from "fs";
import path from "path";
import { CABINET_INTERNAL_DIR, DATA_PARENT_DIR } from "@/lib/storage/path-utils";
import { PROJECT_ROOT } from "@/lib/runtime/runtime-config";

/**
 * The `cabinet-documents` helper is how agents reach the document service
 * (inspect/read/patch/convert) without going through the Next API. The
 * daemon materializes a tiny launcher under `<data-parent>/.cabinet-state/bin/`
 * on boot and both runtime PATH builders prepend that dir, so a spawned CLI
 * can just run `cabinet-documents ...`.
 */

export function documentToolBinDir(): string {
  return path.join(CABINET_INTERNAL_DIR, "bin");
}

/**
 * How the shim should invoke the tool on this install, as argv fragments.
 * Resolution order:
 *   1. CABINET_DOCUMENT_TOOL env override (explicit bundle path).
 *   2. `document-tool.mjs` next to the daemon entrypoint — the Electron
 *      package stages it beside cabinet-daemon.cjs.
 *   3. `<repo>/dist/document-tool.mjs` — produced by postbuild.
 *   4. tsx on the TS source — dev mode, before any build ran.
 */
export function documentToolArgv(
  env: NodeJS.ProcessEnv = process.env,
  argv1: string | undefined = process.argv[1]
): string[] {
  const node = process.execPath;
  const envTarget = env.CABINET_DOCUMENT_TOOL?.trim();
  if (envTarget) return [node, envTarget];

  if (argv1) {
    const sibling = path.join(path.dirname(argv1), "document-tool.mjs");
    if (fs.existsSync(sibling)) return [node, sibling];
  }

  const distBundle = path.join(PROJECT_ROOT, "dist", "document-tool.mjs");
  if (fs.existsSync(distBundle)) return [node, distBundle];

  // Dev fallback: tsx on the TS source. --tsconfig is explicit because the
  // agent's cwd is the data dir, not the repo — tsx only discovers path
  // aliases from a tsconfig it can find.
  return [
    node,
    path.join(PROJECT_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
    "--tsconfig",
    path.join(PROJECT_ROOT, "tsconfig.json"),
    path.join(PROJECT_ROOT, "scripts", "document-tool.ts"),
  ];
}

export interface EnsureShimOptions {
  binDir?: string;
  argv?: string[];
  platform?: NodeJS.Platform;
  /** Data-parent dir to pin into the shim env; defaults to this process's. */
  dataParentDir?: string;
}

/**
 * Idempotent launcher writer. Returns the bin dir so callers can prepend it
 * to a PATH list. On POSIX writes `cabinet-documents` (0755); on Windows a
 * `cabinet-documents.cmd` beside it.
 */
export function ensureDocumentToolShim(options: EnsureShimOptions = {}): string {
  const binDir = options.binDir ?? documentToolBinDir();
  const argv = options.argv ?? documentToolArgv();
  const platform = options.platform ?? process.platform;
  fs.mkdirSync(binDir, { recursive: true });

  // PROJECT_ROOT is process.cwd() in dev — an agent's cwd is inside the data
  // dir, so without this pin the tool resolves a bogus data parent and its
  // own (wrong) daemon token. CABINET_DATA_DIR is the data-PARENT dir.
  const dataParent = options.dataParentDir ?? DATA_PARENT_DIR;
  const quoted = argv.map((a) => `"${a.replace(/"/g, '\\"')}"`).join(" ");
  const envPrefix = `env CABINET_DATA_DIR="${dataParent.replace(/"/g, '\\"')}" `;
  const posixBody = `#!/bin/sh\nexec ${envPrefix}${quoted} "$@"\n`;
  const posixPath = path.join(binDir, "cabinet-documents");
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
    const cmdPath = path.join(binDir, "cabinet-documents.cmd");
    const existingCmd = fs.existsSync(cmdPath)
      ? fs.readFileSync(cmdPath, "utf8")
      : null;
    if (existingCmd !== cmdBody) {
      fs.writeFileSync(cmdPath, cmdBody);
    }
  }

  return binDir;
}
