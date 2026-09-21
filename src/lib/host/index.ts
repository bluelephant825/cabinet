"use client";

/**
 * CabinetHost entry point: host detection plus the singleton accessor.
 *
 * Detection order (see detectHostKind):
 *   1. window.cabinetHost present         -> "chromium" (fork-injected binding)
 *   2. window.CabinetDesktop.runtime
 *      === "electron"                     -> "electron" (preload contextBridge)
 *   3. otherwise                          -> "web"
 *
 * Globals are read via `(globalThis as { window?: ... }).window` so node
 * tests can inject a stub window before calling these functions.
 */

import { createChromiumHost } from "./chromium-host";
import { createElectronHost } from "./electron-host";
import { createWebHost } from "./web-host";
import type { CabinetHost, HostKind } from "./types";

type HostGlobals = {
  cabinetHost?: unknown;
  CabinetDesktop?: { runtime?: string };
};

function hostGlobals(): HostGlobals | undefined {
  return (globalThis as { window?: HostGlobals }).window;
}

/** Pure host detection, no cache — exported for tests. */
export function detectHostKind(): HostKind {
  const globals = hostGlobals();
  if (globals?.cabinetHost) return "chromium";
  if (globals?.CabinetDesktop?.runtime === "electron") return "electron";
  return "web";
}

let cached: CabinetHost | null = null;

/** The host for this session (created lazily, then cached). */
export function getHost(): CabinetHost {
  if (!cached) {
    switch (detectHostKind()) {
      case "chromium":
        cached = createChromiumHost();
        break;
      case "electron":
        cached = createElectronHost();
        break;
      default:
        cached = createWebHost();
        break;
    }
  }
  return cached;
}

/** Trivial wrapper over getHost() for call sites that prefer hook naming. */
export function useHost(): CabinetHost {
  return getHost();
}

export type {
  CabinetHost,
  ElectronHostExtras,
  HostBookmarkMenuItem,
  HostBrowserViewLoadFailed,
  HostBrowserViewNavResult,
  HostCapabilities,
  HostContentBounds,
  HostExclusion,
  HostKind,
  HostPlatform,
  HostRect,
  HostStatus,
  HostTab,
  HostWindowGeometry,
  SidecarExtension,
} from "./types";
