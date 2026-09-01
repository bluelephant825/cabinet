import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const MAX_TYPST_SOURCE_BYTES = 1_000_000;
export const MAX_TYPST_PDF_BYTES = 25_000_000;
export const TYPST_COMPILE_TIMEOUT_MS = 15_000;
const MAX_DIAGNOSTIC_BYTES = 64_000;

type RunTypst = (args: string[], options: {
  cwd: string;
  timeout: number;
  maxBuffer: number;
}) => Promise<void>;

function defaultRunTypst(args: string[], options: {
  cwd: string;
  timeout: number;
  maxBuffer: number;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile("typst", args, {
      cwd: options.cwd,
      timeout: options.timeout,
      maxBuffer: options.maxBuffer,
      windowsHide: true,
    }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export function validateTypstSource(source: unknown): string {
  if (typeof source !== "string") {
    throw new TypeError("Missing code parameter");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_TYPST_SOURCE_BYTES) {
    throw new RangeError("Typst source is too large");
  }
  return source;
}

export async function compileTypstSource(
  source: string,
  options: { tempRoot?: string; runTypst?: RunTypst } = {}
): Promise<Buffer> {
  validateTypstSource(source);
  const tempDir = await fs.mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "cabinet-typst-"));
  const sourceFile = path.join(tempDir, "document.typ");
  const outputFile = path.join(tempDir, "document.pdf");

  try {
    await fs.writeFile(sourceFile, source, { encoding: "utf8", flag: "wx" });
    await (options.runTypst ?? defaultRunTypst)(
      ["compile", "--root", tempDir, "document.typ", "document.pdf"],
      {
        cwd: tempDir,
        timeout: TYPST_COMPILE_TIMEOUT_MS,
        maxBuffer: MAX_DIAGNOSTIC_BYTES,
      }
    );

    const stat = await fs.stat(outputFile);
    if (!stat.isFile() || stat.size > MAX_TYPST_PDF_BYTES) {
      throw new Error(stat.size > MAX_TYPST_PDF_BYTES ? "Compiled PDF is too large" : "Compiled PDF not found");
    }
    return await fs.readFile(outputFile);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function typstErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; killed?: unknown; stderr?: unknown; message?: unknown };
    if (value.killed) return "Typst compilation timed out";
    if (value.code === "ENOENT") return "Typst is not installed. Install the Typst CLI to preview .typ files.";
    const detail = typeof value.stderr === "string"
      ? value.stderr
      : typeof value.message === "string" ? value.message : "Typst compilation failed";
    return detail.slice(0, 8_000);
  }
  return "Typst compilation failed";
}
