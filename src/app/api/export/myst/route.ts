import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import {
  compileMystExport,
  type MystCompileRequest,
  type MystExportFormat,
} from "@/lib/myst/export-compiler";
import { DATA_DIR, resolveContentPath } from "@/lib/storage/path-utils";

const EXPORT_FORMATS = ["pdf", "docx", "tex"] as const;
const MAX_VIRTUAL_PATH_CHARS = 2048;
export const MAX_MYST_SOURCE_BYTES = 5 * 1024 * 1024;
export const MAX_MYST_EXPORT_BYTES = 100 * 1024 * 1024;

type CompileMyst = (request: MystCompileRequest) => Promise<void>;

const CONTENT_TYPES: Record<MystExportFormat, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  tex: "application/x-tex; charset=utf-8",
};

function isExportFormat(value: string | null): value is MystExportFormat {
  return EXPORT_FORMATS.includes(value as MystExportFormat);
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readBoundedOutput(filePath: string, expectedRoot: string): Promise<Buffer> {
  const outputStat = await fs.lstat(filePath);
  if (outputStat.isSymbolicLink()) throw new Error("Invalid export output");

  const [realRoot, realFile] = await Promise.all([
    fs.realpath(expectedRoot),
    fs.realpath(filePath),
  ]);
  if (!isInside(realRoot, realFile)) throw new Error("Invalid export output");

  const handle = await fs.open(realFile, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_MYST_EXPORT_BYTES) {
      throw new Error("Invalid export output");
    }

    const output = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < output.length) {
      const { bytesRead } = await handle.read(output, offset, output.length - offset, offset);
      if (bytesRead === 0) throw new Error("Invalid export output");
      offset += bytesRead;
    }
    const trailing = Buffer.allocUnsafe(1);
    if ((await handle.read(trailing, 0, 1, output.length)).bytesRead !== 0) {
      throw new Error("Invalid export output");
    }
    return output;
  } finally {
    await handle.close();
  }
}

function invalidRequest() {
  return NextResponse.json({ error: "Invalid export request" }, { status: 400 });
}

export function createMystExportHandler(compile: CompileMyst = compileMystExport) {
  return async function GET(req: NextRequest) {
    let temporaryRoot: string | null = null;

    try {
      const { searchParams } = new URL(req.url);
      const paths = searchParams.getAll("path");
      const formats = searchParams.getAll("format");
      const virtualPath = paths[0] ?? null;
      const format = formats[0] ?? null;

      if (
        searchParams.size !== 2 ||
        paths.length !== 1 ||
        formats.length !== 1 ||
        !virtualPath ||
        virtualPath.length > MAX_VIRTUAL_PATH_CHARS ||
        !isExportFormat(format)
      ) {
        return invalidRequest();
      }

      let sourcePath: string;
      try {
        sourcePath = resolveContentPath(virtualPath);
      } catch {
        return invalidRequest();
      }
      if (path.extname(sourcePath).toLowerCase() !== ".md") return invalidRequest();

      let sourceStat;
      try {
        sourceStat = await fs.lstat(sourcePath);
      } catch {
        return NextResponse.json({ error: "Page not found" }, { status: 404 });
      }
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
        return NextResponse.json({ error: "Page not found" }, { status: 404 });
      }
      if (sourceStat.size <= 0 || sourceStat.size > MAX_MYST_SOURCE_BYTES) {
        return NextResponse.json({ error: "Page cannot be exported" }, { status: 413 });
      }

      const [realDataDir, realSourcePath] = await Promise.all([
        fs.realpath(DATA_DIR),
        fs.realpath(sourcePath),
      ]);
      if (!isInside(realDataDir, realSourcePath)) return invalidRequest();

      const sourceBytes = await fs.readFile(realSourcePath);
      if (sourceBytes.length !== sourceStat.size || sourceBytes.length > MAX_MYST_SOURCE_BYTES) {
        return NextResponse.json({ error: "Page cannot be exported" }, { status: 413 });
      }
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(sourceBytes);
      } catch {
        return invalidRequest();
      }

      temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-myst-export-"));
      const inputPath = path.join(temporaryRoot, "input.md");
      const outputPath = path.join(temporaryRoot, `output.${format}`);
      await fs.writeFile(inputPath, source, { encoding: "utf8", flag: "wx" });
      await compile({ cwd: temporaryRoot, format, inputPath, outputPath });

      const file = await readBoundedOutput(outputPath, temporaryRoot);
      const sourceBase = path.basename(realSourcePath, path.extname(realSourcePath));
      const safeBase = sourceBase.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120) || "export";
      return new NextResponse(new Uint8Array(file), {
        headers: {
          "Content-Type": CONTENT_TYPES[format],
          "Content-Disposition": `attachment; filename="${safeBase}.${format}"`,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      console.error("MyST export failed");
      return NextResponse.json({ error: "Export failed" }, { status: 500 });
    } finally {
      if (temporaryRoot) {
        await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

export const GET = createMystExportHandler();
