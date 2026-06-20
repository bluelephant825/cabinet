import { NextRequest, NextResponse } from "next/server";
import fs from "fs/promises";
import path from "path";
import { resolveAuthorizedMountPaths } from "@/lib/knowledge-sources/store";
import { decodeDrivePath } from "@/lib/google-drive/paths";

const MIME_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".md": "text/markdown; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".csv": "text/csv; charset=utf-8",
  ".ipynb": "application/json",
};

function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || "application/octet-stream";
}


export async function GET(request: NextRequest) {
  try {
    const { searchParams } = request.nextUrl;
    const encodedPath = searchParams.get("path");
    if (!encodedPath) {
      return NextResponse.json({ error: "path parameter required" }, { status: 400 });
    }

    // Accept both a raw gdrive: prefixed path and a plain absolute path
    const absPath = decodeDrivePath(encodedPath) ?? encodedPath;

    // Prevent path traversal
    const normalized = path.normalize(absPath);
    if (normalized.includes("..")) {
      return NextResponse.json({ error: "Invalid path" }, { status: 400 });
    }

    // Authorize lexically BEFORE touching the filesystem, so an unauthorized
    // path returns 403 without fs.realpath resolving it and leaking host file
    // existence via a 404-vs-403 status oracle. Scoped to the requesting room's
    // connected Drive folders (?cabinet=), or the union across rooms when none
    // is given — either way the path must sit inside a user-connected folder.
    const cabinet = searchParams.get("cabinet");
    const mountPaths = await resolveAuthorizedMountPaths(cabinet);

    const mountNormalized = mountPaths.map((p) => path.normalize(p));
    const inMountLexical = mountNormalized.some(
      (mp) => normalized.startsWith(mp + path.sep) || normalized === mp
    );
    if (!inMountLexical) {
      return NextResponse.json({ error: "Path is not within a mounted folder" }, { status: 403 });
    }

    // Resolve symlinks and re-check containment so a symlink inside a mount
    // cannot point outside it.
    let realNormalized: string;
    try {
      realNormalized = await fs.realpath(normalized);
    } catch {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const mountRealpaths = await Promise.all(
      mountPaths.map(async (p) => {
        try { return await fs.realpath(p); } catch { return p; }
      })
    );
    const inMount = mountRealpaths.some(
      (mp) => realNormalized.startsWith(mp + path.sep) || realNormalized === mp
    );
    if (!inMount) {
      return NextResponse.json({ error: "Path is not within a mounted folder" }, { status: 403 });
    }

    // Read file
    let data: Uint8Array;
    try {
      data = new Uint8Array(await fs.readFile(realNormalized));
    } catch {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const mimeType = getMimeType(realNormalized);
    const filename = path.basename(realNormalized);

    return new NextResponse(data as unknown as BodyInit, {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `inline; filename="${encodeURIComponent(filename)}"`,
        "Cache-Control": "private, max-age=60",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
