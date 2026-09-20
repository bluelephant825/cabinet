import { buildPath } from "@/lib/navigation/route-scheme";
import { getHost } from "@/lib/host";

/**
 * Multi-window support. A window's scope lives entirely in the URL path
 * (clean-path routing, see `useRoute`), so opening a room/cabinet in its own
 * window is just "open the app at this path". On a desktop host we ask the
 * shell to spawn a real window; on the web we open a new tab.
 */

/** Clean URL path for a room/cabinet (`/room/<path>`; root → `/`). */
export function buildRoomPath(cabinetPath: string): string {
  return buildPath({ type: "cabinet", cabinetPath: cabinetPath || undefined }, null);
}

/** True when running inside a desktop shell (Electron or the Chromium fork). */
export function isDesktop(): boolean {
  return getHost().kind !== "web";
}

/**
 * Open the given room/cabinet in a new window.
 * - Desktop: spawns a native window at the same app origin + path.
 * - Web: opens a new browser window/tab at the current origin + path.
 */
export function openRoomWindow(cabinetPath: string): void {
  if (typeof window === "undefined") return;
  const path = buildRoomPath(cabinetPath);

  const host = getHost();
  if (host.capabilities.windows) {
    void host.windows.open(path);
    return;
  }

  window.open(`${window.location.origin}${path}`, "_blank", "noopener");
}
