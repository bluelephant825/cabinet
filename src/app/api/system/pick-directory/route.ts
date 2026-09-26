import { spawn } from "child_process";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFAULT_PROMPT = "Select local repository folder";

function sanitizePrompt(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_PROMPT;
  const cleaned = value.replace(/[\r\n]+/g, " ").trim().slice(0, 120);
  return cleaned || DEFAULT_PROMPT;
}

function getPickerCommand(prompt: string): {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
} {
  switch (process.platform) {
    case "darwin": {
      // The prompt is embedded in an AppleScript string literal.
      const escaped = prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      return {
        command: "osascript",
        args: [
          "-e",
          `set chosenFolder to choose folder with prompt "${escaped}"`,
          "-e",
          "POSIX path of chosenFolder",
        ],
      };
    }
    case "win32":
      return {
        command: "powershell",
        args: [
          "-NoProfile",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = $env:CABINET_PICKER_PROMPT; $dialog.UseDescriptionForTitle = $true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $dialog.SelectedPath }",
        ],
        env: { ...process.env, CABINET_PICKER_PROMPT: prompt },
      };
    default:
      return {
        command: "sh",
        args: [
          "-lc",
          'if command -v zenity >/dev/null 2>&1; then zenity --file-selection --directory --title="$CABINET_PICKER_PROMPT"; elif command -v kdialog >/dev/null 2>&1; then kdialog --getexistingdirectory ~ "$CABINET_PICKER_PROMPT"; else exit 127; fi',
        ],
        env: { ...process.env, CABINET_PICKER_PROMPT: prompt },
      };
  }
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as { prompt?: unknown };
    const prompt = sanitizePrompt(body?.prompt);
    const { command, args, env } = getPickerCommand(prompt);

    const selectedPath = await new Promise<string>((resolve, reject) => {
      const proc = spawn(command, args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", reject);

      proc.on("close", (code) => {
        const trimmed = stdout.trim();

        if (code === 0) {
          resolve(trimmed);
          return;
        }

        const combined = `${stdout}\n${stderr}`.toLowerCase();
        if (
          combined.includes("user canceled") ||
          combined.includes("user cancelled") ||
          combined.includes("error number -128")
        ) {
          resolve("");
          return;
        }

        reject(new Error(stderr.trim() || `Command exited with code ${code}`));
      });
    });

    if (!selectedPath) {
      return NextResponse.json({ cancelled: true });
    }

    return NextResponse.json({ ok: true, path: selectedPath });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
