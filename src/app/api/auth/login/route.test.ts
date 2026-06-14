import test, { before } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

// KB_PASSWORD is read at module load, so set it before importing the handler.
type Route = typeof import("./route");
let route: Route;

before(async () => {
  process.env.KB_PASSWORD = "s3cret";
  route = await import("./route");
});

const URL = "http://127.0.0.1:4000/api/auth/login";

function formReq(password: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams({ password }).toString(),
  });
}

function jsonReq(password: string): NextRequest {
  return new NextRequest(URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
}

test("form login: wrong password → 303 to RELATIVE /login?error=1", async () => {
  const res = await route.POST(formReq("nope"));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/login?error=1");
});

test("form login: correct password → 303 to RELATIVE / with HttpOnly auth cookie", async () => {
  const res = await route.POST(formReq("s3cret"));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/");
  const setCookie = res.headers.get("set-cookie") || "";
  assert.match(setCookie, /kb-auth=/);
  assert.match(setCookie, /HttpOnly/i);
});

test("redirect Location ignores spoofed Host / X-Forwarded-Host (no open redirect)", async () => {
  const res = await route.POST(
    formReq("s3cret", {
      "x-forwarded-host": "evil.example.com",
      "x-forwarded-proto": "https",
      host: "evil.example.com",
    })
  );
  const loc = res.headers.get("location") || "";
  assert.equal(loc, "/", "Location must stay a fixed relative path");
  assert.ok(!loc.includes("evil.example.com"), "spoofed host must not reach Location");
});

test("JSON login: correct → ok + cookie; wrong → 401", async () => {
  const ok = await route.POST(jsonReq("s3cret"));
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("set-cookie") || "", /kb-auth=/);

  const bad = await route.POST(jsonReq("nope"));
  assert.equal(bad.status, 401);
});
