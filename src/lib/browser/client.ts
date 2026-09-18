import { getDaemonUrl, getOrCreateDaemonTokenSync } from "@/lib/agents/daemon-auth";

/**
 * Same bearer-token pattern as `documentsDaemonFetch` — server-side only:
 * the daemon token must never reach client components.
 */
export function browserDaemonFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = getOrCreateDaemonTokenSync();
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${token}`);
  }
  return fetch(`${getDaemonUrl()}${path}`, { ...init, headers });
}
