"use client";

/**
 * Chromium-fork adapter for CabinetHost. The fork injects a
 * `window.cabinetHost` binding into the shell WebContents only — tab
 * WebContents never see it, which is the privilege boundary. The binding
 * does not exist yet, so every access is defensive (optional chaining plus
 * a web-behavior fallback), and capabilities are computed from whichever
 * members actually exist.
 *
 * tabs / extensions / browser do NOT use the binding: they go over loopback
 * HTTP to the daemon's /api/browser/* routes, which drive the fork's tabs
 * over CDP — identical to the CfT sidecar path today. files.* likewise uses
 * plain HTTP (/api/assets) rather than the binding.
 *
 * Second transport (live): the P1 host extension installs the SAME
 * window.cabinetHost surface via a MAIN-world content script relayed to
 * its service worker, so this adapter runs unchanged inside Chrome. The
 * extension binding deliberately omits `layout` (Chrome owns the window
 * chrome there) and `pdf`, so capabilities stay honest.
 */

import {
  activateTab,
  backTab,
  closeTab,
  disableExtension,
  downloadBrowser,
  enableExtension,
  focusWindow,
  forwardTab,
  getStatus,
  installExtension,
  launch,
  listExtensions,
  listTabs,
  navigateTab,
  openTab,
  pinExtension,
  reloadTab,
  relaunchBrowser,
  setWindowBounds,
  shutdown,
  uninstallExtension,
} from "@/lib/browser/sidecar-client";
import {
  dispatchCabinetToast,
  getNavigatorLike,
  getWindowLike,
  subscribeFullscreenFallback,
} from "./web-host";
import type {
  CabinetHost,
  HostCapabilities,
  HostContentBounds,
  HostPlatform,
} from "./types";

/** The `window.cabinetHost` binding the fork will inject into the shell
 *  WebContents. Every member is optional: the binding is versioned
 *  independently of this code and may be absent entirely in tests. */
type CabinetHostBinding = {
  platform?: string;
  layout?: {
    setContentBounds?: (
      bounds: HostContentBounds | null,
    ) => Promise<{ ok: boolean }> | { ok: boolean };
  };
  windows?: {
    open?: (path: string) => unknown;
    focus?: () => Promise<{ ok: boolean }> | { ok: boolean };
    relaunch?: () => unknown;
    onFullscreenChanged?: (
      listener: (fullscreen: boolean) => void,
    ) => () => void;
  };
  system?: {
    openExternal?: (
      url: string,
    ) => Promise<{ ok: boolean }> | { ok: boolean };
    openPath?: (
      path: string,
    ) =>
      | Promise<{ ok: boolean; error?: string }>
      | { ok: boolean; error?: string };
    preferredLanguages?: () => Promise<{
      preferred?: string[];
      locale?: string;
      system?: string;
    }>;
    showToast?: (payload: {
      kind?: string;
      message: string;
      durationMs?: number;
    }) => Promise<{ ok: boolean }> | { ok: boolean };
  };
  pdf?: {
    save?: (payload: {
      filename: string;
      paperSize: "a4" | "letter";
      orientation: "portrait" | "landscape";
    }) => Promise<{
      ok: boolean;
      canceled?: boolean;
      path?: string;
      error?: string;
    }>;
  };
};

function getBinding(): CabinetHostBinding | undefined {
  return (
    (globalThis as { window?: { cabinetHost?: CabinetHostBinding } }).window
      ?.cabinetHost
  );
}

function toHostPlatform(value: string | undefined): HostPlatform {
  return value === "darwin" ||
    value === "win32" ||
    value === "linux" ||
    value === "web"
    ? value
    : "darwin";
}

// files.* runs over the app's own /api/assets/[...path] route (verified
// against src/app/api/assets/[...path]/route.ts): GET returns the raw file
// bytes; PUT takes the raw text body (req.text()) with a text content-type —
// binary document extensions are rejected there by policy and must go
// through /api/documents/save.
function assetUrl(path: string): string {
  const segments = path.split("/").filter(Boolean).map(encodeURIComponent);
  return `/api/assets/${segments.join("/")}`;
}

async function readAssetFile(
  path: string,
): Promise<{ ok: boolean; content?: string; error?: string }> {
  try {
    const res = await fetch(assetUrl(path));
    if (!res.ok) {
      return { ok: false, error: res.statusText || `HTTP ${res.status}` };
    }
    return { ok: true, content: await res.text() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function writeAssetFile(
  path: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(assetUrl(path), {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: content,
    });
    if (!res.ok) {
      return { ok: false, error: res.statusText || `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function createChromiumHost(): CabinetHost {
  const binding = getBinding();
  const hasPdfSave = typeof binding?.pdf?.save === "function";

  const capabilities: HostCapabilities = {
    layout: typeof binding?.layout?.setContentBounds === "function",
    windows: true,
    files: true,
    pdf: hasPdfSave,
    uninstall: false,
    preferredLanguages:
      typeof binding?.system?.preferredLanguages === "function",
    toast: true,
    shell: true,
    browserView: false,
  };

  return {
    kind: "chromium",
    platform: toHostPlatform(binding?.platform),
    capabilities,

    tabs: {
      list: listTabs,
      open: openTab,
      activate: async (id) => (await activateTab(id)).tab,
      close: closeTab,
      navigate: async (id, url) => (await navigateTab(id, url)).tab,
      back: backTab,
      forward: forwardTab,
      reload: reloadTab,
    },
    extensions: {
      list: listExtensions,
      install: installExtension,
      uninstall: uninstallExtension,
      enable: enableExtension,
      disable: disableExtension,
      setPinned: pinExtension,
    },
    browser: {
      status: getStatus,
      launch,
      shutdown,
      download: downloadBrowser,
      setWindowBounds,
      focus: focusWindow,
    },

    layout: {
      setContentBounds: (bounds) => {
        const setContentBounds = getBinding()?.layout?.setContentBounds;
        return setContentBounds
          ? Promise.resolve(setContentBounds(bounds))
          : Promise.resolve({ ok: false });
      },
    },

    windows: {
      open: (path) => {
        const open = getBinding()?.windows?.open;
        if (typeof open === "function") return Promise.resolve(open(path));
        const win = getWindowLike();
        const url = `${win?.location?.origin ?? ""}${path}`;
        return Promise.resolve(win?.open?.(url, "_blank", "noopener") ?? null);
      },
      focus: () => {
        const focus = getBinding()?.windows?.focus;
        if (typeof focus === "function") return Promise.resolve(focus());
        getWindowLike()?.focus?.();
        return Promise.resolve({ ok: true });
      },
      relaunch: async () => {
        // The daemon owns the managed browser process, so relaunch goes
        // through it atomically: the browser's own AttemptRelaunch drops
        // --cabinet-ui-url/--user-data-dir on macOS (LaunchServices relaunches
        // the bare bundle), and a client-side shutdown→launch sequence dies
        // with the browser mid-way. The fetch usually cuts off when the
        // process exits — that is expected.
        try {
          await relaunchBrowser();
          return { ok: true };
        } catch {
          const relaunch = getBinding()?.windows?.relaunch;
          if (typeof relaunch === "function") {
            return Promise.resolve(relaunch());
          }
          getWindowLike()?.location?.reload?.();
          return { ok: true };
        }
      },
      onFullscreenChanged: (listener) => {
        const subscribe = getBinding()?.windows?.onFullscreenChanged;
        return typeof subscribe === "function"
          ? subscribe(listener)
          : subscribeFullscreenFallback(listener);
      },
    },

    system: {
      openExternal: (url) => {
        const openExternal = getBinding()?.system?.openExternal;
        if (typeof openExternal === "function") {
          return Promise.resolve(openExternal(url));
        }
        getWindowLike()?.open?.(url, "_blank", "noopener,noreferrer");
        return Promise.resolve({ ok: true });
      },
      openPath: (path) => {
        const openPath = getBinding()?.system?.openPath;
        return typeof openPath === "function"
          ? Promise.resolve(openPath(path))
          : Promise.resolve({ ok: false, error: "unsupported" });
      },
      preferredLanguages: () => {
        const preferredLanguages = getBinding()?.system?.preferredLanguages;
        if (typeof preferredLanguages === "function") {
          return preferredLanguages();
        }
        const nav = getNavigatorLike();
        return Promise.resolve({
          preferred: [...(nav?.languages ?? [])],
          locale: nav?.language,
        });
      },
      showToast: (payload) => {
        const showToast = getBinding()?.system?.showToast;
        return typeof showToast === "function"
          ? Promise.resolve(showToast(payload))
          : Promise.resolve(dispatchCabinetToast(payload));
      },
      uninstall: () => Promise.resolve({ ok: false, error: "unsupported" }),
    },

    files: {
      read: readAssetFile,
      write: writeAssetFile,
    },

    // Only present when the binding actually provides it; callers fall back
    // to window.print() otherwise.
    pdf: hasPdfSave
      ? {
          save: (payload) =>
            Promise.resolve(
              getBinding()?.pdf?.save?.(payload) ?? { ok: false },
            ),
        }
      : undefined,
  };
}
