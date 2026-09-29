import { NextRequest, NextResponse } from "next/server";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import path from "path";
import fs from "fs/promises";
import { existsSync } from "fs";

const execFileAsync = promisify(execFile);

export async function POST(req: NextRequest) {
  let tempDir: string | undefined;
  try {
    const { code } = await req.json();
    if (typeof code !== "string") {
      return NextResponse.json({ error: "Missing code parameter" }, { status: 400 });
    }

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-typst-"));

    const sourceFile = path.join(tempDir, "document.typ");
    const outputFile = path.join(tempDir, "document.pdf");

    await fs.writeFile(sourceFile, code, "utf8");

    // Run the installed native Typst CLI.
    try {
      await execFileAsync("typst", ["compile", "document.typ", "document.pdf"], {
        cwd: tempDir,
        env: {
          ...process.env,
          PATH: [
            process.env.PATH,
            path.join(process.cwd(), "node_modules", ".bin"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
          ].filter(Boolean).join(path.delimiter),
        },
      });
    } catch (error) {
      const compileError = error as { stderr?: string; message?: string };
      const errMessage = compileError.stderr || compileError.message || "";
      return NextResponse.json({
        error: `Typst compilation failed. Please make sure Typst is installed on your system (e.g. brew install typst). Details: ${errMessage}`
      }, { status: 500 });
    }

    if (!existsSync(outputFile)) {
      return NextResponse.json({ error: "Compiled PDF not found" }, { status: 500 });
    }

    const pdfBuffer = await fs.readFile(outputFile);

    return new NextResponse(pdfBuffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": "inline; filename=\"document.pdf\"",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Compilation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    if (tempDir) {
      // Clean up
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
