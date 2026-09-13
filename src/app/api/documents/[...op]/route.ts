import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/request-gate";
import { documentsDaemonFetch } from "@/lib/documents/client";
import { authorizeDocumentPath } from "@/lib/documents/policy";
import { DocumentError } from "@/lib/documents/errors";
import { readWithRevision } from "../../../../../server/documents/persistence";
import { invalidateTreeCache } from "@/lib/storage/tree-builder";
import { recordMutation } from "@/lib/history/engine";
import type { JobInfo } from "@/lib/documents/types";

export const runtime = "nodejs";
// Streaming binary bodies (PUT /api/documents/save) must not be buffered.
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ op: string[] }> };

async function proxyJson(res: Response): Promise<NextResponse> {
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
  });
}

function recordDocMutation(op: "write" | "create", virtualPath: string | undefined): void {
  if (!virtualPath) return;
  invalidateTreeCache();
  void recordMutation({ op, virtualPath, message: `${op === "create" ? "Create" : "Update"} ${virtualPath}` });
}

async function forwardJson(op: string, req: NextRequest): Promise<NextResponse> {
  const body = await req.text();
  return proxyJson(
    await documentsDaemonFetch(`/documents/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  );
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  const { op } = await ctx.params;

  // /api/documents/jobs/:id/cancel and /mark-recorded
  if (op[0] === "jobs" && op[1] && op[2] === "cancel") {
    return proxyJson(
      await documentsDaemonFetch(`/documents/jobs/${op[1]}/cancel`, { method: "POST" }),
    );
  }
  if (op[0] === "jobs" && op[1] && op[2] === "mark-recorded") {
    return proxyJson(
      await documentsDaemonFetch(`/documents/jobs/${op[1]}/mark-recorded`, { method: "POST" }),
    );
  }

  switch (op[0]) {
    case "open":
    case "inspect":
    case "read":
    case "search":
    case "close":
      return forwardJson(op[0], req);
    case "revision":
      return forwardJson("revision", req);
    case "recovery": {
      if (op[1] !== "restore") {
        return NextResponse.json({ error: "Unknown document route" }, { status: 404 });
      }
      const bodyText = await req.text();
      let vp: string | undefined;
      try {
        vp = (JSON.parse(bodyText) as { virtualPath?: string }).virtualPath;
      } catch {
        /* daemon validates */
      }
      const res = await proxyJson(
        await documentsDaemonFetch("/documents/recovery/restore", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyText,
        }),
      );
      if (res.ok && vp) recordDocMutation("write", vp);
      return res;
    }
    case "patch": {
      const bodyText = await req.text();
      const res = await documentsDaemonFetch("/documents/patch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: bodyText,
      });
      const out = await proxyJson(res);
      if (res.ok) {
        // The request has no virtualPath (sessionId only) — read it back from
        // the daemon's PatchResult.
        const clone = out.clone();
        try {
          const json = (await clone.json()) as { virtualPath?: string };
          recordDocMutation("write", json.virtualPath);
        } catch {
          /* non-JSON response */
        }
      }
      return out;
    }
    case "docx": {
      if (op[1] === "load") return forwardJson("docx/load", req);
      if (op[1] !== "save") {
        return NextResponse.json({ error: "Unknown document route" }, { status: 404 });
      }
      const res = await forwardJson("docx/save", req);
      if (res.ok) {
        const clone = res.clone();
        try {
          const json = (await clone.json()) as { virtualPath?: string };
          recordDocMutation("write", json.virtualPath);
        } catch {
          /* non-JSON response */
        }
      }
      return res;
    }
    case "pdf": {
      if (op[1] === "geometry") return forwardJson("pdf/geometry", req);
      return NextResponse.json({ error: "Unknown document route" }, { status: 404 });
    }
    case "save-copy": {
      const res = await forwardJson("save-copy", req);
      if (res.ok) {
        const clone = res.clone();
        try {
          const json = (await clone.json()) as { virtualPath?: string };
          recordDocMutation("create", json.virtualPath);
        } catch {
          /* non-JSON response */
        }
      }
      return res;
    }
    case "convert": {
      const res = await forwardJson("convert", req);
      return res;
    }
    default:
      return NextResponse.json({ error: "Unknown document route" }, { status: 404 });
  }
}

export async function PUT(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  const { op } = await ctx.params;
  const qs = req.nextUrl.searchParams;
  if (op[0] === "draft") {
    // Autosave draft — streamed like save, but records no history.
    const res = await documentsDaemonFetch(
      `/documents/draft?path=${encodeURIComponent(qs.get("path") ?? "")}&sessionId=${encodeURIComponent(qs.get("sessionId") ?? "")}&baseRevision=${encodeURIComponent(qs.get("baseRevision") ?? "")}`,
      {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: req.body,
        // @ts-expect-error Node fetch requires duplex for streaming bodies
        duplex: "half",
      },
    );
    return proxyJson(res);
  }
  if (op[0] !== "save") {
    return NextResponse.json({ error: "Unknown document route" }, { status: 404 });
  }
  const res = await documentsDaemonFetch(
    `/documents/save?path=${encodeURIComponent(qs.get("path") ?? "")}&baseRevision=${encodeURIComponent(qs.get("baseRevision") ?? "")}`,
    {
      method: "PUT",
      headers: { "content-type": "application/octet-stream" },
      // Stream the raw body through — never req.text() (that corrupts binary
      // documents the way the old /api/assets PUT did).
      body: req.body,
      // @ts-expect-error Node fetch requires duplex for streaming bodies
      duplex: "half",
    },
  );
  const out = await proxyJson(res);
  if (res.ok) recordDocMutation("write", qs.get("path") ?? undefined);
  return out;
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  const { op } = await ctx.params;
  if (op[0] !== "draft") {
    return NextResponse.json({ error: "Unknown document route" }, { status: 404 });
  }
  return proxyJson(
    await documentsDaemonFetch(
      `/documents/draft?path=${encodeURIComponent(req.nextUrl.searchParams.get("path") ?? "")}`,
      { method: "DELETE" },
    ),
  );
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  const { op } = await ctx.params;

  // GET /api/documents/recovery?path=
  if (op[0] === "recovery") {
    return proxyJson(
      await documentsDaemonFetch(
        `/documents/recovery?path=${encodeURIComponent(req.nextUrl.searchParams.get("path") ?? "")}`,
      ),
    );
  }

  // GET /api/documents/revision?path=
  if (op[0] === "revision") {
    return proxyJson(
      await documentsDaemonFetch("/documents/revision", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ virtualPath: req.nextUrl.searchParams.get("path") ?? "" }),
      }),
    );
  }

  // GET /api/documents/jobs/:id — poll a job; record the create mutation once
  // when a convert finishes.
  if (op[0] === "jobs" && op[1]) {
    const res = await documentsDaemonFetch(`/documents/jobs/${op[1]}`);
    const text = await res.text();
    if (res.ok) {
      try {
        const job = JSON.parse(text) as JobInfo;
        if (
          job.status === "done" &&
          job.kind === "convert-pdf-docx" &&
          job.result?.virtualPath &&
          !job.result.mutationRecorded
        ) {
          recordDocMutation("create", job.result.virtualPath);
          void documentsDaemonFetch(`/documents/jobs/${op[1]}/mark-recorded`, { method: "POST" });
        }
      } catch {
        /* pass through */
      }
    }
    return new NextResponse(text, {
      status: res.status,
      headers: { "content-type": "application/json" },
    });
  }

  // GET /api/documents/asset?path=&revision= — current bytes for editors.
  if (op[0] === "asset") {
    const virtualPath = req.nextUrl.searchParams.get("path") ?? "";
    const revisionParam = req.nextUrl.searchParams.get("revision");
    try {
      const auth = await authorizeDocumentPath(virtualPath, { write: false });
      const { bytes, revision } = await readWithRevision(auth.absPath);
      if (revisionParam && revisionParam !== revision) {
        return NextResponse.json(
          { error: "Revision changed", code: "conflict", currentRevision: revision },
          { status: 409 },
        );
      }
      const etag = `"${revision}"`;
      if (req.headers.get("if-none-match") === etag) {
        return new NextResponse(null, { status: 304, headers: { etag } });
      }
      return new NextResponse(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "content-type":
            auth.format === "pdf"
              ? "application/pdf"
              : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "cache-control": "private, no-cache",
          etag,
        },
      });
    } catch (err) {
      if (err instanceof DocumentError) {
        return NextResponse.json(
          { error: err.message, code: err.code, details: err.details },
          { status: err.httpStatus },
        );
      }
      throw err;
    }
  }

  return NextResponse.json({ error: "Unknown document route" }, { status: 404 });
}
