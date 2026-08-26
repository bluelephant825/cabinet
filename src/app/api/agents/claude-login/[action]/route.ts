import { NextResponse, type NextRequest } from "next/server";
import { getOrCreateDaemonToken } from "@/lib/agents/daemon-auth";
import { getDaemonUrl } from "@/lib/runtime/runtime-config";

// Proxy the browser's Connect-Claude calls to the daemon's /auth/claude/* flow
// (server-side, with the daemon token). Works on cloud and desktop/self-host —
// both drive the local `claude setup-token` CLI over a PTY.
const ALLOWED = new Set(["start", "code", "status", "clear"]);

async function proxy(action: string, method: "GET" | "POST", body?: string) {
  if (!ALLOWED.has(action)) return NextResponse.json({ error: "unknown action" }, { status: 404 });
  const token = await getOrCreateDaemonToken();
  const res = await fetch(`${getDaemonUrl()}/auth/claude/${action}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(35_000),
  });
  const text = await res.text();
  return new NextResponse(text, { status: res.status, headers: { "Content-Type": "application/json" } });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  return proxy((await params).action, "GET");
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ action: string }> }) {
  const body = await req.text();
  return proxy((await params).action, "POST", body || undefined);
}
