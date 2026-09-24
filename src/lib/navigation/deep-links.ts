"use client";

/**
 * Handles `cabinet://` deep links delivered by the host (see
 * system.onOpenUrl). `cabinet://new?...` is the cabinet-clipper save
 * request: POST it to /api/clip, toast the result, and unless the clip was
 * marked silent navigate to the new page and focus the window.
 */

import { getHost } from "@/lib/host";
import { dispatchCabinetToast } from "@/lib/host/web-host";

const DEDUPE_WINDOW_MS = 2000;
const seen = new Map<string, number>();

export async function handleDeepLink(url: string): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    console.warn("Ignoring deep link:", url);
    return;
  }
  if (parsed.protocol !== "cabinet:" || parsed.hostname !== "new") {
    console.warn("Ignoring deep link:", url);
    return;
  }

  // The host may deliver the same URL twice (nudge + drain replay race).
  const now = Date.now();
  const last = seen.get(url);
  if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
  seen.set(url, now);

  let res: Response;
  try {
    res = await fetch("/api/clip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: url }),
    });
  } catch {
    dispatchCabinetToast({ kind: "error", message: "Could not save clip." });
    return;
  }
  const body = (await res.json().catch(() => ({}))) as {
    error?: string;
    path?: string;
    title?: string;
    silent?: boolean;
  };
  if (!res.ok) {
    dispatchCabinetToast({
      kind: "error",
      message: body.error ?? "Could not save clip.",
    });
    return;
  }

  dispatchCabinetToast({ kind: "success", message: `Saved clip: ${body.title}` });
  if (body.silent || typeof body.path !== "string" || !body.path) return;

  // Same mechanism app-store goBack uses to trigger useRoute: rewrite the
  // path, then fire popstate.
  window.history.replaceState(
    null,
    "",
    "/room/" + body.path.split("/").filter(Boolean).map(encodeURIComponent).join("/"),
  );
  window.dispatchEvent(new PopStateEvent("popstate"));
  void getHost().windows.focus();
}
