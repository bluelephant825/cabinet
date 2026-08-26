import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  KB_AUTH_COOKIE,
  expectedToken,
  isAuthEnabled,
  timingSafeEqualHex,
} from "./kb-auth";

// Shared auth decision used by BOTH the proxy (src/proxy.ts) and API routes
// that are excluded from the proxy matcher. Large-body routes (/api/upload)
// must be excluded there because Next's proxy plumbing buffers a full clone
// of every matched request body in memory (and truncates it at
// proxyClientMaxBodySize) — so those routes enforce the same gate themselves
// via requireApiAuth().

/** Cookie the panel sets on `.runcabinet.com` (Supabase ES256 access token). */
export const CABINET_JWT_COOKIE = "cabinet_jwt";

// A remote JWK set caches keys and rate-limits refetches internally, so build
// it ONCE per JWKS URL and reuse it across requests (rebuilding per request
// would defeat jose's caching and hammer the auth server). Memoized on the URL
// so an env change (e.g. in tests) still rebuilds.
let jwksMemo: {
  url: string;
  jwks: ReturnType<typeof createRemoteJWKSet>;
} | null = null;

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  if (jwksMemo && jwksMemo.url === url) return jwksMemo.jwks;
  const jwks = createRemoteJWKSet(new URL(url));
  jwksMemo = { url, jwks };
  return jwks;
}

/** Whether the hosted-edition Supabase-JWT gate is active for this process. */
export function cloudGateActive(): boolean {
  return (
    process.env.CABINET_CLOUD === "1" && !!process.env.CABINET_JWT_JWKS_URL
  );
}

/**
 * Verify the `cabinet_jwt` cookie and return the token subject (the Supabase
 * user id), or null when the token is missing/invalid/expired or the gate is
 * misconfigured (no JWKS URL). Pinning `algorithms: ["ES256"]` blocks
 * algorithm-confusion attacks (`alg: none`, HS256-with-public-key). jose also
 * enforces `exp`/`nbf`, so expired sessions fail closed here.
 */
export async function cloudUserSub(req: NextRequest): Promise<string | null> {
  const jwksUrl = process.env.CABINET_JWT_JWKS_URL;
  if (!jwksUrl) return null; // Not configured -> deny (fail closed).

  const token = req.cookies.get(CABINET_JWT_COOKIE)?.value;
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, getJwks(jwksUrl), {
      algorithms: ["ES256"],
    });
    return typeof payload.sub === "string" && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

/** Constant-time check of the local KB_PASSWORD auth cookie. */
export async function hasValidKbAuthCookie(
  req: NextRequest
): Promise<boolean> {
  const token = req.cookies.get(KB_AUTH_COOKIE)?.value ?? "";
  return timingSafeEqualHex(token, await expectedToken());
}

/**
 * Same gate the proxy applies, for API routes outside its matcher. Returns a
 * 401 response to send back, or null when the request is authorized.
 */
export async function requireApiAuth(
  req: NextRequest
): Promise<NextResponse | null> {
  const unauthorized = () =>
    NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (cloudGateActive()) {
    return (await cloudUserSub(req)) ? null : unauthorized();
  }
  if (!isAuthEnabled()) return null;
  return (await hasValidKbAuthCookie(req)) ? null : unauthorized();
}
