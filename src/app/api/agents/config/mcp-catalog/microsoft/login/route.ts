import { NextRequest, NextResponse } from "next/server";
import {
  startDeviceLogin,
  getLoginStatus,
  cancelLogin,
} from "@/lib/agents/microsoft-login";

/**
 * `/api/agents/config/mcp-catalog/microsoft/login`
 *
 * POST    — start a device-code sign-in; returns { sessionId, verificationUri,
 *           userCode }. The browser step happens on Microsoft's page.
 * GET ?sessionId — poll status: pending | success | error | expired.
 * DELETE ?sessionId — cancel an in-flight sign-in.
 *
 * Personal accounts only — uses the server's built-in public-client app. No
 * secrets are handled here; the token is cached by the server for later agent
 * use.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(): Promise<NextResponse> {
  try {
    const res = await startDeviceLogin();
    return NextResponse.json({ ok: true, ...res });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : "Could not start sign-in" },
      { status: 500 },
    );
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }
  const status = getLoginStatus(sessionId);
  if (!status) {
    return NextResponse.json({ error: "Unknown sign-in session" }, { status: 404 });
  }
  return NextResponse.json(status);
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const sessionId = req.nextUrl.searchParams.get("sessionId");
  if (!sessionId) {
    return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
  }
  cancelLogin(sessionId);
  return NextResponse.json({ ok: true });
}
