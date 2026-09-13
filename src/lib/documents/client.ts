import { getDaemonUrl, getOrCreateDaemonTokenSync } from "@/lib/agents/daemon-auth";

/**
 * Same bearer-token pattern as `daemonFetch` in `@/lib/agents/daemon-client`,
 * minus `assertAiAllowed()` — document operations are not AI runs.
 * Server-side only: the daemon token must never reach client components.
 */
export function documentsDaemonFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getOrCreateDaemonTokenSync();
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return fetch(`${getDaemonUrl()}${path}`, { ...init, headers });
}
