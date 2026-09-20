import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  appOriginMatches,
  ensureHostExtensionFiles,
  installHostExtension,
  isHostExtensionEnabled,
} from "../server/browser/host-extension";
import {
  ensureHostExtensionEmbedToken,
  getHostExtensionEmbedToken,
} from "../src/lib/auth/embed-token";
import { hostExtensionDir } from "../server/browser/paths";
import { handleBrowserRequest, type BrowserFacade } from "../server/browser/http";
import { BrowserError } from "../server/browser/types";
import type { CDPClient } from "../server/browser/cdp-client";

process.env.CABINET_DAEMON_TOKEN ??= "test-browser-token";
const TOKEN = process.env.CABINET_DAEMON_TOKEN;

const ENV_KEYS = [
  "CABINET_BROWSER_HOST_EXTENSION",
  "CABINET_USER_DATA",
  "CABINET_DATA_DIR",
] as const;

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

function withTempDirs(): { userData: string; dataDir: string; cleanup: () => void } {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-ext-userdata-"));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabinet-ext-data-"));
  process.env.CABINET_USER_DATA = userData;
  process.env.CABINET_DATA_DIR = dataDir;
  return {
    userData,
    dataDir,
    cleanup: () => {
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

test("host extension enabled via CABINET_BROWSER_HOST_EXTENSION env", () => {
  const restore = saveEnv();
  try {
    delete process.env.CABINET_BROWSER_HOST_EXTENSION;
    delete process.env.CABINET_USER_DATA;
    assert.equal(isHostExtensionEnabled(), false);
    process.env.CABINET_BROWSER_HOST_EXTENSION = "1";
    assert.equal(isHostExtensionEnabled(), true);
    process.env.CABINET_BROWSER_HOST_EXTENSION = "true";
    assert.equal(isHostExtensionEnabled(), true);
    process.env.CABINET_BROWSER_HOST_EXTENSION = "0";
    assert.equal(isHostExtensionEnabled(), false);
  } finally {
    restore();
  }
});

test("host extension enabled via browser.hostExtension in cabinet-config.json", () => {
  const restore = saveEnv();
  const { userData, cleanup } = withTempDirs();
  try {
    delete process.env.CABINET_BROWSER_HOST_EXTENSION;
    fs.writeFileSync(
      path.join(userData, "cabinet-config.json"),
      JSON.stringify({ browser: { hostExtension: true } }),
    );
    assert.equal(isHostExtensionEnabled(), true);
  } finally {
    cleanup();
    restore();
  }
});

test("appOriginMatches derives host-wide match patterns (no port in match patterns)", () => {
  assert.deepEqual(appOriginMatches("http://127.0.0.1:4000"), [
    "http://127.0.0.1/*",
  ]);
  assert.deepEqual(appOriginMatches("http://localhost:4555"), [
    "http://localhost/*",
  ]);
  assert.deepEqual(appOriginMatches("not a url"), []);
});

test("ensureHostExtensionFiles generates a valid MV3 bundle with baked-in origin", async () => {
  const restore = saveEnv();
  const { cleanup } = withTempDirs();
  try {
    const info = await ensureHostExtensionFiles({
      appOrigin: "http://127.0.0.1:4555",
      platform: "darwin",
    });
    assert.equal(info.dir, hostExtensionDir());
    assert.equal(info.changed, true);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(info.dir, "manifest.json"), "utf8"),
    );
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.chrome_url_overrides.newtab, "ntp.html");
    assert.equal(manifest.side_panel.default_path, "sidepanel.html");
    assert.deepEqual(manifest.content_scripts[0].matches, [
      "http://127.0.0.1/*",
    ]);
    const mainWorld = manifest.content_scripts.find(
      (cs: { world?: string }) => cs.world === "MAIN",
    );
    assert.ok(mainWorld, "MAIN-world inject script declared");
    assert.deepEqual(mainWorld.js, ["inject.js"]);

    const inject = fs.readFileSync(path.join(info.dir, "inject.js"), "utf8");
    assert.ok(inject.includes('var ORIGIN = "http://127.0.0.1:4555"'));
    assert.ok(inject.includes("window.cabinetHost"));
    assert.ok(inject.includes('"darwin"'));
    // No layout member: capabilities.layout must stay false on this host.
    assert.ok(!inject.includes("setContentBounds"));

    const sw = fs.readFileSync(path.join(info.dir, "sw.js"), "utf8");
    assert.ok(sw.includes('var APP_ORIGIN = "http://127.0.0.1:4555"'));

    const panelHtml = fs.readFileSync(
      path.join(info.dir, "sidepanel.html"),
      "utf8",
    );
    // MV3 extension pages forbid inline script — the logic must be external.
    assert.ok(!/<script>/.test(panelHtml));
    assert.ok(panelHtml.includes('src="sidepanel.js"'));
    const panel = fs.readFileSync(path.join(info.dir, "sidepanel.js"), "utf8");
    assert.ok(panel.includes("/api/auth/check"));
    assert.ok(panel.includes("/login?embedToken="));

    // The generated sidepanel carries the persisted per-install embed token.
    const token = getHostExtensionEmbedToken();
    assert.ok(token && /^[0-9a-f]{64}$/.test(token));
    assert.ok(panel.includes(`"${token}"`) || panel.includes(token));
  } finally {
    cleanup();
    restore();
  }
});

test("ensureHostExtensionFiles is idempotent and reports changes", async () => {
  const restore = saveEnv();
  const { cleanup } = withTempDirs();
  try {
    const first = await ensureHostExtensionFiles({
      appOrigin: "http://127.0.0.1:4000",
      platform: "darwin",
    });
    assert.equal(first.changed, true);
    const second = await ensureHostExtensionFiles({
      appOrigin: "http://127.0.0.1:4000",
      platform: "darwin",
    });
    assert.equal(second.changed, false);
    assert.equal(second.contentHash, first.contentHash);
    const third = await ensureHostExtensionFiles({
      appOrigin: "http://127.0.0.1:4999",
      platform: "darwin",
    });
    assert.equal(third.changed, true);
    assert.notEqual(third.contentHash, first.contentHash);
  } finally {
    cleanup();
    restore();
  }
});

test("embed token persists across calls", () => {
  const restore = saveEnv();
  const { cleanup } = withTempDirs();
  try {
    const a = ensureHostExtensionEmbedToken();
    const b = ensureHostExtensionEmbedToken();
    assert.equal(a, b);
    assert.equal(getHostExtensionEmbedToken(), a);
  } finally {
    cleanup();
    restore();
  }
});

type FakeCdp = CDPClient & { calls: { method: string; params: unknown }[] };

function fakeCdp(behavior: (method: string) => unknown): FakeCdp {
  const calls: { method: string; params: unknown }[] = [];
  return {
    calls,
    send: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      const result = behavior(method);
      if (result instanceof Error) throw result;
      return result;
    },
  } as unknown as FakeCdp;
}

test("installHostExtension loads unpacked and records the runtime id", async () => {
  const restore = saveEnv();
  const { cleanup } = withTempDirs();
  try {
    const info = await ensureHostExtensionFiles({
      appOrigin: "http://127.0.0.1:4000",
      platform: "darwin",
    });
    const cdp = fakeCdp(() => ({ id: "aaaaaaaabbbbbbbbccccccccdddddddd" }));
    const id = await installHostExtension(cdp, info);
    assert.equal(id, "aaaaaaaabbbbbbbbccccccccdddddddd");
    assert.deepEqual(
      cdp.calls.map((c) => c.method),
      ["Extensions.loadUnpacked"],
    );
    assert.equal(
      (cdp.calls[0].params as { path: string }).path,
      info.dir,
    );
  } finally {
    cleanup();
    restore();
  }
});

test("installHostExtension tolerates an already-loaded profile-persisted extension", async () => {
  const restore = saveEnv();
  const { cleanup } = withTempDirs();
  try {
    const info = await ensureHostExtensionFiles({
      appOrigin: "http://127.0.0.1:4000",
      platform: "darwin",
    });
    // First launch: load succeeds, id + hash recorded.
    const cdp1 = fakeCdp(() => ({ id: "extidextidextidextidextid001" }));
    await installHostExtension(cdp1, info);

    // Second launch, unchanged files: "already loaded" -> keep stored id,
    // no uninstall/reload churn.
    const cdp2 = fakeCdp(() => {
      throw new Error("Extension is already loaded");
    });
    const id = await installHostExtension(cdp2, { ...info, changed: false });
    assert.equal(id, "extidextidextidextidextid001");
    assert.equal(
      cdp2.calls.some((c) => c.method === "Extensions.uninstall"),
      false,
    );
  } finally {
    cleanup();
    restore();
  }
});

test("installHostExtension reloads when generated files changed", async () => {
  const restore = saveEnv();
  const { cleanup } = withTempDirs();
  try {
    const info = await ensureHostExtensionFiles({
      appOrigin: "http://127.0.0.1:4000",
      platform: "darwin",
    });
    const cdp1 = fakeCdp(() => ({ id: "extidextidextidextidextid001" }));
    await installHostExtension(cdp1, info);

    // Regenerate with a different origin -> changed files + new hash.
    const updated = await ensureHostExtensionFiles({
      appOrigin: "http://127.0.0.1:4999",
      platform: "darwin",
    });
    assert.equal(updated.changed, true);

    const calls: string[] = [];
    const cdp2 = {
      send: async (method: string) => {
        calls.push(method);
        if (method === "Extensions.loadUnpacked" && calls.length === 1) {
          throw new Error("Extension is already loaded");
        }
        if (method === "Extensions.uninstall") return {};
        return { id: "extidextidextidextidextid002" };
      },
    } as unknown as CDPClient;
    const id = await installHostExtension(cdp2, updated);
    assert.equal(id, "extidextidextidextidextid002");
    assert.deepEqual(calls, [
      "Extensions.loadUnpacked",
      "Extensions.uninstall",
      "Extensions.loadUnpacked",
    ]);
  } finally {
    cleanup();
    restore();
  }
});

// --- /browser/status surfaces hostExtension -------------------------------

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
    extractTab: async () => ({}),
    screenshotTab: async () => Buffer.from([0x89]),
    listExtensions: async () => [],
    installExtension: async () => {
      throw new BrowserError("invalid", "nope");
    },
    uninstallExtension: async () => ({ ok: true }),
    enableExtension: async () => { throw new BrowserError("not-found", "x"); },
    disableExtension: async () => { throw new BrowserError("not-found", "x"); },
    pinExtension: async () => { throw new BrowserError("not-found", "x"); },
    setWindowBounds: async () => ({ ok: true }),
    focusWindow: async () => ({ ok: true }),
    ...overrides,
  };
}

test("GET /browser/status reports hostExtension enablement and id", async () => {
  const server = http.createServer((req, res) => {
    void handleBrowserRequest(
      req,
      res,
      fakeBrowser({
        hostExtension: () => ({ enabled: true, id: "extid123" }),
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const res = await fetch(`${base}/browser/status`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body.hostExtension, { enabled: true, id: "extid123" });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
