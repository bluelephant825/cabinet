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
      // Get-Clipboard prints via Console.OutputEncoding — force UTF-8 so the
      // bytes decode correctly instead of arriving as mojibake.
      return [
        [
          "powershell",
          [
            "-NoProfile",
            "-Command",
            "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-Clipboard -Raw",
          ],
        ],
      ];
    default:
      return [
        ["wl-paste", ["--no-newline"]],
        ["xclip", ["-selection", "clipboard", "-o"]],
      ];
  }
}

// pbpaste/wl-paste emit bytes in the LOCALE charset, and a LaunchServices- or
// launchd-spawned Cabinet has no LC_*/LANG — C locale means MacRoman bytes that
// decode as U+FFFD ("Norvge"). Pin UTF-8 for the child regardless.
const UTF8_ENV = {
  ...process.env,
  LC_ALL: "en_US.UTF-8",
  LANG: "en_US.UTF-8",
  LC_CTYPE: "UTF-8",
};

export async function readSystemClipboard(): Promise<string> {
  if (readerForTests) return readerForTests();
  if (isCloud()) {
    throw new ClipboardUnavailableError("Clipboard is not available on cloud cabinets.");
  }
  for (const [command, args] of clipboardCommands()) {
    try {
      const { stdout } = await exec(command, args, { env: UTF8_ENV });
      return stdout;
    } catch {
      /* try the next clipboard tool */
    }
  }
  throw new ClipboardUnavailableError("Clipboard is empty or unreadable.");
}
