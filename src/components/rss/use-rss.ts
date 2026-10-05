"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale } from "@/i18n/use-locale";
import english from "@/i18n/locales/en.json";
import type { RssState } from "@/lib/rss/types";

export const rssLabels = english.settings.rss;
export function useRssText() {
  const { t } = useLocale();
  return useCallback((key: keyof typeof rssLabels) => t(`settings:rss.${key}`, { defaultValue: rssLabels[key] }), [t]);
}
export class RssRequestError extends Error {
  constructor(message: string, public status: number) { super(message); }
}
export async function rssGet<T>(operation: string, room: string, params: Record<string, string> = {}, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api/rss/${operation}?${new URLSearchParams({ room, ...params })}`, { signal, cache: "no-store" });
  const value = await response.json();
  if (!response.ok) throw new RssRequestError(value.error || "RSS service is unavailable", response.status);
  return value as T;
}
export function useRssState(room: string) {
  const [snapshot, setSnapshot] = useState<RssState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const scope = useRef({ room: "", version: 0 });
  const acting = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (!room || acting.current) return;
    const version = scope.current.version;
    try {
      const result = await rssGet<RssState>("state", room, {}, signal);
      if (scope.current.room === room && scope.current.version === version && !signal?.aborted) { setSnapshot(result); setError(""); }
    } catch (failure) {
      if (!signal?.aborted && scope.current.room === room && scope.current.version === version) setError(failure instanceof Error ? failure.message : "RSS service is unavailable");
    }
  }, [room]);
  useEffect(() => {
    scope.current = { room, version: scope.current.version + 1 };
    const controller = new AbortController();
    void refresh(controller.signal);
    const timer = setInterval(() => void refresh(controller.signal), 5000);
    return () => { controller.abort(); clearInterval(timer); scope.current.version++; };
  }, [room, refresh]);
  const act = useCallback(async <T = RssState>(input: Record<string, unknown>): Promise<T | null> => {
    if (!room || acting.current) return null;
    acting.current = true;
    scope.current.version++;
    const version = scope.current.version;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/rss/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...input, room }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "RSS request failed");
      const state = result.config ? result as RssState : await rssGet<RssState>("state", room);
      if (scope.current.room !== room || scope.current.version !== version) return null;
      setSnapshot(state);
      return result as T;
    } catch (failure) {
      if (scope.current.room === room) setError(failure instanceof Error ? failure.message : "RSS request failed");
      return null;
    } finally { acting.current = false; setBusy(false); }
  }, [room]);
  return { state: snapshot?.room === room ? snapshot : null, error, busy, act, refresh };
}
export type RssAction = ReturnType<typeof useRssState>["act"];
