import fs from "fs/promises";
import path from "path";
import os from "os";

export interface DriveDesktopResult {
  detected: boolean;
  mountPath: string | null;
}

const HOME = os.homedir();

// Candidate paths in priority order.
// macOS: Drive for Desktop uses CloudStorage with the account email in the dir name.
// macOS legacy: older "Backup and Sync" used ~/Google Drive.
// Windows: %USERPROFILE%\Google Drive\My Drive
const CANDIDATE_GLOBS = [
  // macOS — Drive for Desktop (current)
  path.join(HOME, "Library", "CloudStorage"),
  // macOS — legacy Backup and Sync / Windows — Google Drive for Desktop
  path.join(HOME, "Google Drive", "My Drive"),
  path.join(HOME, "Google Drive"),
  // Windows — alternate install path used by some Drive for Desktop versions
  path.join(HOME, "My Drive"),
  // Linux — rclone default mount or manual mount
  path.join(HOME, "GoogleDrive"),
];

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Resolve the first valid Google Drive mount path.
export async function detectDriveDesktop(): Promise<DriveDesktopResult> {
  // macOS: scan ~/Library/CloudStorage for GoogleDrive-* directories
  const cloudStoragePath = path.join(HOME, "Library", "CloudStorage");
  if (await exists(cloudStoragePath)) {
    try {
      const entries = await fs.readdir(cloudStoragePath);
      const driveEntry = entries.find((e) => e.startsWith("GoogleDrive-"));
      if (driveEntry) {
        const myDrive = path.join(cloudStoragePath, driveEntry, "My Drive");
        if (await exists(myDrive)) {
          return { detected: true, mountPath: myDrive };
        }
        // Some setups mount without "My Drive" subdirectory
        const root = path.join(cloudStoragePath, driveEntry);
        return { detected: true, mountPath: root };
      }
    } catch {
      // ignore readdir errors
    }
  }

  // Remaining static candidates
  for (const candidate of CANDIDATE_GLOBS.slice(1)) {
    if (await exists(candidate)) {
      return { detected: true, mountPath: candidate };
    }
  }

  return { detected: false, mountPath: null };
}

export type CloudProviderId =
  | "google-drive"
  | "icloud"
  | "onedrive"
  | "sharepoint"
  | "dropbox";

const CLOUD_STORAGE = path.join(HOME, "Library", "CloudStorage");

// First ~/Library/CloudStorage/<prefix>* entry (macOS desktop-sync mounts all
// live here as "<Provider>-<account>"). Returns the mount root, or null.
async function findCloudStorage(prefix: string): Promise<string | null> {
  try {
    const entries = await fs.readdir(CLOUD_STORAGE);
    const match = entries.find((e) => e.startsWith(prefix + "-") || e === prefix);
    return match ? path.join(CLOUD_STORAGE, match) : null;
  } catch {
    return null;
  }
}

async function firstExisting(candidates: string[]): Promise<DriveDesktopResult> {
  for (const c of candidates) {
    if (await exists(c)) return { detected: true, mountPath: c };
  }
  return { detected: false, mountPath: null };
}

async function detectICloud(): Promise<DriveDesktopResult> {
  return firstExisting([
    path.join(HOME, "Library", "Mobile Documents", "com~apple~CloudDocs"), // macOS
    path.join(HOME, "iCloudDrive"), // Windows
  ]);
}

async function detectOneDrive(): Promise<DriveDesktopResult> {
  const cs = await findCloudStorage("OneDrive");
  if (cs) return { detected: true, mountPath: cs };
  return firstExisting([path.join(HOME, "OneDrive")]); // Windows
}

async function detectDropbox(): Promise<DriveDesktopResult> {
  const cs = await findCloudStorage("Dropbox");
  if (cs) return { detected: true, mountPath: cs };
  return firstExisting([path.join(HOME, "Dropbox")]);
}

/** Detect a provider's local desktop-sync mount root. */
export async function detectProvider(
  provider: CloudProviderId,
): Promise<DriveDesktopResult> {
  switch (provider) {
    case "icloud":
      return detectICloud();
    case "onedrive":
    case "sharepoint":
      return detectOneDrive();
    case "dropbox":
      return detectDropbox();
    case "google-drive":
    default:
      return detectDriveDesktop();
  }
}

export interface DetectedAccount {
  provider: CloudProviderId;
  /** Human label, e.g. the account email/org parsed from the mount name. */
  account: string;
  root: string;
}

/**
 * Auto-scan all installed desktop-sync providers/accounts at once (PRD §12 P2).
 * Reads ~/Library/CloudStorage/* (one dir per provider-account) plus iCloud,
 * so the picker can offer "connect a detected account" without per-provider
 * probing. Best-effort; returns [] when nothing is installed.
 */
export async function scanCloudStorage(): Promise<DetectedAccount[]> {
  const out: DetectedAccount[] = [];
  const prefixToProvider: Record<string, CloudProviderId> = {
    GoogleDrive: "google-drive",
    OneDrive: "onedrive",
    Dropbox: "dropbox",
    Box: "dropbox", // grouped under generic cloud handling; label still "Box"
  };
  try {
    const entries = await fs.readdir(CLOUD_STORAGE);
    for (const e of entries) {
      const dash = e.indexOf("-");
      const brand = dash > 0 ? e.slice(0, dash) : e;
      const account = dash > 0 ? e.slice(dash + 1) : "";
      const provider = prefixToProvider[brand];
      if (!provider) continue;
      const root =
        provider === "google-drive" &&
        (await exists(path.join(CLOUD_STORAGE, e, "My Drive")))
          ? path.join(CLOUD_STORAGE, e, "My Drive")
          : path.join(CLOUD_STORAGE, e);
      out.push({ provider, account: account || brand, root });
    }
  } catch {
    // CloudStorage dir absent — nothing installed via the modern File Provider.
  }
  const ic = await detectICloud();
  if (ic.mountPath) out.push({ provider: "icloud", account: "iCloud Drive", root: ic.mountPath });
  return out;
}

// Return all top-level subdirectories at a given path (for the folder picker).
export async function listSubdirectories(
  dirPath: string
): Promise<{ name: string; path: string }[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(dirPath, e.name) }));
  } catch {
    return [];
  }
}
