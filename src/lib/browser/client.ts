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

export async function registerBrowserAutomationRun(input: {
  runId: string;
  agentSlug?: string;
  cabinetPath?: string;
}): Promise<boolean> {
  try {
    const response = await browserDaemonFetch("/browser/automation/context", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cabinet-client-origin": "http://127.0.0.1" },
      body: JSON.stringify(input),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function releaseBrowserAutomationRun(runId: string): Promise<void> {
  try {
    await browserDaemonFetch("/browser/automation/release", {
      method: "POST",
      headers: { "content-type": "application/json", "x-cabinet-client-origin": "http://127.0.0.1" },
      body: JSON.stringify({ runId }),
    });
  } catch {}
}
