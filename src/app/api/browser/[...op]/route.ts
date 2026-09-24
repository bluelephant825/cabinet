import { NextRequest, NextResponse } from "next/server";
import { requireApiAuth } from "@/lib/auth/request-gate";
import { browserDaemonFetch } from "@/lib/browser/client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Thin proxy: /api/browser/<op...> -> daemon /browser/<op...>. Static siblings
 * (/api/browser/bookmarks, /api/browser/frame-check) still win over this
 * catch-all. The daemon never sees the real client Origin on same-origin
 * requests, so the page's origin is forwarded explicitly in
 * x-cabinet-client-origin for the loopback availability check. Response bodies
 * stream through untouched (screenshot returns image/png bytes).
 */
type Ctx = { params: Promise<{ op: string[] }> };

async function forward(req: NextRequest, op: string[]): Promise<NextResponse> {
  const method = req.method ?? "GET";
  const headers = new Headers();
  // No Origin header on same-origin GETs: fall back to the Host header — the
  // origin the client actually connected to. req.nextUrl.origin is the
  // server's bind hostname in the standalone build (0.0.0.0), which the
  // daemon's loopback check would reject, wrongly marking local clients
  // ineligible for the browser engine.
  const host = req.headers.get("host");
  headers.set(
    "x-cabinet-client-origin",
    req.headers.get("origin") ?? (host ? `http://${host}` : req.nextUrl.origin),
  );
  let body: BodyInit | undefined;
  if (method !== "GET" && method !== "HEAD") {
    body = await req.text();
    if (body) {
      headers.set(
        "content-type",
        req.headers.get("content-type") ?? "application/json",
      );
    }
  }
  const res = await browserDaemonFetch(
    `/browser/${op.map(encodeURIComponent).join("/")}${req.nextUrl.search}`,
    { method, headers, body },
  );
  return new NextResponse(res.body, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
    },
  });
}

export async function GET(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  return forward(req, (await ctx.params).op);
}

export async function POST(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  return forward(req, (await ctx.params).op);
}

export async function DELETE(req: NextRequest, ctx: Ctx): Promise<NextResponse> {
  const denied = await requireApiAuth(req);
  if (denied) return denied;
  return forward(req, (await ctx.params).op);
}
