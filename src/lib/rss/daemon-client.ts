import { getDaemonUrl, getOrCreateDaemonToken } from "../agents/daemon-auth";

export async function rssDaemonRequest<T>(operation: string, body: Record<string, unknown>): Promise<T> {
  const token = await getOrCreateDaemonToken();
  const response = await fetch(`${getDaemonUrl()}/rss/${operation}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "RSS service is unavailable");
  return result as T;
}
export interface RssPreparation { runId: string; prompt: string; skip: boolean; status: string }
