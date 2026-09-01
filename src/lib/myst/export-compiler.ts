import { execFile } from "node:child_process";
import path from "node:path";

export const MYST_TIMEOUT_MS = 120_000;
export const MYST_MAX_LOG_BYTES = 1024 * 1024;

export type MystExportFormat = "pdf" | "docx" | "tex";

export interface MystCompileRequest {
  cwd: string;
  format: MystExportFormat;
  inputPath: string;
  outputPath: string;
}

export interface ExecuteFileOptions {
  cwd: string;
  maxBuffer: number;
  timeout: number;
  windowsHide: boolean;
}

export type ExecuteFile = (
  executable: string,
  args: readonly string[],
  options: ExecuteFileOptions
) => Promise<void>;

function executeFile(
  executable: string,
  args: readonly string[],
  options: ExecuteFileOptions
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(executable, [...args], options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/** Runs the pinned local MyST CLI directly. No shell or package downloader is involved. */
export async function compileMystExport(
  request: MystCompileRequest,
  execute: ExecuteFile = executeFile
): Promise<void> {
  const packageRoot = path.dirname(require.resolve("mystmd/package.json"));
  const cliPath = path.join(packageRoot, "dist", "myst.cjs");
  const input = path.relative(request.cwd, request.inputPath);
  const output = path.relative(request.cwd, request.outputPath);

  if (
    !input ||
    !output ||
    input.startsWith("..") ||
    output.startsWith("..") ||
    path.isAbsolute(input) ||
    path.isAbsolute(output)
  ) {
    throw new Error("MyST paths must stay inside the working directory");
  }

  await execute(
    process.execPath,
    [cliPath, "build", input, `--${request.format}`, "--output", output, "--force", "--ci"],
    {
      cwd: request.cwd,
      timeout: MYST_TIMEOUT_MS,
      maxBuffer: MYST_MAX_LOG_BYTES,
      windowsHide: true,
    }
  );
}
