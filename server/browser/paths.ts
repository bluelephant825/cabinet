/**
 * On-disk layout for the Cabinet Browser sidecar.
 *
 *   <appdata>/Browser/
 *     bin/           Chrome for Testing download cache (@puppeteer/browsers)
 *     Profile/       persistent Chromium user-data-dir (cookies, login state)
 *     Extensions/<id> unpacked extension payloads (re-downloaded, never patched)
 *     extensions.json  BrowserExtensionRecord[]
 *     state.json     last tab set + last window bounds (for relaunch restore)
 *
 * <appdata> is CABINET_USER_DATA when set (Electron passes its userData dir);
 * otherwise ~/.cabinet (plain web/CLI mode).
 */
import os from "node:os";
import { join } from "node:path";

export function browserAppDataDir(): string {
  const userData = process.env.CABINET_USER_DATA?.trim();
  if (userData) return join(userData, "Browser");
  return join(os.homedir(), ".cabinet", "browser");
}

export function browserBinDir(): string {
  return join(browserAppDataDir(), "bin");
}

export function browserProfileDir(): string {
  return join(browserAppDataDir(), "Profile");
}

export function extensionsStatePath(): string {
  return join(browserAppDataDir(), "extensions.json");
}

export function browserStatePath(): string {
  return join(browserAppDataDir(), "state.json");
}

export function extensionsDir(): string {
  return join(browserAppDataDir(), "Extensions");
}

export function extensionDirFor(id: string): string {
  return join(extensionsDir(), id);
}

/** cabinet-config.json next to CABINET_USER_DATA (Electron persists it there). */
export function cabinetConfigPath(): string | null {
  const userData = process.env.CABINET_USER_DATA?.trim();
  if (!userData) return null;
  return join(userData, "cabinet-config.json");
}
