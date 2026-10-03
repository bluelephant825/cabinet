import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Native "open file" picker, mirroring pick-directory but for a single file.
 * Returns the chosen file's absolute path so callers can hand it to a server
 * route by path (no HTTP upload). `?ext=zip` filters by extension.
 */
function startPicker(
  ext: string,
  title: string
): ChildProcessByStdio<null, Readable, Readable> {
  switch (process.platform) {
    case "darwin":
      return spawn(
        "osascript",
        [
          "-e",
          ext
            ? `set chosenFile to choose file with prompt "${title}" of type {"${ext}"}`
            : `set chosenFile to choose file with prompt "${title}"`,
          "-e",
          "POSIX path of chosenFile",
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    case "win32":
      return spawn(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.OpenFileDialog; ${
            ext ? `$d.Filter = '${ext.toUpperCase()} (*.${ext})|*.${ext}';` : ""
          } $d.Title = '${title}'; if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
    default:
      return spawn(
        "sh",
        [
          "-lc",
          `if command -v zenity >/dev/null 2>&1; then zenity --file-selection ${
            ext ? `--file-filter='*.${ext}'` : ""
          } --title='${title}'; elif command -v kdialog >/dev/null 2>&1; then kdialog --getopenfilename ~ '${
            ext ? `*.${ext}` : "*"
          }'; else exit 127; fi`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
  }
}

export async function POST(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const ext = (searchParams.get("ext") || "").replace(/[^a-z0-9]/gi, "");
    const title = "Select your Notion export (.zip)";

    const selectedPath = await new Promise<string>((resolve, reject) => {
      const proc = startPicker(ext, title);
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
      proc.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
      proc.on("error", reject);
      proc.on("close", (code) => {
        const trimmed = stdout.trim();
        if (code === 0) return resolve(trimmed);
        const combined = `${stdout}\n${stderr}`.toLowerCase();
        if (
          combined.includes("user canceled") ||
          combined.includes("user cancelled") ||
          combined.includes("error number -128")
        ) {
          return resolve("");
        }
        reject(new Error(stderr.trim() || `Command exited with code ${code}`));
      });
    });

    if (!selectedPath) return NextResponse.json({ cancelled: true });
    return NextResponse.json({ ok: true, path: selectedPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
