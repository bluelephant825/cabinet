import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import { DATA_DIR } from "@/lib/storage/path-utils";
import { CABINET_MANIFEST_FILE } from "@/lib/cabinets/files";
import { ROOT_CABINET_PATH, normalizeCabinetPath } from "@/lib/cabinets/paths";

/**
 * A "room" is a switchable workspace surfaced in the home-button switcher.
 * Rooms are the top-level cabinets: the root cabinet (`.`) plus every direct
 * child directory of the data dir. Each room is a regular cabinet that gains
 * two optional bits of identity in its `.cabinet` manifest under `room:`:
 *
 *   room:
 *     icon: briefcase     # key into ROOM_ICONS (src/lib/cabinets/room-icons)
 *     theme: paper        # theme name from src/lib/themes
 *
 * Nothing here moves files: rooms are a view over the cabinets that already
 * exist on disk. Folders without a `.cabinet` still appear as rooms with
 * sensible defaults; the manifest is written lazily the first time a user
 * customizes the room (see `updateRoomMeta`).
 */
export interface RoomMeta {
  /** cabinetPath: "." for the root room, else the top-level directory name. */
  path: string;
  /** Display name (manifest `name`, or a humanized directory name). */
  name: string;
  /** Lucide icon key, or null when unset (UI falls back to a default). */
  icon: string | null;
  /** Theme name from src/lib/themes, or null to use the global default. */
  theme: string | null;
  /** Accent color (CSS color string), or null to auto-derive from the path. */
  color: string | null;
  /** True for the default room (the data-dir root cabinet). */
  isRoot: boolean;
}

function humanize(slug: string): string {
  const cleaned = slug.replace(/[-_]+/g, " ").trim();
  if (!cleaned) return "Untitled";
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

async function readManifest(dir: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fs.readFile(path.join(dir, CABINET_MANIFEST_FILE), "utf-8");
    const parsed = yaml.load(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function roomFromManifest(
  cabinetPath: string,
  dirName: string,
  manifest: Record<string, unknown> | null,
  isRoot: boolean
): RoomMeta {
  const room =
    manifest && typeof manifest.room === "object" && manifest.room
      ? (manifest.room as Record<string, unknown>)
      : undefined;
  const manifestName =
    manifest && typeof manifest.name === "string" ? manifest.name.trim() : "";
  const name = manifestName || (isRoot ? "Home" : humanize(dirName));
  const icon = room && typeof room.icon === "string" ? room.icon : null;
  const theme = room && typeof room.theme === "string" ? room.theme : null;
  const color = room && typeof room.color === "string" ? room.color : null;
  return { path: cabinetPath, name, icon, theme, color, isRoot };
}

/** List every room: the root cabinet first, then each top-level directory. */
export async function listRooms(): Promise<RoomMeta[]> {
  const rooms: RoomMeta[] = [
    roomFromManifest(ROOT_CABINET_PATH, "", await readManifest(DATA_DIR), true),
  ];

  let entries: import("fs").Dirent[] = [];
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch {
    return rooms;
  }

  const dirNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const dirName of dirNames) {
    const manifest = await readManifest(path.join(DATA_DIR, dirName));
    rooms.push(roomFromManifest(dirName, dirName, manifest, false));
  }

  return rooms;
}

function resolveRoomDir(normalizedPath: string): string {
  if (normalizedPath === ROOT_CABINET_PATH) return DATA_DIR;
  const resolved = path.resolve(DATA_DIR, normalizedPath);
  // Path-traversal guard (CLAUDE.md key rule 4): never escape the data dir.
  if (resolved !== DATA_DIR && !resolved.startsWith(DATA_DIR + path.sep)) {
    throw new Error("invalid room path");
  }
  return resolved;
}

/**
 * Update a room's identity (name / icon / theme), writing into the cabinet's
 * `.cabinet` manifest. If the directory has no manifest yet, a minimal one is
 * created (lazy "promote folder to room"). `icon`/`theme` set to null clears
 * that field; leaving a key undefined leaves it unchanged.
 */
export async function updateRoomMeta(
  cabinetPath: string,
  patch: {
    name?: string;
    icon?: string | null;
    theme?: string | null;
    color?: string | null;
  }
): Promise<RoomMeta> {
  const normalized =
    normalizeCabinetPath(cabinetPath, true) || ROOT_CABINET_PATH;
  const dir = resolveRoomDir(normalized);
  const isRoot = normalized === ROOT_CABINET_PATH;

  const manifest = (await readManifest(dir)) ?? {};
  // Backfill the canonical cabinet fields so a promoted folder is a valid cabinet.
  if (typeof manifest.schemaVersion !== "number") manifest.schemaVersion = 1;
  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    manifest.name = isRoot ? "Home" : humanize(path.basename(dir));
  }
  if (typeof manifest.kind !== "string") manifest.kind = isRoot ? "root" : "child";
  if (typeof manifest.entry !== "string") manifest.entry = "index.md";

  if (typeof patch.name === "string" && patch.name.trim()) {
    manifest.name = patch.name.trim();
  }

  const room =
    typeof manifest.room === "object" && manifest.room
      ? (manifest.room as Record<string, unknown>)
      : {};
  if (patch.icon !== undefined) {
    if (patch.icon === null) delete room.icon;
    else room.icon = patch.icon;
  }
  if (patch.theme !== undefined) {
    if (patch.theme === null) delete room.theme;
    else room.theme = patch.theme;
  }
  if (patch.color !== undefined) {
    if (patch.color === null) delete room.color;
    else room.color = patch.color;
  }
  manifest.room = room;

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, CABINET_MANIFEST_FILE),
    yaml.dump(manifest, { lineWidth: -1 }),
    "utf-8"
  );

  return roomFromManifest(
    normalized,
    isRoot ? "" : path.basename(dir),
    manifest,
    isRoot
  );
}
