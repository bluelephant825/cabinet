import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/request-gate";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";
import { invalidateTreeCache } from "@/lib/storage/tree-builder";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ op: string[] }> };
const publishedRevisions = new Map<string, string>();
async function forward(req: NextRequest, context: Context) {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  const { op } = await context.params;
  if (op.length !== 1 || !(req.method === "GET" ? ["state", "articles", "export"] : ["action"]).includes(op[0])) return NextResponse.json({ error: "RSS route not found" }, { status: 404 });
  let body: string | undefined;
  if (req.method === "POST") {
    const chunks: Uint8Array[] = []; let size = 0;
    const reader = req.body?.getReader();
    if (reader) for (;;) { const result = await reader.read(); if (result.done) break; size += result.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); return NextResponse.json({ error: "Request too large" }, { status: 413 }); } chunks.push(result.value); }
    body = Buffer.concat(chunks).toString("utf8");
  }
  try {
    const token = await getOrCreateDaemonToken();
    const response = await fetch(`${getDaemonUrl()}/rss/${op[0]}${req.nextUrl.search}`, { method: req.method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(30000), cache: "no-store" });
    if (response.ok && op[0] === "state") {
      const state = await response.clone().json() as { room: string; runs: { pagePath?: string }[] };
      const revision = state.runs.map((run) => run.pagePath).filter(Boolean).sort().join("|");
      if (revision && publishedRevisions.get(state.room) !== revision) invalidateTreeCache();
      publishedRevisions.set(state.room, revision);
    }
    return new Response(response.body, { status: response.status, headers: { "Content-Type": response.headers.get("content-type") || "application/json", "Cache-Control": "no-store", ...(op[0] === "export" ? { "Content-Disposition": 'attachment; filename="cabinet-feeds.opml"' } : {}) } });
  } catch { return NextResponse.json({ error: "RSS background service is unavailable" }, { status: 503 }); }
}
export const GET = forward;
export const POST = forward;
