/**
 * CabinetHost types: the renderer-side seam between the app and the shell
 * that hosts it. Three hosts implement this interface:
 *
 *   - electron: today's desktop shell. Privileged surface arrives over the
 *     `window.CabinetDesktop` contextBridge exposed by electron/preload.cjs.
 *   - chromium: the forthcoming Chromium fork. The fork injects a
 *     `window.cabinetHost` binding into the shell WebContents only (tab
 *     WebContents never see it), which is the privilege boundary.
 *   - web: a plain browser tab. Only the daemon-backed namespaces work.
 *
 * Privilege boundary note: tabs/extensions/browser ALWAYS go over loopback
 * HTTP to the Cabinet daemon (/api/browser/*), which drives the real browser
 * engine over CDP. That path is identical whether the engine is today's
 * Chrome-for-Testing sidecar or the fork later, so those namespaces are
 * uniform across hosts. Everything else (windows, system, files, pdf,
 * layout, the electron WebContentsView extras) is host-privileged and
 * degrades to `{ ok: false }`-shaped results when a host cannot provide it.
 */

import type { SidecarExtension } from "@/lib/browser/sidecar-client";

export type { SidecarExtension };

export type HostKind = "electron" | "chromium" | "web";
export type HostPlatform = "darwin" | "win32" | "linux" | "web";

export type HostCapabilities = {
  layout: boolean; // host can position real tab content inside the shell window (chromium only)
  windows: boolean; // native window open/focus/relaunch + fullscreen events
  files: boolean; // files.read/write available
  pdf: boolean; // pdf.save native print-to-PDF + save dialog
  uninstall: boolean; // native uninstall flow
  preferredLanguages: boolean; // OS-level language list beyond navigator
  toast: boolean; // native toast; adapters may fall back to the in-app cabinet:toast event
  shell: boolean; // openExternal/openPath against the OS
  browserView: boolean; // electron WebContentsView surface exists (electron only)
};

export type HostRect = { x: number; y: number; width: number; height: number };
export type HostTab = {
  id: string;
  targetId: string;
  url: string;
  title: string;
  active: boolean;
};
export type HostStatus = {
  status: string;
  available: boolean;
  eligible: boolean;
  version: string;
  hostMode?: boolean;
  /** P1 host extension: enabled flag + runtime id once loaded into the
   *  browser. Absent on older daemons. */
  hostExtension?: { enabled: boolean; id: string | null };
  error?: string;
  download?: { downloadedBytes: number; totalBytes: number };
};

// --- Payload shapes for the electron WebContentsView extras ---------------
// These mirror the BrowserBridge type in src/components/layout/browser-view.tsx
// verbatim, so call sites can move over without re-shaping data.

export type HostBrowserViewNavResult = {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  loadedUrl?: string;
  primaryUrl?: string;
  fallbackUrl?: string | null;
  primaryError?: string;
  fallbackError?: string;
};

export type HostBookmarkMenuItem = {
  id: string;
  name: string;
  type: "url" | "folder";
  url?: string;
  children?: HostBookmarkMenuItem[];
};

export type HostBrowserViewLoadFailed = {
  viewId?: string;
  requestedUrl?: string;
  primaryUrl?: string;
  fallbackUrl?: string;
  primaryError?: string;
  fallbackError?: string;
  errorCode?: number;
  errorDescription?: string;
  validatedUrl?: string;
};

export type HostWindowGeometry = {
  ok?: boolean;
  contentBounds?: HostRect;
  focused?: boolean;
  minimized?: boolean;
  visible?: boolean;
  fullscreen?: boolean;
};

export type ElectronHostExtras = {
  createBrowserView: (url: string) => Promise<{ ok: boolean; viewId?: string }>;
  loadBrowserViewUrl: (
    viewId: string,
    url: string,
  ) => Promise<HostBrowserViewNavResult>;
  setBrowserViewBounds: (
    viewId: string,
    bounds: HostRect,
  ) => Promise<{ ok: boolean }>;
  setBrowserViewVisible: (
    viewId: string,
    visible: boolean,
  ) => Promise<{ ok: boolean }>;
  browserViewGoBack: (viewId: string) => Promise<HostBrowserViewNavResult>;
  browserViewGoForward: (viewId: string) => Promise<HostBrowserViewNavResult>;
  browserViewReload: (viewId: string) => Promise<HostBrowserViewNavResult>;
  showBrowserBookmarksMenu: (payload: {
    x: number;
    y: number;
    items: HostBookmarkMenuItem[];
  }) => Promise<{ ok: boolean; cancelled?: boolean; id?: string; url?: string }>;
  destroyBrowserView: (viewId: string) => Promise<{ ok: boolean }>;
  executeBrowserViewJavaScript?: (
    viewId: string,
    code: string,
  ) => Promise<{ ok: boolean; result?: unknown; error?: string }>;
  openBrowserViewDevTools?: (
    viewId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  onBrowserViewNavigated: (
    listener: (payload: { viewId?: string; url?: string }) => void,
  ) => () => void;
  onBrowserViewLoadFailed: (
    listener: (payload: HostBrowserViewLoadFailed) => void,
  ) => () => void;
  onBrowserViewNavigateRequest?: (
    listener: (payload: { url?: string }) => void,
  ) => () => void;
  onBrowserViewClosed?: (
    listener: (payload: { viewId?: string }) => void,
  ) => () => void;
  getWindowGeometry?: () => Promise<HostWindowGeometry>;
  onWindowGeometryChanged?: (
    listener: (payload: HostWindowGeometry) => void,
  ) => () => void;
};

export interface CabinetHost {
  readonly kind: HostKind;
  readonly platform: HostPlatform;
  readonly capabilities: Readonly<HostCapabilities>;

  /**
   * Browser-engine tabs. Implemented on every host: these go over loopback
   * HTTP to the daemon's /browser/* API, which drives the real browser via
   * CDP (the CfT sidecar today, the fork's own tabs later).
   */
  tabs: {
    list(): Promise<HostTab[]>;
    open(url: string): Promise<HostTab>;
    activate(id: string): Promise<HostTab>;
    close(id: string): Promise<{ ok: boolean }>;
    navigate(id: string, url: string): Promise<HostTab>;
    back(id: string): Promise<{ ok: boolean; skipped?: boolean }>;
    forward(id: string): Promise<{ ok: boolean; skipped?: boolean }>;
    reload(id: string): Promise<{ ok: boolean }>;
  };

  /**
   * Browser-engine extensions. Same daemon transport as `tabs`: the daemon
   * installs/loads them into whichever engine it drives over CDP.
   */
  extensions: {
    list(): Promise<SidecarExtension[]>;
    install(idOrUrl: string): Promise<SidecarExtension>;
    uninstall(id: string): Promise<{ ok: boolean }>;
    enable(id: string): Promise<SidecarExtension>;
    disable(id: string): Promise<SidecarExtension>;
    setPinned(id: string, pinned: boolean): Promise<SidecarExtension>;
  };

  /**
   * Browser-engine lifecycle. Mirrors the daemon's /browser/status +
   * control routes; identical on every host for the same reason as `tabs`.
   */
  browser: {
    status(): Promise<HostStatus>;
    launch(): Promise<{ ok: boolean; status: string }>;
    shutdown(): Promise<{ ok: boolean; status: string }>;
    download(): Promise<{ ok: boolean; status: string }>;
    setWindowBounds(b: {
      x?: number;
      y?: number;
      width?: number;
      height?: number;
      visible?: boolean;
    }): Promise<{ ok: boolean }>;
    focus(): Promise<{ ok: boolean }>;
  };

  /**
   * Chromium only (capabilities.layout): the fork can position the active
   * tab's WebContents inside the shell window. Electron uses the
   * WebContentsView extras instead; web has no equivalent.
   */
  layout: {
    /**
     * Position the active tab's WebContents at these viewport CSS-px bounds
     * inside the shell window; null hides it. Hosts without layout support
     * resolve `{ ok: false }`.
     */
    setContentBounds(bounds: HostRect | null): Promise<{ ok: boolean }>;
  };

  /**
   * Shell windows. Electron: native BrowserWindow via the preload bridge.
   * Chromium: the cabinetHost.windows binding (web fallbacks when absent).
   * Web: window.open / location.reload equivalents.
   */
  windows: {
    open(path: string): Promise<unknown>; // electron: openWindow; web: window.open
    focus(): Promise<{ ok: boolean }>; // electron: focusAppWindow
    relaunch(): Promise<unknown>; // electron: relaunch; web: location.reload()
    onFullscreenChanged(l: (fs: boolean) => void): () => void; // fires immediately with current state, then on change
  };

  /**
   * OS-level services. Electron: the preload bridge (shell.openExternal /
   * shell.openPath / native toast / uninstall flow). Chromium: the
   * cabinetHost.system binding with web fallbacks. Web: navigator +
   * cabinet:toast only; openPath and uninstall are unsupported.
   */
  system: {
    openExternal(url: string): Promise<{ ok: boolean }>;
    openPath(path: string): Promise<{ ok: boolean; error?: string }>; // OS default app for a local file
    preferredLanguages(): Promise<{
      preferred?: string[];
      locale?: string;
      system?: string;
    }>;
    showToast(p: {
      kind?: string;
      message: string;
      durationMs?: number;
    }): Promise<{ ok: boolean }>;
    uninstall(): Promise<{ ok: boolean; dataPath?: string; error?: string }>;
  };

  /**
   * Local file read/write of cabinet content. Present only when
   * capabilities.files: electron uses the preload bridge; chromium uses
   * /api/assets over loopback HTTP; web leaves it absent.
   */
  files?: {
    read(
      path: string,
    ): Promise<{ ok: boolean; content?: string; error?: string }>;
    write(
      path: string,
      content: string,
    ): Promise<{ ok: boolean; error?: string }>;
  };

  /**
   * Native print-to-PDF + save dialog. Present only when capabilities.pdf;
   * callers fall back to window.print() when absent.
   */
  pdf?: {
    save(p: {
      filename: string;
      paperSize: "a4" | "letter";
      orientation: "portrait" | "landscape";
    }): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>;
  };

  /**
   * Electron-only extras: the WebContentsView browse-mode surface and shell
   * window-geometry feed, passed through verbatim from window.CabinetDesktop.
   * Present only when kind === "electron".
   */
  electron?: ElectronHostExtras;
}
