"use client";

import { useEffect } from "react";

/**
 * Subscribe to a daemon event-bus channel via the `/api/documents/events` SSE
 * relay. One shared EventSource per channel feeds every subscriber; each
 * callback receives the bus payload ({ channel, type, ... }) for its channel.
 */

type ChannelHandler = (data: Record<string, unknown>) => void;

const subscribers = new Map<ChannelHandler, string>();
const sources = new Map<string, { source: EventSource; refCount: number }>();

function ensureSource(channel: string): void {
  if (sources.has(channel)) return;
  const source = new EventSource(
    `/api/documents/events?channel=${encodeURIComponent(channel)}`,
  );
  source.onmessage = (event) => {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }
    const msgChannel = typeof msg.channel === "string" ? msg.channel : null;
    if (!msgChannel) return;
    for (const [handler, wanted] of subscribers) {
      if (wanted === msgChannel || wanted === "*") {
        try {
          handler(msg);
        } catch {
          /* subscriber errors must not break the bus */
        }
      }
    }
  };
  source.onerror = () => {
    // EventSource auto-reconnects; nothing to do.
  };
  sources.set(channel, { source, refCount: 0 });
}

export function useDaemonChannel(channel: string, handler: ChannelHandler): void {
  useEffect(() => {
    subscribers.set(handler, channel);
    ensureSource(channel);
    const entry = sources.get(channel)!;
    entry.refCount++;
    return () => {
      subscribers.delete(handler);
      entry.refCount--;
      if (entry.refCount <= 0) {
        entry.source.close();
        sources.delete(channel);
      }
    };
  }, [channel, handler]);
}
