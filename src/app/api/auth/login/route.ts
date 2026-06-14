import { NextRequest, NextResponse } from "next/server";

const KB_PASSWORD = process.env.KB_PASSWORD || "";
const AUTH_ENABLED = KB_PASSWORD.length > 0;

async function hashToken(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + "cabinet-salt");
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Native form posts expect a redirect. Emit a RELATIVE Location: the browser
// resolves it against the address-bar origin, so it lands back on whatever host
// the user actually used (localhost / LAN / Tailscale) — WITHOUT trusting
// attacker-spoofable Host / X-Forwarded-Host headers, and without breaking on
// multi-hop proxies that append comma-separated forwarded values. The path is a
// fixed in-app route, so there is no open-redirect surface.
function seeOther(path: string): NextResponse {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

export async function POST(req: NextRequest) {
  // Native form posts arrive with Content-Type: application/x-www-form-urlencoded
  // and expect a redirect; JS fetch posts JSON and expects a JSON reply.
  const contentType = req.headers.get("content-type") || "";
  const isForm = contentType.includes("application/x-www-form-urlencoded");

  let password = "";
  if (isForm) {
    const form = await req.formData();
    password = (form.get("password") as string) || "";
  } else {
    const body = await req.json().catch(() => ({} as { password?: string }));
    password = body.password || "";
  }

  if (!AUTH_ENABLED) {
    return isForm ? seeOther("/") : NextResponse.json({ ok: true });
  }

  if (password !== KB_PASSWORD) {
    return isForm
      ? seeOther("/login?error=1")
      : NextResponse.json({ error: "Invalid password" }, { status: 401 });
  }

  // 303 + Set-Cookie + Location → the browser commits the cookie and follows
  // the redirect to "/" with it attached (no client JS needed; sidesteps the
  // mobile-Safari race between cookie commit and client navigation). The cookie
  // is set on the response itself so it rides whichever response shape we send.
  const token = await hashToken(password);
  const res = isForm ? seeOther("/") : NextResponse.json({ ok: true });
  res.cookies.set("kb-auth", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" && process.env.KB_ALLOW_HTTP !== "1",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30, // 30 days
  });
  return res;
}
