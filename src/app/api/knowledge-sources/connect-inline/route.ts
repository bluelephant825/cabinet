import fs from "fs/promises";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import { resolveContentPath, sanitizeFilename } from "@/lib/storage/path-utils";
import { ensureDirectory } from "@/lib/storage/fs-operations";
import { invalidateTreeCache } from "@/lib/storage/tree-builder";
import { autoCommit } from "@/lib/git/git-service";
import { detectProvider, type CloudProviderId } from "@/lib/google-drive/detect-desktop";
import { providerLabel } from "@/lib/knowledge-sources/providers";
import {
  addKnowledgeSource,
  DuplicateSourceError,
} from "@/lib/knowledge-sources/store";

export const dynamic = "force-dynamic";

/**
 * Connect a cloud folder INLINE at a tree node (Connect Knowledge F2,
 * docs/CONNECT_KNOWLEDGE_PRD.md §6 F2). Creates a symlink at
 * <parentPath>/<folderName> pointing at the provider folder, and records an
 * `inline` knowledge source (provider, policy, treePath) in the room's
 * knowledge-sources.json — the source of record. Unlike link-repo we write NO
 * `.cabinet-meta` into the target, so a read-only Drive folder is never
 * mutated. Read-only policy is enforced by the file-mutation guard.
 */
export async function POST(req: NextRequest) {
  let symlinkCreated = false;
  let targetDir = "";

  try {
    const body = (await req.json()) as {
      provider?: string;
      absPath?: string;
      name?: string;
      cabinet?: string;
      policy?: "read-only" | "read-write";
      parentPath?: string;
    };

    const CLOUD: CloudProviderId[] = [
      "google-drive",
      "icloud",
      "onedrive",
      "sharepoint",
      "dropbox",
    ];
    const provider = CLOUD.includes(body.provider as CloudProviderId)
      ? (body.provider as CloudProviderId)
      : null;
    if (!provider) {
      return NextResponse.json({ error: "Unsupported provider" }, { status: 400 });
    }
    const absPathInput = body.absPath?.trim();
    if (!absPathInput) {
      return NextResponse.json({ error: "absPath is required" }, { status: 400 });
    }

    // The folder must exist and sit within the detected provider mount, so an
    // arbitrary host directory can't be symlinked in through this endpoint.
    const detection = await detectProvider(provider);
    if (!detection.mountPath) {
      return NextResponse.json(
        { error: `${providerLabel(provider)} not detected` },
        { status: 400 },
      );
    }
    let realMount: string;
    let realAbs: string;
    try {
      realMount = await fs.realpath(detection.mountPath);
      realAbs = await fs.realpath(absPathInput);
    } catch {
      return NextResponse.json({ error: "Path does not exist" }, { status: 400 });
    }
    if (realAbs !== realMount && !realAbs.startsWith(realMount + path.sep)) {
      return NextResponse.json(
        { error: `Path is outside the ${providerLabel(provider)} mount` },
        { status: 400 },
      );
    }
    const stat = await fs.stat(absPathInput).catch(() => null);
    if (!stat?.isDirectory()) {
      return NextResponse.json({ error: "Path is not a directory" }, { status: 400 });
    }

    const folderName = sanitizeFilename(body.name?.trim() || path.basename(absPathInput));
    if (!folderName) {
      return NextResponse.json({ error: "A valid folder name is required" }, { status: 400 });
    }

    const parentPath = body.parentPath?.trim() || "";
    const relativePath = parentPath ? `${parentPath}/${folderName}` : folderName;
    targetDir = resolveContentPath(relativePath);

    // lstat catches real entries AND symlinks (incl. broken ones).
    if (await fs.lstat(targetDir).catch(() => null)) {
      return NextResponse.json(
        { error: `A folder named "${folderName}" already exists here.` },
        { status: 409 },
      );
    }

    await ensureDirectory(path.dirname(targetDir));

    const policy = body.policy === "read-write" ? "read-write" : "read-only";
    const cabinet = body.cabinet ?? "";

    // Record the source first; if the symlink fails we roll it back.
    let sourceId: string;
    try {
      const source = await addKnowledgeSource(cabinet, {
        provider,
        absPath: absPathInput,
        name: folderName,
        policy,
        surface: "inline",
        treePath: relativePath,
      });
      sourceId = source.id;
    } catch (err) {
      if (err instanceof DuplicateSourceError) {
        return NextResponse.json({ error: err.message }, { status: 409 });
      }
      throw err;
    }

    try {
      await fs.symlink(
        absPathInput,
        targetDir,
        process.platform === "win32" ? "junction" : "dir",
      );
      symlinkCreated = true;
    } catch (err) {
      // Roll back the recorded source so the registry can't drift from disk.
      const { removeKnowledgeSource } = await import("@/lib/knowledge-sources/store");
      await removeKnowledgeSource(cabinet, sourceId).catch(() => {});
      throw err;
    }

    invalidateTreeCache();
    autoCommit(relativePath, "Add");

    return NextResponse.json({ ok: true, path: relativePath, policy });
  } catch (error) {
    if (symlinkCreated && targetDir) {
      await fs.unlink(targetDir).catch(() => {});
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
