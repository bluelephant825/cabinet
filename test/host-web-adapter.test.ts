import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { getHost } from "@/lib/host";

// The web adapter reads window/navigator/document through globalThis so the
// tests inject stubs and restore the originals afterwards. getHost() caches
// a singleton per process; with no cabinetHost/CabinetDesktop on the stub
// window it is always the web host in this file.
const originalWindow = (globalThis as { window?: unknown }).window;
const originalNavigator = Object.getOwnPropertyDescriptor(
  globalThis,
  "navigator",
);

afterEach(() => {
  if (originalWindow === undefined) {
    delete (globalThis as { window?: unknown }).window;
  } else {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
  if (originalNavigator) {
    Object.defineProperty(globalThis, "navigator", originalNavigator);
  }
});

test("web host reports kind, platform and all-false capabilities", () => {
  (globalThis as { window?: unknown }).window = {};
  const host = getHost();
  assert.equal(host.kind, "web");
  assert.equal(host.platform, "web");
  assert.deepEqual(host.capabilities, {
    layout: false,
    windows: false,
    files: false,
    pdf: false,
    uninstall: false,
    preferredLanguages: false,
    toast: false,
    shell: false,
    browserView: false,
  });
});

test("web host leaves files, pdf and electron absent", () => {
  const host = getHost();
  assert.equal(host.files, undefined);
  assert.equal(host.pdf, undefined);
  assert.equal(host.electron, undefined);
});

test("windows.open opens origin + path in a new tab", async () => {
  const calls: Array<{ url: string; target?: string }> = [];
  (globalThis as { window?: unknown }).window = {
    location: { origin: "https://cabinet.test" },
    open: (url: string, target?: string) => {
      calls.push({ url, target });
      return null;
    },
  };
  const host = getHost();
  await host.windows.open("/room/a/b");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://cabinet.test/room/a/b");
  assert.equal(calls[0].target, "_blank");
});

test("windows.focus calls window.focus and resolves ok", async () => {
  let focused = 0;
  (globalThis as { window?: unknown }).window = {
    focus: () => {
      focused += 1;
    },
  };
  const host = getHost();
  assert.deepEqual(await host.windows.focus(), { ok: true });
  assert.equal(focused, 1);
});

test("windows.relaunch calls location.reload", async () => {
  let reloaded = 0;
  (globalThis as { window?: unknown }).window = {
    location: {
      reload: () => {
        reloaded += 1;
      },
    },
  };
  const host = getHost();
  await host.windows.relaunch();
  assert.equal(reloaded, 1);
});

test("onFullscreenChanged fires immediately then on change", () => {
  let handler: (() => void) | null = null;
  (globalThis as { window?: unknown }).window = {
    document: {
      fullscreenElement: null,
      addEventListener: (_type: string, listener: () => void) => {
        handler = listener;
      },
      removeEventListener: () => {},
    },
  };
  const host = getHost();
  const states: boolean[] = [];
  const unsubscribe = host.windows.onFullscreenChanged((fs) =>
    states.push(fs),
  );
  assert.deepEqual(states, [false]);
  assert.ok(handler);
  unsubscribe();
});

test("layout.setContentBounds resolves ok:false on the web", async () => {
  const host = getHost();
  assert.deepEqual(await host.layout.setContentBounds(null), { ok: false });
});

test("system.openPath is unsupported on the web", async () => {
  const host = getHost();
  assert.deepEqual(await host.system.openPath("/tmp/x"), {
    ok: false,
    error: "unsupported",
  });
});

test("system.uninstall is unsupported on the web", async () => {
  const host = getHost();
  assert.deepEqual(await host.system.uninstall(), {
    ok: false,
    error: "unsupported",
  });
});

test("system.preferredLanguages reflects navigator.languages", async () => {
  Object.defineProperty(globalThis, "navigator", {
    value: { languages: ["fr-FR", "en-US"], language: "fr-FR" },
    configurable: true,
  });
  const host = getHost();
  const res = await host.system.preferredLanguages();
  assert.deepEqual(res.preferred, ["fr-FR", "en-US"]);
  assert.equal(res.locale, "fr-FR");
});

test("system.openExternal opens a new tab with noopener", async () => {
  const calls: Array<{ url: string; features?: string }> = [];
  (globalThis as { window?: unknown }).window = {
    open: (url: string, _target?: string, features?: string) => {
      calls.push({ url, features });
      return null;
    },
  };
  const host = getHost();
  assert.deepEqual(await host.system.openExternal("https://example.com"), {
    ok: true,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://example.com");
  assert.equal(calls[0].features, "noopener,noreferrer");
});
