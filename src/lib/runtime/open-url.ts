"use client";

import { getHost } from "@/lib/host";

export function openUrlInAppropriateContext(
  url: string,
  openInBrowseMode: (url: string) => void
): void {
  const host = getHost();

  // file:// URLs can't be loaded in a browser view or window.open —
  // desktop shells block them. Use shell.openPath to open with the OS
  // default app.
  if (url.startsWith("file://")) {
    const filePath = decodeURIComponent(url.slice("file://".length));
    if (host.capabilities.shell) {
      void host.system.openPath(filePath);
      return;
    }
    // In browser mode, there's no way to open local files — show a toast
    // with the file path and a "Copy path" action so the user can open it
    // manually in Finder/File Explorer.
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent("cabinet:toast", {
          detail: {
            kind: "info",
            message: `Local file: ${filePath}`,
            actionLabel: "Copy path",
            onAction: () => {
              navigator.clipboard?.writeText(filePath).catch(() => {});
            },
          },
        })
      );
    }
    return;
  }

  if (host.kind !== "web") {
    openInBrowseMode(url);
  } else {
    window.open(url, "_blank");
  }
}

/**
 * Open a URL in the user's SYSTEM default browser (never the in-app browse
 * view). Used for OAuth sign-in flows where the embedded browser lacks the
 * user's provider session. Falls back to window.open in the web build.
 */
export function openExternalUrl(url: string): void {
  const host = getHost();
  if (host.capabilities.shell) {
    void host.system.openExternal(url);
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
