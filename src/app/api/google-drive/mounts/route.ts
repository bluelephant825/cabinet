import { NextRequest, NextResponse } from "next/server";
import { detectProvider, type CloudProviderId } from "@/lib/google-drive/detect-desktop";
import {
  addKnowledgeSource,
  readKnowledgeSources,
  DuplicateSourceError,
} from "@/lib/knowledge-sources/store";
import { providerLabel } from "@/lib/knowledge-sources/providers";
import fs from "fs/promises";
import path from "path";

export async function GET(request: NextRequest) {
  try {
    const cabinet = request.nextUrl.searchParams.get("cabinet") ?? "";
    const sources = await readKnowledgeSources(cabinet);
    const mounts = sources
      .filter((s) => s.provider === "google-drive" && s.surface === "browser")
      .map((s) => ({
        id: s.id,
        abs_path: s.absPath,
        folder_name: s.name,
        enabled: s.enabled ? 1 : 0,
        added_at: s.addedAt,
      }));
    return NextResponse.json({ mounts });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const { absPath, folderName, cabinet, policy, provider: rawProvider } =
      (await request.json()) as {
        absPath: string;
        folderName: string;
        cabinet?: string;
        policy?: "read-only" | "read-write";
        provider?: string;
      };
    const provider = (rawProvider ?? "google-drive") as CloudProviderId;

    if (!absPath || !folderName) {
      return NextResponse.json(
        { error: "absPath and folderName are required" },
        { status: 400 },
      );
    }

    // Verify the path exists and is a directory
    try {
      const stat = await fs.stat(absPath);
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
      }
    } catch {
      return NextResponse.json({ error: "Path does not exist" }, { status: 400 });
    }

    // Constrain mounts to within the detected Drive root, so arbitrary host
    // directories can't be mounted and exposed through the Drive APIs. Compare
    // realpaths to defeat symlinks pointing outside the mount.
    const detection = await detectProvider(provider);
    if (!detection.mountPath) {
      return NextResponse.json(
        { error: "Provider not detected on this machine" },
        { status: 400 },
      );
    }
    let realMountPath: string;
    let realAbsPath: string;
    try {
      realMountPath = await fs.realpath(detection.mountPath);
      realAbsPath = await fs.realpath(absPath);
    } catch {
      return NextResponse.json({ error: "Path does not exist" }, { status: 400 });
    }
    const within =
      realAbsPath === realMountPath ||
      realAbsPath.startsWith(realMountPath + path.sep);
    if (!within) {
      return NextResponse.json(
        { error: `Path is outside the ${providerLabel(provider)} mount` },
        { status: 400 },
      );
    }

    try {
      const source = await addKnowledgeSource(cabinet ?? "", {
        provider,
        absPath,
        name: folderName,
        policy: policy === "read-write" ? "read-write" : "read-only",
        surface: "browser",
      });
      return NextResponse.json(
        { id: source.id, absPath, folderName },
        { status: 201 },
      );
    } catch (err) {
      if (err instanceof DuplicateSourceError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
