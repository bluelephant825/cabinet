"use client";

/**
 * Client-side helpers for the Cabinet Browser sidecar, via the
 * /api/browser/[...op] proxy. Live updates arrive on the daemon "browser"
 * channel (useDaemonChannel) as browser:status / browser:download /
 * browser:tab / browser:extension events.
 */

export type SidecarStatusName =
  | "missing"
  | "downloading"
  | "stopped"
  | "starting"
  | "running"
  | "error";

export type SidecarStatus = {
  status: SidecarStatusName;
  available: boolean;
  /** Loopback client + not in error state — the sidecar may be used for
   * external URLs even before it is running (mutations launch it lazily). */
  eligible: boolean;
  version: string;
  executablePath: string | null;
  /** Running Chromium pid / macOS bundle id, used by the Electron shell's
   *  visibility IPC (daemon-issued Apple Events get dropped by TCC). */
  pid?: number | null;
  bundleId?: string | null;
  /** True when the fork hosts the shell UI in its own window (in-window tab
   *  layout; no floating-window bounds sync). */
  hostMode?: boolean;
  error?: string;
  download?: { downloadedBytes: number; totalBytes: number };
};

export type SidecarTab = {
  id: string;
  targetId: string;
  url: string;
  title: string;
  active: boolean;
};

export type SidecarExtension = {
  id: string;
  name: string;
  version: string;
  path: string;
  description: string;
  iconDataUrl: string | null;
  popupHtml: string | null;
  optionsPage: string | null;
  contentScriptMatches: string[];
  enabled: boolean;
  pinned: boolean;
  runtimeId: string | null;
};

export type SidecarWindowBounds = {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  visible?: boolean;
};

const JSON_HEADERS = { "content-type": "application/json" };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/browser/${path}`, init);
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {}
    throw new Error(message);
  }
  return (await res.json()) as T;
}

const post = <T>(path: string, body?: unknown) =>
  api<T>(path, {
    method: "POST",
    headers: body === undefined ? undefined : JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const getStatus = () => api<SidecarStatus>("status");
export const launch = () => post<{ ok: boolean; status: SidecarStatusName }>("launch");
export const shutdown = () => post<{ ok: boolean; status: SidecarStatusName }>("shutdown");
export const downloadBrowser = () => post<{ ok: boolean; status: SidecarStatusName }>("download");

export const listTabs = async () => (await api<{ tabs: SidecarTab[] }>("tabs")).tabs;
export const openTab = async (url: string) =>
  (await post<{ tab: SidecarTab }>("tabs", { url })).tab;
export const activateTab = (id: string) =>
  post<{ tab: SidecarTab }>(`tabs/${encodeURIComponent(id)}/activate`);
export const closeTab = (id: string) =>
  post<{ ok: boolean }>(`tabs/${encodeURIComponent(id)}/close`);
export const navigateTab = (id: string, url: string) =>
  post<{ tab: SidecarTab }>(`tabs/${encodeURIComponent(id)}/navigate`, { url });
export const backTab = (id: string) =>
  post<{ ok: boolean; skipped?: boolean }>(`tabs/${encodeURIComponent(id)}/back`);
export const forwardTab = (id: string) =>
  post<{ ok: boolean; skipped?: boolean }>(`tabs/${encodeURIComponent(id)}/forward`);
export const reloadTab = (id: string) =>
  post<{ ok: boolean }>(`tabs/${encodeURIComponent(id)}/reload`);

export const setWindowBounds = (bounds: SidecarWindowBounds) =>
  post<{ ok: boolean }>("window/bounds", bounds);
export const focusWindow = () => post<{ ok: boolean }>("window/focus");

export const listExtensions = async () =>
  (await api<{ extensions: SidecarExtension[] }>("extensions")).extensions;
export const installExtension = async (idOrUrl: string) =>
  (await post<{ extension: SidecarExtension }>("extensions", { idOrUrl })).extension;
export const uninstallExtension = (id: string) =>
  api<{ ok: boolean }>(`extensions/${encodeURIComponent(id)}`, { method: "DELETE" });
export const enableExtension = async (id: string) =>
  (await post<{ extension: SidecarExtension }>(`extensions/${encodeURIComponent(id)}/enable`)).extension;
export const disableExtension = async (id: string) =>
  (await post<{ extension: SidecarExtension }>(`extensions/${encodeURIComponent(id)}/disable`)).extension;
export const pinExtension = async (id: string, pinned: boolean) =>
  (await post<{ extension: SidecarExtension }>(
    `extensions/${encodeURIComponent(id)}/${pinned ? "pin" : "unpin"}`,
  )).extension;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Should this URL be handed to the Chromium sidecar? External http(s) pages
 * and chrome-extension:// pages go there; same-origin/loopback content
 * (/api/assets, the three.js editor) plus data:/about:/file:/relative URLs
 * stay on the WebContentsView/iframe path.
 */
export function isSidecarUrl(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const value = raw.trim();
  if (value.startsWith("chrome-extension://")) return true;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (LOOPBACK_HOSTS.has(host)) return false;
    if (
      typeof window !== "undefined" &&
      host === window.location.hostname.toLowerCase()
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}
