import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { handleBrowserRequest, type BrowserFacade } from "../server/browser/http";
import { BrowserError } from "../server/browser/types";

process.env.CABINET_DAEMON_TOKEN ??= "test-browser-token";
const TOKEN = process.env.CABINET_DAEMON_TOKEN;

function fakeBrowser(overrides: Partial<BrowserFacade> = {}): BrowserFacade & {
  calls: string[];
} {
  const calls: string[] = [];
  const tab = { id: "T1", targetId: "T1", url: "https://example.com", title: "Example", active: true };
  return {
    calls,
    status: () => "running",
    lastError: () => null,
    executablePath: () => "/bin/chrome",
    pid: () => null,
    bundleId: () => null,
    hostMode: () => false,
    hostExtension: () => ({ enabled: false, id: null }),
    version: () => "153.0.8010.47",
    downloadProgress: () => null,
    isAvailable: (origin) => !origin || ["http://127.0.0.1:4000", "http://localhost:4000"].includes(origin),
    launch: async () => (calls.push("launch"), {}),
    shutdown: async () => { calls.push("shutdown"); },
    relaunch: async () => (calls.push("relaunch"), {}),
    download: async () => (calls.push("download"), {}),
    ensureRunning: async () => (calls.push("ensureRunning"), {}),
    listTabs: async () => [tab],
    openTab: async (url) => (calls.push(`open:${url}`), tab),
    activateTab: async () => tab,
    closeTab: async () => ({ ok: true }),
    navigateTab: async (_id, url) => (calls.push(`navigate:${url}`), tab),
    backTab: async () => ({ ok: true }),
    forwardTab: async () => ({ ok: true }),
    reloadTab: async () => ({ ok: true }),
    evaluateTab: async () => 42,
    extractTab: async () => ({ url: "https://example.com", title: "Example", text: "hi" }),
    screenshotTab: async () => Buffer.from([0x89, 0x50]),
    listExtensions: async () => [],
    installExtension: async (id) =>
      ({
        id, name: "x", version: "1", path: "/x", description: "",
        iconDataUrl: null, popupHtml: null, optionsPage: null,
        contentScriptMatches: [], enabled: true, pinned: false, runtimeId: null,
      }),
    loadUnpackedExtension: async (dirPath) =>
      (calls.push(`loadUnpacked:${dirPath}`),
      {
        id: "aabbccddeeffgghhiiaabbccddeeffgg",
        name: "x", version: "1", path: dirPath, description: "",
        iconDataUrl: null, popupHtml: null, optionsPage: null,
        contentScriptMatches: [], enabled: true, pinned: false, runtimeId: null,
        unpacked: true,
      }),
    uninstallExtension: async () => ({ ok: true }),
    enableExtension: async () => { throw new BrowserError("not-found", "Extension not found"); },
    disableExtension: async () => { throw new BrowserError("not-found", "Extension not found"); },
    pinExtension: async () => { throw new BrowserError("not-found", "Extension not found"); },
    setWindowBounds: async () => ({ ok: true }),
    focusWindow: async () => ({ ok: true }),
    ...overrides,
  };
}

let server: http.Server;
let base: string;
let browser: ReturnType<typeof fakeBrowser>;

test.before(async () => {
  browser = fakeBrowser();
  server = http.createServer((req, res) => {
    void handleBrowserRequest(req, res, browser).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

test.after(async () => {
  await new Promise((r) => server.close(r));
});

const auth = (extra?: Record<string, string>) => ({
  authorization: `Bearer ${TOKEN}`,
  ...extra,
});

test("401 without token and with wrong token", async () => {
  assert.equal((await fetch(`${base}/browser/status`)).status, 401);
  assert.equal(
    (await fetch(`${base}/browser/status`, { headers: { authorization: "Bearer nope" } })).status,
    401,
  );
});

test("GET /browser/status shape", async () => {
  const res = await fetch(`${base}/browser/status`, { headers: auth() });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "running");
  assert.equal(body.version, "153.0.8010.47");
  assert.equal(body.executablePath, "/bin/chrome");
  assert.equal(body.available, true);
  assert.equal(body.eligible, true);
});

test("status available:false and eligible:false for a non-loopback Origin", async () => {
  const res = await fetch(`${base}/browser/status`, {
    headers: auth({ origin: "https://remote.example.com" }),
  });
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(body.eligible, false);
});

test("x-cabinet-client-origin wins over Origin for availability", async () => {
  const res = await fetch(`${base}/browser/status`, {
    headers: auth({
      origin: "http://127.0.0.1:4000",
      "x-cabinet-client-origin": "http://10.0.0.5:4000",
    }),
  });
  const body = await res.json();
  assert.equal(body.available, false);
  assert.equal(body.eligible, false);
});

test("status eligible:false when the browser is in error state", async () => {
  const prevStatus = browser.status;
  const prevAvailable = browser.isAvailable;
  browser.status = () => "error";
  browser.isAvailable = () => false;
  try {
    const res = await fetch(`${base}/browser/status`, { headers: auth() });
    const body = await res.json();
    assert.equal(body.eligible, false);
    assert.equal(body.available, false);
  } finally {
    browser.status = prevStatus;
    browser.isAvailable = prevAvailable;
  }
});

test("POST /browser/tabs rejects javascript: URLs with 400 invalid", async () => {
  const res = await fetch(`${base}/browser/tabs`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({ url: "javascript:alert(1)" }),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "invalid");
});

test("POST /browser/tabs opens a tab after ensureRunning", async () => {
  const res = await fetch(`${base}/browser/tabs`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({ url: "https://example.com" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tab.id, "T1");
  assert.ok(browser.calls.includes("ensureRunning"));
  assert.ok(browser.calls.includes("open:https://example.com"));
});

test("GET /browser/tabs lists tabs", async () => {
  const res = await fetch(`${base}/browser/tabs`, { headers: auth() });
  const body = await res.json();
  assert.equal(body.tabs[0].id, "T1");
});

test("GET /browser/tabs/:id/screenshot returns image/png", async () => {
  const res = await fetch(`${base}/browser/tabs/T1/screenshot`, { headers: auth() });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
});

test("POST /browser/extensions/unpacked loads a local folder", async () => {
  const res = await fetch(`${base}/browser/extensions/unpacked`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: JSON.stringify({ path: "/tmp/my-ext" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.extension.unpacked, true);
  assert.equal(body.extension.path, "/tmp/my-ext");
  assert.ok(browser.calls.includes("ensureRunning"));
  assert.ok(browser.calls.includes("loadUnpacked:/tmp/my-ext"));
});

test("POST /browser/extensions/unpacked without path is 400", async () => {
  const res = await fetch(`${base}/browser/extensions/unpacked`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: "{}",
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "invalid");
});

test("POST /browser/extensions/:id/enable surfaces not-found as 404", async () => {
  const res = await fetch(`${base}/browser/extensions/abc/enable`, {
    method: "POST",
    headers: auth(),
  });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.code, "not-found");
});

test("POST /browser/relaunch is atomic shutdown+launch", async () => {
  const res = await fetch(`${base}/browser/relaunch`, {
    method: "POST",
    headers: auth(),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.ok(browser.calls.includes("relaunch"));
});

test("POST /browser/window/focus works", async () => {
  const res = await fetch(`${base}/browser/window/focus`, {
    method: "POST",
    headers: auth({ "content-type": "application/json" }),
    body: "{}",
  });
  assert.equal(res.status, 200);
});

test("non-/browser paths are not handled", async () => {
  const res = await fetch(`${base}/documents/health`, { headers: auth() });
  assert.equal(res.status, 404); // fell through to our test server's 404
});
