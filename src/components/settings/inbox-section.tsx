"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/use-locale";
import type { InboxStatus } from "@/lib/llm-wiki/inbox-types";

export function InboxSection() {
  const { t } = useLocale();
  const [status, setStatus] = useState<InboxStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const acting = useRef(false);
  const revision = useRef(0);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (acting.current) return;
    const version = revision.current;
    try {
      const response = await fetch("/api/ingestion/inbox", { signal, cache: "no-store" });
      if (!response.ok) throw new Error("Inbox service is unavailable");
      const result = await response.json();
      if (version !== revision.current) return;
      setStatus(result);
      setError(null);
    } catch (failure) {
      if (!signal?.aborted && version === revision.current) setError(failure instanceof Error ? failure.message : String(failure));
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => { void refresh(controller.signal); }, 3000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [refresh]);

  async function act(body: Record<string, unknown>) {
    const previous = status;
    acting.current = true;
    revision.current++;
    setBusy(true);
    setError(null);
    if (body.action === "set-automatic" && typeof body.enabled === "boolean" && status) {
      setStatus({ ...status, autoIngestInbox: body.enabled });
    }
    try {
      const response = await fetch("/api/ingestion/inbox", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Inbox request failed");
      setStatus(result);
    } catch (failure) { setStatus(previous); setError(failure instanceof Error ? failure.message : String(failure)); }
    finally { acting.current = false; setBusy(false); }
  }

  // Existing Cabinets do not gain controls for a feature they haven't enabled.
  if (!status?.enabled) return null;
  return (
    <section className="rounded-xl border border-border p-4 space-y-3" aria-label={t("settings:inbox.title", { defaultValue: "Inbox" })}>
      <h3 className="text-sm font-semibold">{t("settings:inbox.title", { defaultValue: "Inbox" })}</h3>
      <label className="flex items-center justify-between gap-3 text-sm">
        {t("settings:inbox.automatic", { defaultValue: "Auto-ingest Inbox" })}
        <input type="checkbox" checked={status.autoIngestInbox} disabled={busy || !status.watching}
          onChange={(event) => { void act({ action: "set-automatic", enabled: event.target.checked }); }} />
      </label>
      <p className="text-sm text-muted-foreground">{t("settings:inbox.pending", { defaultValue: "Awaiting ingestion: {{count}}", count: status.pending })}</p>
      <p className="text-sm text-muted-foreground">{t("settings:inbox.submitted", { defaultValue: "Submitted to the queue: {{count}}", count: status.queued })}</p>
      <Button variant="outline" disabled={busy || !status.watching || status.pending + status.failed === 0}
        onClick={() => { void act({ action: "ingest-all" }); }}>
        {t("settings:inbox.ingestAll", { defaultValue: "Ingest all" })}
      </Button>
      {(error || status.error) && <p role="alert" className="text-sm text-destructive">{error || status.error}</p>}
      {status.items.filter((item) => item.status === "error").map((item) => (
        <p key={item.path} role="alert" className="text-sm text-destructive">{item.path}: {item.error}</p>
      ))}
    </section>
  );
}
