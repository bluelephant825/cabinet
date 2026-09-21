"use client";

import { useEffect } from "react";
import { useTheme } from "@/components/theme-provider";
import { getHost } from "@/lib/host";
import {
  THEMES,
  applyTheme,
  getStoredThemeName,
  storeThemeName,
} from "@/lib/themes";

/**
 * Mounts once at the app root to ensure the custom theme CSS vars
 * are applied before any UI renders. This prevents flashes of the
 * wrong theme when navigating between panels.
 */
export function ThemeInitializer() {
  const { setTheme } = useTheme();

  useEffect(() => {
    const host = getHost();
    let unsubscribeFullscreen: (() => void) | undefined;
    if (host.kind !== "web") {
      document.documentElement.classList.add("electron-desktop");
      // The Chromium fork's window has no overlapping traffic lights in the
      // top-left corner, so it opts out of the Electron-only clearance.
      if (host.kind === "chromium") {
        document.documentElement.classList.add("chromium-desktop");
      }
      // Drop the traffic-light clearance while full-screen (globals.css).
      unsubscribeFullscreen = host.windows.onFullscreenChanged((isFull) =>
        document.documentElement.classList.toggle("is-fullscreen", isFull)
      );
    }

    // Restore or default to Paper/Cabinet theme. applyTheme() loads only the
    // Google Font families that theme actually uses — see themes.ts.
    const stored = getStoredThemeName();
    const themeName = stored || "paper";
    const themeDef = THEMES.find((t) => t.name === themeName);
    if (themeDef) {
      applyTheme(themeDef);
      setTheme(themeDef.type);
      if (!stored) {
        storeThemeName(themeName);
      }
    }

    return () => unsubscribeFullscreen?.();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return null;
}
