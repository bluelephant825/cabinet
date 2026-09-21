import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { handleBrowserRequest, type BrowserFacade } from "../server/browser/http";
import { BrowserError } from "../server/browser/types";
import { ChromiumManager, buildChromiumArgs } from "../server/browser/chromium-manager";

process.env.CABINET_DAEMON_TOKEN ??= "test-browser-token";
const TOKEN = process.env.CABINET_DAEMON_TOKEN;

const ENV_KEYS = [
  "CABINET_BROWSER_HOST_MODE",
  "CABINET_APP_ORIGIN",
  "CABINET_APP_PORT",
  "CABINET_DATA_DIR",
  "CABINET_USER_DATA",
] as const;

/** Snapshot + restore the env vars host mode reads, so tests stay isolated. */
function saveEnv(): () => void {
  const saved = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  return () => {
    for (const key of ENV_KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function fakeBrowser(overrides: Partial<BrowserFacade> = {}): BrowserFacade {
  const tab = { id: "T1", targetId: "T1", url: "https://example.com", title: "Example", active: true };
  return {
    status: () => "running",
    lastError: () => null,
    executablePath: () => "/bin/chrome",
    pid: () => null,
    bundleId: () => null,
    hostMode: () => false,
    hostExtension: () => ({ enabled: false, id: null }),
    version: () => "153.0.8010.47",
    downloadProgress: () => null,
    isAvailable: () => true,
    launch: async () => ({}),
    shutdown: async () => {},
    relaunch: async () => ({}),
    download: async () => ({}),
    ensureRunning: async () => ({}),
    listTabs: async () => [tab],
    openTab: async () => tab,
    activateTab: async () => tab,
    closeTab: async () => ({ ok: true }),
    navigateTab: async () => tab,
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
    uninstallExtension: async () => ({ ok: true }),
    enableExtension: async () => { throw new BrowserError("not-found", "Extension not found"); },
    disableExtension: async () => { throw new BrowserError("not-found", "Extension not found"); },
    pinExtension: async () => { throw new BrowserError("not-found", "Extension not found"); },
    setWindowBounds: async () => ({ ok: true }),
    focusWindow: async () => ({ ok: true }),
    ...overrides,
  };
}

async function withServer(browser: BrowserFacade, run: (base: string) => Promise<void>): Promise<void> {
  const server = http.createServer((req, res) => {
    void handleBrowserRequest(req, res, browser).then((handled) => {
      if (!handled) res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await run(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("GET /browser/status reports hostMode:true when the facade is in host mode", async () => {
  await withServer(fakeBrowser({ hostMode: () => true }), async (base) => {
    const res = await fetch(`${base}/browser/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.hostMode, true);
  });
});

test("GET /browser/status reports hostMode:false when the facade is not in host mode", async () => {
  await withServer(fakeBrowser(), async (base) => {
    const res = await fetch(`${base}/browser/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = await res.json();
    assert.equal(body.hostMode, false);
  });
});

test("hostMode is on with CABINET_BROWSER_HOST_MODE=1 and args carry --cabinet-ui-url", () => {
  const restore = saveEnv();
  try {
    process.env.CABINET_BROWSER_HOST_MODE = "1";
    process.env.CABINET_APP_ORIGIN = "http://127.0.0.1:4555";
    const manager = new ChromiumManager();
    assert.equal(manager.hostMode, true);
    const args = buildChromiumArgs({
      profileDir: "/tmp/cabinet-profile",
      persisted: {},
      initialUrl: null,
      hostMode: manager.hostMode,
    });
    assert.ok(args.includes("--cabinet-ui-url=http://127.0.0.1:4555"));
    // The shell URL is a flag, not a tab.
    assert.ok(!args.includes("http://127.0.0.1:4555"));
  } finally {
    restore();
  }
});

test("app origin falls back to CABINET_APP_PORT then 4000", () => {
  const restore = saveEnv();
  try {
    delete process.env.CABINET_APP_ORIGIN;
    process.env.CABINET_APP_PORT = "4666";
    // Isolate from the real .cabinet-state/runtime-ports.json: getAppOrigin()
    // prefers it over CABINET_APP_PORT, which is correct for a live daemon.
    process.env.CABINET_DATA_DIR = path.join(
      os.tmpdir(),
      `cabinet-test-ports-${process.pid}`,
    );
    let args = buildChromiumArgs({
      profileDir: "/tmp/cabinet-profile",
      persisted: {},
      initialUrl: null,
      hostMode: true,
    });
    assert.ok(args.includes("--cabinet-ui-url=http://127.0.0.1:4666"));

    delete process.env.CABINET_APP_PORT;
    args = buildChromiumArgs({
      profileDir: "/tmp/cabinet-profile",
      persisted: {},
      initialUrl: null,
      hostMode: true,
    });
    assert.ok(args.includes("--cabinet-ui-url=http://127.0.0.1:4000"));
  } finally {
    restore();
  }
});

test("hostMode is on with browser.hostMode in cabinet-config.json", () => {
  const restore = saveEnv();
  try {
    delete process.env.CABINET_BROWSER_HOST_MODE;
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-host-mode-"));
    process.env.CABINET_USER_DATA = userData;
    fs.writeFileSync(
      path.join(userData, "cabinet-config.json"),
      JSON.stringify({ browser: { hostMode: true } }),
    );
    assert.equal(new ChromiumManager().hostMode, true);
    fs.rmSync(userData, { recursive: true, force: true });
  } finally {
    restore();
  }
});

test("restore skips extension pages and blank entries from persisted tabs", () => {
  const args = buildChromiumArgs({
    profileDir: "/tmp/cabinet-profile",
    persisted: {
      tabs: [
        "chrome-extension://anniilfanmjjcphmfoomhdbabefgkebj/src/welcome.html",
        "about:blank",
        "devtools://devtools/bundled/inspector.html",
        "https://example.com/",
        "https://example.com/",
        "http://127.0.0.1:4000/",
      ],
    },
    initialUrl: null,
    hostMode: false,
  });
  assert.ok(args.includes("https://example.com/"));
  assert.ok(args.includes("http://127.0.0.1:4000/"));
  assert.ok(!args.some((arg) => arg.startsWith("chrome-extension:")));
  assert.ok(!args.includes("about:blank"));
  assert.ok(!args.some((arg) => arg.startsWith("devtools:")));
});

test("restore falls back to about:blank when every persisted tab is filtered", () => {
  const args = buildChromiumArgs({
    profileDir: "/tmp/cabinet-profile",
    persisted: {
      tabs: ["chrome-extension://x/welcome.html"],
    },
    initialUrl: null,
    hostMode: false,
  });
  assert.ok(args.includes("about:blank"));
  assert.ok(!args.some((arg) => arg.startsWith("chrome-extension:")));
});

test("no --cabinet-ui-url and hostMode:false without the env or config", () => {
  const restore = saveEnv();
  try {
    delete process.env.CABINET_BROWSER_HOST_MODE;
    delete process.env.CABINET_USER_DATA;
    const manager = new ChromiumManager();
    assert.equal(manager.hostMode, false);
    const args = buildChromiumArgs({
      profileDir: "/tmp/cabinet-profile",
      persisted: {},
      initialUrl: null,
      hostMode: manager.hostMode,
    });
    assert.ok(!args.some((arg) => arg.startsWith("--cabinet-ui-url")));
    // Everything else is unchanged.
    assert.ok(args.includes("--remote-debugging-pipe"));
    assert.ok(args.some((arg) => arg.startsWith("--user-data-dir=")));
  } finally {
    restore();
  }
});
