"use client";

/**
 * Web adapter for CabinetHost: a plain browser tab. There is no privileged
 * shell binding at all, so every native surface reports capability false and
 * degrades to `{ ok: false }` (or a DOM equivalent: window.open,
 * location.reload, the fullscreenchange event, the in-app "cabinet:toast"
 * CustomEvent).
 *
 * tabs / extensions / browser still work: they go over loopback HTTP to the
 * daemon's /api/browser/* routes, which drive the real browser engine via
 * CDP. Eligibility is enforced server-side.
 *
 * The small fallback helpers at the bottom (getWindowLike,
 * getNavigatorLike, subscribeFullscreenFallback, dispatchCabinetToast) are
 * shared with the chromium host, which falls back to exactly this behavior
 * when its cabinetHost binding lacks a member.
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
import type { CabinetHost, HostCapabilities } from "./types";

/**
 * Minimal structural view of `window` so adapters stay honest about what
 * they touch and so node tests can inject a stub on globalThis.
 */
type WindowLike = {
  location?: { origin?: string; reload?: () => void };
  open?: (url: string, target?: string, features?: string) => unknown;
  focus?: () => void;
  document?: {
    fullscreenElement?: unknown;
    addEventListener?: (type: string, listener: () => void) => void;
    removeEventListener?: (type: string, listener: () => void) => void;
  };
  dispatchEvent?: (event: Event) => boolean;
};

type NavigatorLike = {
  languages?: readonly string[];
  language?: string;
};

export function getWindowLike(): WindowLike | undefined {
  return (globalThis as { window?: WindowLike }).window;
}

export function getNavigatorLike(): NavigatorLike | undefined {
  return (globalThis as { navigator?: NavigatorLike }).navigator;
}

const NOOP_UNSUBSCRIBE = () => {};

/**
 * DOM `fullscreenchange` fallback for hosts without a native fullscreen
 * feed. Fires immediately with `!!document.fullscreenElement`, then on
 * every change. Returns an unsubscribe function.
 */
export function subscribeFullscreenFallback(
  listener: (fullscreen: boolean) => void,
): () => void {
  const doc = getWindowLike()?.document;
  if (
    !doc ||
    typeof doc.addEventListener !== "function" ||
    typeof doc.removeEventListener !== "function"
  ) {
    listener(false);
    return NOOP_UNSUBSCRIBE;
  }
  const handler = () => listener(!!doc.fullscreenElement);
  doc.addEventListener("fullscreenchange", handler);
  handler();
  return () => {
    doc.removeEventListener?.("fullscreenchange", handler);
  };
}

/**
 * In-app toast fallback: the layout listens for "cabinet:toast" window
 * events (same event open-local-file.ts uses). Best-effort — always
 * resolves ok because a dropped toast is not worth surfacing.
 */
export function dispatchCabinetToast(payload: {
  kind?: string;
  message: string;
  durationMs?: number;
}): { ok: boolean } {
  const win = getWindowLike();
  const CustomEventCtor = (
    globalThis as { CustomEvent?: typeof CustomEvent }
  ).CustomEvent;
  if (win?.dispatchEvent && CustomEventCtor) {
    win.dispatchEvent(
      new CustomEventCtor("cabinet:toast", {
        detail: { kind: payload.kind ?? "info", message: payload.message },
      }),
    );
  }
  return { ok: true };
}

export function createWebHost(): CabinetHost {
  const capabilities: HostCapabilities = {
    layout: false,
    windows: false,
    files: false,
    pdf: false,
    uninstall: false,
    preferredLanguages: false,
    toast: false,
    shell: false,
    browserView: false,
  };

  return {
    kind: "web",
    platform: "web",
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

    layout: {
      setContentBounds: () => Promise.resolve({ ok: false }),
    },

    windows: {
      open: (path) => {
        const win = getWindowLike();
        const url = `${win?.location?.origin ?? ""}${path}`;
        return Promise.resolve(
          win?.open?.(url, "_blank", "noopener") ?? null,
        );
      },
      focus: () => {
        getWindowLike()?.focus?.();
        return Promise.resolve({ ok: true });
      },
      relaunch: () => {
        getWindowLike()?.location?.reload?.();
        return Promise.resolve({ ok: true });
      },
      onFullscreenChanged: subscribeFullscreenFallback,
    },

    system: {
      openExternal: (url) => {
        getWindowLike()?.open?.(url, "_blank", "noopener,noreferrer");
        return Promise.resolve({ ok: true });
      },
      openPath: () => Promise.resolve({ ok: false, error: "unsupported" }),
      preferredLanguages: () => {
        const nav = getNavigatorLike();
        return Promise.resolve({
          preferred: [...(nav?.languages ?? [])],
          locale: nav?.language,
        });
      },
      showToast: (payload) => Promise.resolve(dispatchCabinetToast(payload)),
      uninstall: () => Promise.resolve({ ok: false, error: "unsupported" }),
    },
  };
}
