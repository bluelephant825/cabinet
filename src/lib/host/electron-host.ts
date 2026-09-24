"use client";

/**
 * Electron adapter for CabinetHost: a thin wrapper over the
 * `window.CabinetDesktop` contextBridge that electron/preload.cjs exposes.
 * The bridge is the privilege boundary — every method here is an
 * ipcRenderer.invoke in disguise, except the on* subscribers, which are
 * preload-side fan-out registries returning unsubscribe functions.
 *
 * tabs / extensions / browser do NOT go through the bridge: they use the
 * daemon's /api/browser/* loopback HTTP API (sidecar-client), identical to
 * the other hosts. Bridge methods that are missing degrade to
 * `{ ok: false }`-shaped results rather than throwing; callers already
 * feature-check via capabilities.
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
  setWindowBounds,
  shutdown,
  uninstallExtension,
} from "@/lib/browser/sidecar-client";
import { dispatchCabinetToast, subscribeOpenUrlFallback } from "./web-host";
import type {
  CabinetHost,
  HostBookmarkMenuItem,
  HostBrowserViewLoadFailed,
  HostBrowserViewNavResult,
  HostCapabilities,
  HostPlatform,
  HostRect,
  HostWindowGeometry,
} from "./types";

/** The window.CabinetDesktop surface (electron/preload.cjs), all optional
 *  so an older/partial preload degrades instead of throwing. */
type CabinetDesktopBridge = {
  runtime?: string;
  platform?: string;
  createBrowserView?: (
    url: string,
  ) => Promise<{ ok: boolean; viewId?: string }>;
  loadBrowserViewUrl?: (
    viewId: string,
    url: string,
  ) => Promise<HostBrowserViewNavResult>;
  setBrowserViewBounds?: (
    viewId: string,
    bounds: HostRect,
  ) => Promise<{ ok: boolean }>;
  setBrowserViewVisible?: (
    viewId: string,
    visible: boolean,
  ) => Promise<{ ok: boolean }>;
  browserViewGoBack?: (viewId: string) => Promise<HostBrowserViewNavResult>;
  browserViewGoForward?: (
    viewId: string,
  ) => Promise<HostBrowserViewNavResult>;
  browserViewReload?: (viewId: string) => Promise<HostBrowserViewNavResult>;
  showBrowserBookmarksMenu?: (payload: {
    x: number;
    y: number;
    items: HostBookmarkMenuItem[];
  }) => Promise<{ ok: boolean; cancelled?: boolean; id?: string; url?: string }>;
  destroyBrowserView?: (viewId: string) => Promise<{ ok: boolean }>;
  executeBrowserViewJavaScript?: (
    viewId: string,
    code: string,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  openBrowserViewDevTools?: (
    viewId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onBrowserViewNavigated?: (
    listener: (payload: { viewId?: string; url?: string }) => void,
  ) => () => void;
  onBrowserViewLoadFailed?: (
    listener: (payload: HostBrowserViewLoadFailed) => void,
  ) => () => void;
  onBrowserViewNavigateRequest?: (
    listener: (payload: { url?: string }) => void,
  ) => () => void;
  onBrowserViewClosed?: (
    listener: (payload: { viewId?: string }) => void,
  ) => () => void;
  uninstallApp?: () => Promise<{
    ok: boolean;
    dataPath?: string;
    error?: string;
  }>;
  relaunch?: () => Promise<unknown>;
  openLocalFile?: (
    path: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  openExternal?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  getPreferredLanguages?: () => Promise<{
    preferred?: string[];
    locale?: string;
    system?: string;
  }>;
  openWindow?: (path: string) => Promise<unknown>;
  getWindowGeometry?: () => Promise<HostWindowGeometry>;
  focusAppWindow?: () => Promise<{ ok: boolean }>;
  onWindowGeometryChanged?: (
    listener: (payload: HostWindowGeometry) => void,
  ) => () => void;
  showNativeToast?: (payload: {
    kind?: string;
    message: string;
    durationMs?: number;
  }) => Promise<{ ok: boolean }>;
  readFile?: (
    path: string,
  ) => Promise<{ ok: boolean; content?: string; error?: string }>;
  writeFile?: (
    path: string,
    content: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  savePdf?: (payload: {
    filename: string;
    paperSize: "a4" | "letter";
    orientation: "portrait" | "landscape";
  }) => Promise<{
    ok: boolean;
    canceled?: boolean;
    path?: string;
    error?: string;
  }>;
  onFullscreenChanged?: (
    listener: (fullscreen: boolean) => void,
  ) => () => void;
};

function getBridge(): CabinetDesktopBridge {
  return (
    (globalThis as { window?: { CabinetDesktop?: CabinetDesktopBridge } })
      .window?.CabinetDesktop ?? {}
  );
}

const NOOP_UNSUBSCRIBE = () => {};

function toHostPlatform(value: string | undefined): HostPlatform {
  return value === "darwin" || value === "win32" || value === "linux"
    ? value
    : "web";
}

export function createElectronHost(): CabinetHost {
  const bridge = getBridge();

  const capabilities: HostCapabilities = {
    layout: false,
    windows: true,
    files: true,
    pdf: true,
    uninstall: true,
    preferredLanguages: true,
    toast: true,
    shell: true,
    browserView: true,
    deepLinks: false,
  };

  return {
    kind: "electron",
    platform: toHostPlatform(bridge.platform),
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
      triggerAction: () => Promise.resolve({ ok: false, error: "unsupported" }),
    },
    browser: {
      status: getStatus,
      launch,
      shutdown,
      download: downloadBrowser,
      setWindowBounds,
      focus: focusWindow,
    },

    // The WebContentsView layout path lives under `electron.*` instead.
    layout: {
      setContentBounds: () => Promise.resolve({ ok: false }),
    },

    windows: {
      open: (path) =>
        bridge.openWindow?.(path) ?? Promise.resolve({ ok: false }),
      focus: () =>
        bridge.focusAppWindow?.() ?? Promise.resolve({ ok: false }),
      relaunch: () =>
        bridge.relaunch?.() ?? Promise.resolve({ ok: false }),
      onFullscreenChanged: (listener) => {
        if (typeof bridge.onFullscreenChanged === "function") {
          return bridge.onFullscreenChanged(listener);
        }
        listener(false);
        return NOOP_UNSUBSCRIBE;
      },
    },

    system: {
      openExternal: (url) =>
        bridge.openExternal?.(url) ?? Promise.resolve({ ok: false }),
      openPath: (path) =>
        bridge.openLocalFile?.(path) ??
        Promise.resolve({ ok: false, error: "unsupported" }),
      preferredLanguages: () =>
        bridge.getPreferredLanguages?.() ?? Promise.resolve({}),
      showToast: (payload) =>
        bridge.showNativeToast?.(payload) ??
        Promise.resolve(dispatchCabinetToast(payload)),
      uninstall: () =>
        bridge.uninstallApp?.() ??
        Promise.resolve({ ok: false, error: "unsupported" }),
      onOpenUrl: subscribeOpenUrlFallback,
    },

    files: {
      read: (path) =>
        bridge.readFile?.(path) ??
        Promise.resolve({ ok: false, error: "unsupported" }),
      write: (path, content) =>
        bridge.writeFile?.(path, content) ??
        Promise.resolve({ ok: false, error: "unsupported" }),
    },

    pdf: {
      save: (payload) =>
        bridge.savePdf?.(payload) ??
        Promise.resolve({ ok: false, error: "unsupported" }),
    },

    electron: {
      createBrowserView: (url) =>
        bridge.createBrowserView?.(url) ?? Promise.resolve({ ok: false }),
      loadBrowserViewUrl: (viewId, url) =>
        bridge.loadBrowserViewUrl?.(viewId, url) ??
        Promise.resolve({ ok: false }),
      setBrowserViewBounds: (viewId, bounds) =>
        bridge.setBrowserViewBounds?.(viewId, bounds) ??
        Promise.resolve({ ok: false }),
      setBrowserViewVisible: (viewId, visible) =>
        bridge.setBrowserViewVisible?.(viewId, visible) ??
        Promise.resolve({ ok: false }),
      browserViewGoBack: (viewId) =>
        bridge.browserViewGoBack?.(viewId) ?? Promise.resolve({ ok: false }),
      browserViewGoForward: (viewId) =>
        bridge.browserViewGoForward?.(viewId) ??
        Promise.resolve({ ok: false }),
      browserViewReload: (viewId) =>
        bridge.browserViewReload?.(viewId) ?? Promise.resolve({ ok: false }),
      showBrowserBookmarksMenu: (payload) =>
        bridge.showBrowserBookmarksMenu?.(payload) ??
        Promise.resolve({ ok: false }),
      destroyBrowserView: (viewId) =>
        bridge.destroyBrowserView?.(viewId) ?? Promise.resolve({ ok: false }),
      executeBrowserViewJavaScript: (viewId, code) =>
        bridge.executeBrowserViewJavaScript?.(viewId, code) ??
        Promise.resolve({ ok: false }),
      openBrowserViewDevTools: (viewId) =>
        bridge.openBrowserViewDevTools?.(viewId) ??
        Promise.resolve({ ok: false }),
      onBrowserViewNavigated: (listener) =>
        bridge.onBrowserViewNavigated?.(listener) ?? NOOP_UNSUBSCRIBE,
      onBrowserViewLoadFailed: (listener) =>
        bridge.onBrowserViewLoadFailed?.(listener) ?? NOOP_UNSUBSCRIBE,
      onBrowserViewNavigateRequest: (listener) =>
        bridge.onBrowserViewNavigateRequest?.(listener) ?? NOOP_UNSUBSCRIBE,
      onBrowserViewClosed: (listener) =>
        bridge.onBrowserViewClosed?.(listener) ?? NOOP_UNSUBSCRIBE,
      getWindowGeometry: () =>
        bridge.getWindowGeometry?.() ?? Promise.resolve({ ok: false }),
      onWindowGeometryChanged: (listener) =>
        bridge.onWindowGeometryChanged?.(listener) ?? NOOP_UNSUBSCRIBE,
    },
  };
}
