/**
 * Server-side system clipboard read for `cabinet://new?clipboard=true`.
 * Cloud tenants have no reachable clipboard, so the read is refused there.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isCloud } from "@/lib/cloud/tier";

const exec = promisify(execFile);

export class ClipboardUnavailableError extends Error {}

type ClipboardReader = () => Promise<string>;
let readerForTests: ClipboardReader | null = null;

/** Test hook: stub the clipboard read so route tests don't touch pbpaste. */
export function setClipboardReaderForTests(reader: ClipboardReader | null): void {
  readerForTests = reader;
}

function clipboardCommands(): [string, string[]][] {
  switch (process.platform) {
    case "darwin":
      return [["pbpaste", []]];
    case "win32":
      return [["powershell", ["-NoProfile", "-Command", "Get-Clipboard", "-Raw"]]];
    default:
      return [
        ["wl-paste", ["--no-newline"]],
        ["xclip", ["-selection", "clipboard", "-o"]],
      ];
  }
}

export async function readSystemClipboard(): Promise<string> {
  if (readerForTests) return readerForTests();
  if (isCloud()) {
    throw new ClipboardUnavailableError("Clipboard is not available on cloud cabinets.");
  }
  for (const [command, args] of clipboardCommands()) {
    try {
      const { stdout } = await exec(command, args);
      return stdout;
    } catch {
      /* try the next clipboard tool */
    }
  }
  throw new ClipboardUnavailableError("Clipboard is empty or unreadable.");
}
