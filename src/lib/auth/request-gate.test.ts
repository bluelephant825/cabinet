import test from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { deriveAuthToken } from "./kb-auth";
import { requireApiAuth } from "./request-gate";

function req(cookie?: string): NextRequest {
  return new NextRequest("http://localhost/api/upload/some/dir", {
    headers: cookie ? { cookie } : {},
  });
}

const ENV_KEYS = [
  "KB_PASSWORD",
  "CABINET_LOGIN_PBKDF2_ITERS",
  "CABINET_AUTH_SALT",
  "CABINET_CLOUD",
  "CABINET_JWT_JWKS_URL",
] as const;

test("requireApiAuth mirrors the proxy gate for excluded routes", async () => {
  const prev = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  try {
    process.env.CABINET_LOGIN_PBKDF2_ITERS = "2";
    process.env.CABINET_AUTH_SALT = "gate-salt";
    delete process.env.CABINET_CLOUD;
    delete process.env.CABINET_JWT_JWKS_URL;

    // Auth disabled (no password) -> pass.
    delete process.env.KB_PASSWORD;
    assert.equal(await requireApiAuth(req()), null);

    // Auth enabled: no cookie and wrong cookie -> 401.
    process.env.KB_PASSWORD = "gate-pw";
    assert.equal((await requireApiAuth(req()))?.status, 401);
    assert.equal(
      (await requireApiAuth(req("kb-auth=deadbeef")))?.status,
      401
    );

    // Correct cookie -> pass.
    const token = await deriveAuthToken("gate-pw", "gate-salt", 2);
    assert.equal(await requireApiAuth(req(`kb-auth=${token}`)), null);

    // Cloud gate active: no cabinet_jwt cookie -> 401 even though local
    // KB auth would pass (the cloud gate takes precedence, fail closed).
    process.env.CABINET_CLOUD = "1";
    process.env.CABINET_JWT_JWKS_URL = "http://localhost:1/jwks.json";
    assert.equal(
      (await requireApiAuth(req(`kb-auth=${token}`)))?.status,
      401
    );
  } finally {
    for (const k of ENV_KEYS) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k]!;
    }
  }
});
