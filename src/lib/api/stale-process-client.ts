import { isStaleProcessResponse } from "@/lib/api/stale-process";

let recovering = false;

/** Inspect a response without consuming its body and start recovery if stale. */
export function handleStaleResponse(response: Response): boolean {
  if (typeof window === "undefined") return false;
  if (!isStaleProcessResponse(response)) return false;
  beginStaleRecovery();
  return true;
}

/** Wait for a fresh process to answer health checks, then reload once. */
export function beginStaleRecovery(): void {
  if (typeof window === "undefined" || recovering) return;
  recovering = true;

  try {
    window.dispatchEvent(
      new CustomEvent("cabinet:toast", {
        detail: {
          kind: "info",
          message: "Applying the data-folder change — restarting the server…",
        },
      })
    );
  } catch {
    // Toasting is best-effort.
  }

  const startedAt = Date.now();
  const maxWaitMs = 60_000;
  const poll = async () => {
    try {
      const response = await fetch("/api/health", { cache: "no-store" });
      if (response.ok) {
        const data = (await response.json().catch(() => null)) as
          | { stale?: boolean }
          | null;
        if (data && data.stale !== true) {
          window.location.reload();
          return;
        }
      }
    } catch {
      // The server may briefly stop listening while it restarts.
    }

    if (Date.now() - startedAt > maxWaitMs) {
      recovering = false;
      return;
    }
    window.setTimeout(poll, 1_000);
  };

  window.setTimeout(poll, 800);
}
