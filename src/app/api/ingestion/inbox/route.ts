import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/request-gate";
import { getDaemonUrl, getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";

async function forward(req: NextRequest): Promise<Response> {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  let body: string | undefined;
  if (req.method === "POST") {
    // Bound the stream, not just Content-Length (which a caller can omit).
    const reader = req.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader) for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4096) { await reader.cancel(); return NextResponse.json({ error: "Request too large" }, { status: 413 }); }
      chunks.push(next.value);
    }
    body = Buffer.concat(chunks).toString("utf8");
  }
  try {
    const token = await getOrCreateDaemonToken();
    const response = await fetch(`${getDaemonUrl()}/ingestion/inbox`, {
      method: req.method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body, cache: "no-store", signal: AbortSignal.timeout(10_000),
    });
    return new Response(await response.text(), { status: response.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Inbox service is unavailable" }, { status: 503 });
  }
}

export const GET = forward;
export const POST = forward;
