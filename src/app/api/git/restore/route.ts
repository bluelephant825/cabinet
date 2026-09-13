import { NextRequest, NextResponse } from "next/server";
import { restoreFileFromCommit, readFileAtCommit } from "@/lib/git/git-service";
import path from "path";
import { assertWritablePath } from "@/lib/knowledge-sources/store";
import { authorizeDocumentPath } from "@/lib/documents/policy";
import { DocumentError } from "@/lib/documents/errors";
import { documentsDaemonFetch } from "@/lib/documents/client";
import { readWithRevision } from "../../../../../server/documents/persistence";
import { invalidateTreeCache } from "@/lib/storage/tree-builder";
import { recordMutation } from "@/lib/history/engine";

const DOC_EXTS = new Set([".docx", ".pdf"]);

export async function POST(req: NextRequest) {
  try {
    const { hash, pagePath } = await req.json();
    if (!hash || !pagePath) {
      return NextResponse.json(
        { error: "hash and pagePath are required" },
        { status: 400 }
      );
    }

    await assertWritablePath(pagePath);

    // Binary documents restore through the document service: binary-safe
    // read + revision-checked commit + recovery copy. A raw git checkout
    // would bypass the serializer and recovery retention.
    if (DOC_EXTS.has(path.extname(String(pagePath)).toLowerCase())) {
      const bytes = await readFileAtCommit(hash, pagePath);
      if (!bytes) {
        return NextResponse.json(
          { error: "Failed to restore. The file may not exist at that commit" },
          { status: 404 }
        );
      }
      let auth;
      try {
        auth = await authorizeDocumentPath(pagePath, { write: true });
      } catch (err) {
        if (err instanceof DocumentError) {
          return NextResponse.json({ error: err.message, code: err.code }, { status: err.httpStatus });
        }
        throw err;
      }
      const { revision: currentRevision } = await readWithRevision(auth.absPath);
      const res = await documentsDaemonFetch(
        `/documents/save?path=${encodeURIComponent(pagePath)}&baseRevision=${encodeURIComponent(currentRevision)}`,
        {
          method: "PUT",
          headers: { "content-type": "application/octet-stream" },
          body: bytes as unknown as BodyInit,
        },
      );
      if (res.status === 409) {
        return NextResponse.json(
          { error: "Document changed since it was viewed", code: "conflict", currentRevision },
          { status: 409 }
        );
      }
      if (!res.ok) {
        const errBody = await res.text();
        return NextResponse.json(
          { error: errBody || "Restore failed" },
          { status: res.status }
        );
      }
      const { revision } = (await res.json()) as { revision: string };
      invalidateTreeCache();
      void recordMutation({
        op: "write",
        virtualPath: pagePath,
        message: `Restore ${pagePath} to version ${hash.slice(0, 8)}`,
      });
      return NextResponse.json({ ok: true, revision });
    }

    // Directory index.md, standalone .md, or the exact file (non-markdown
    // viewers — CSV, source, assets — restore too).
    const candidates = [
      path.join(pagePath, "index.md"),
      `${pagePath}.md`,
      pagePath,
    ];

    let restored = false;
    for (const candidate of candidates) {
      restored = await restoreFileFromCommit(hash, candidate);
      if (restored) break;
    }

    if (!restored) {
      return NextResponse.json(
        { error: "Failed to restore. The file may not exist at that commit" },
        { status: 404 }
      );
    }

    try {
      const { emit } = await import("@/lib/telemetry");
      emit("history.restored", { source: "panel" });
    } catch {
      // telemetry optional
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
