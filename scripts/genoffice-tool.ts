import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_DIR } from "@/lib/storage/path-utils";

export class GenofficeOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GenofficeOwnershipError";
  }
}

function option(args: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function extension(value: string | undefined): string {
  return value ? path.extname(value).slice(1).toLowerCase() : "";
}

export function validateGenofficeArgs(args: readonly string[]): void {
  const positionals = args.filter((arg) => !arg.startsWith("-"));
  const command = positionals[0];
  if (!command || command === "help") return;
  if (command === "docs") {
    const subcommand = positionals[1];
    if (subcommand !== "read" && subcommand !== "check") {
      throw new GenofficeOwnershipError(
        "Cabinet owns DOCX writes. Use cabinet-documents inspect/read/patch/docx-save instead.",
      );
    }
    return;
  }
  if (command === "sheet") {
    if (!["read", "apply", "check"].includes(positionals[1] ?? "")) {
      throw new GenofficeOwnershipError("Only genoffice sheet read/apply/check are enabled in Cabinet.");
    }
    return;
  }
  if (command === "slides") {
    if (!["read", "apply", "check", "replace"].includes(positionals[1] ?? "")) {
      throw new GenofficeOwnershipError(
        "Only genoffice slides read/apply/check/replace are enabled in Cabinet.",
      );
    }
    return;
  }
  if (command === "create") {
    const type = option(args, "type")?.toLowerCase();
    if (type !== "xlsx" && type !== "pptx") {
      throw new GenofficeOwnershipError(
        "Cabinet allows genoffice create only for XLSX and PPTX. Use cabinet-documents for DOCX, PDF and PDFCN writes.",
      );
    }
    return;
  }
  if (command === "convert") {
    const input = positionals[1];
    const source = extension(input);
    const target = option(args, "to")?.toLowerCase() ?? "";
    const allowed =
      (source === "xlsx" && (target === "csv" || target === "pdf")) ||
      (source === "pptx" && target === "pdf");
    if (!allowed) {
      throw new GenofficeOwnershipError(
        "Cabinet allows genoffice conversion only from XLSX to CSV/PDF or PPTX to PDF. Use cabinet-documents for DOCX and Markdown conversions.",
      );
    }
    return;
  }
  if (["info", "render", "guide", "merge"].includes(command)) return;
  throw new GenofficeOwnershipError(
    `The genoffice command '${command}' is not enabled by Cabinet's guarded launcher.`,
  );
}

function cliPath(explicit = process.env.CABINET_GENOFFICE_CLI): string | null {
  const candidates: string[] = [];
  if (explicit?.trim()) candidates.push(explicit.trim());
  const here = path.dirname(fileURLToPath(import.meta.url));
  candidates.push(
    path.resolve(here, "..", "documents", "genoffice", "cli", "genoffice.cjs"),
    path.resolve(process.cwd(), "resources", "documents", "genoffice", "cli", "genoffice.cjs"),
  );
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/GenOffice.app/Contents/Resources/cli/genoffice.cjs",
      path.join(os.homedir(), "Applications", "GenOffice.app", "Contents", "Resources", "cli", "genoffice.cjs"),
    );
  } else if (process.platform === "win32") {
    if (process.env.LOCALAPPDATA) {
      candidates.push(
        path.join(process.env.LOCALAPPDATA, "Programs", "GenOffice", "resources", "cli", "genoffice.cjs"),
      );
    }
  } else {
    candidates.push("/opt/GenOffice/resources/cli/genoffice.cjs");
  }
  for (const candidate of candidates) {
    const resolved = existsSync(candidate) && statSync(candidate).isDirectory()
      ? path.join(candidate, "genoffice.cjs")
      : candidate;
    if (existsSync(resolved)) return resolved;
  }
  return null;
}

function pdfiumPath(): string | undefined {
  try {
    return createRequire(import.meta.url).resolve("@embedpdf/pdfium/pdfium.wasm");
  } catch {
    return undefined;
  }
}

function xlsxSidecarPath(): string | undefined {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const relative = path.join("xlsx", `${process.platform}-${process.arch}`, `xlsx-sidecar${suffix}`);
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(here, "..", "documents", relative),
    path.resolve(process.cwd(), "resources", "documents", relative),
    ...(process.env.CABINET_DOC_RESOURCES_DIR
      ? [path.join(process.env.CABINET_DOC_RESOURCES_DIR, relative)]
      : []),
    ...(process.env.CABINET_XLSX_SIDECAR ? [process.env.CABINET_XLSX_SIDECAR] : []),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function fail(message: string, json: boolean, code: number): never {
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ status: "error", code, error: code === 4 ? "app_not_available" : "ownership_guard", message })}\n`,
    );
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exit(code);
}

export function runGenoffice(args = process.argv.slice(2)): never {
  const json = args.includes("--json");
  try {
    validateGenofficeArgs(args);
  } catch (cause) {
    fail(cause instanceof Error ? cause.message : String(cause), json, 1);
  }
  const cli = cliPath();
  if (!cli) {
    fail(
      "GenOffice CLI is not available. Package a prebuilt with CABINET_GENOFFICE_PREBUILT or install GenOffice on this host.",
      json,
      4,
    );
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    "GENOFFICE_ALLOWED_ROOTS",
    "GENOFFICE_APP_BIN",
    "GENOFFICE_NODE",
    "GENOFFICE_PDFIUM_WASM",
    "XLSX_SIDECAR_PATH",
  ]) {
    delete env[key];
  }
  env.GENOFFICE_NODE = process.execPath;
  env.GENOFFICE_ALLOWED_ROOTS = path.resolve(DATA_DIR);
  const pdfium = pdfiumPath();
  if (pdfium) env.GENOFFICE_PDFIUM_WASM = pdfium;
  const sidecar = xlsxSidecarPath();
  if (sidecar) env.XLSX_SIDECAR_PATH = sidecar;
  const result = spawnSync(process.execPath, [cli, ...args], { env, stdio: "inherit" });
  if (result.error) fail(result.error.message, json, 4);
  process.exit(result.status ?? 4);
}

if (process.argv[1] && /^genoffice-tool\.(?:ts|mjs)$/.test(path.basename(process.argv[1]))) {
  runGenoffice();
}
