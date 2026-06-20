import { NextRequest, NextResponse } from "next/server";
import { spawn } from "child_process";
import fs from "fs/promises";
import path from "path";
import { resolveAuthorizedMountPaths } from "@/lib/knowledge-sources/store";
import { decodeDrivePath } from "@/lib/google-drive/paths";

export const dynamic = "force-dynamic";

/**
 * Reveal a Google Drive file in the OS file manager.
 *
 * macOS:   open -R <path>           → reveals file in Finder
 * Windows: explorer.exe /select,<path> → reveals file in Explorer
 * Linux:   xdg-open <parentDir>     → opens the containing folder
 *
 * Accepts { path: "gdrive:/abs/path" } or { path: "/abs/path" }.
 */
function revealCommand(filePath: string): { command: string; args: string[] } {
  switch (process.platform) {
    case "darwin":
      return { command: "open", args: ["-R", filePath] };
    case "win32":
      return { command: "explorer.exe", args: [`/select,${filePath}`] };
    default:
      // xdg-open doesn't support reveal; open the parent directory instead.
      return { command: "xdg-open", args: [path.dirname(filePath)] };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => null) as { path?: string; cabinet?: string } | null;
    const rawPath = typeof body?.path === "string" ? body.path : "";
    if (!rawPath) {
      return NextResponse.json({ error: "Missing path" }, { status: 400 });
    }
    const cabinet = typeof body?.cabinet === "string" ? body.cabinet : null;

    // Accept both gdrive:-prefixed and plain absolute paths.
    const absPath = decodeDrivePath(rawPath) ?? rawPath;
    const normalized = path.normalize(absPath);

    // Authorize lexically BEFORE touching the filesystem, so an unauthorized
    // path returns 403 without fs.realpath resolving it and leaking host file
    // existence via a 404-vs-403 status oracle. Scoped to the room's connected
    // Drive folders (cabinet), or the union across rooms when none is given.
    const mountPaths = await resolveAuthorizedMountPaths(cabinet);

    const mountNormalized = mountPaths.map((p) => path.normalize(p));
    const inMountLexical = mountNormalized.some(
      (mp) => normalized.startsWith(mp + path.sep) || normalized === mp
    );
    if (!inMountLexical) {
      return NextResponse.json(
        { error: "Path is not within a mounted Google Drive folder" },
        { status: 403 }
      );
    }

    // Resolve symlinks and re-check containment so a symlink inside a mount
    // cannot point outside it.
    let realPath: string;
    try {
      realPath = await fs.realpath(normalized);
    } catch {
      return NextResponse.json({ error: "Path not found" }, { status: 404 });
    }

    const mountRealpaths = await Promise.all(
      mountPaths.map(async (p) => {
        try { return await fs.realpath(p); } catch { return p; }
      })
    );
    const inMount = mountRealpaths.some(
      (mp) => realPath.startsWith(mp + path.sep) || realPath === mp
    );
    if (!inMount) {
      return NextResponse.json(
        { error: "Path is not within a mounted Google Drive folder" },
        { status: 403 }
      );
    }

    const { command, args } = revealCommand(realPath);
    spawn(command, args, { stdio: "ignore", detached: true }).unref();

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
