/**
 * Pure predicate for the `/api/documents/events` SSE relay: is this raw bus
 * frame a well-formed JSON message belonging to `channel`? Exported for unit
 * tests — the relay drops anything else rather than leaking other channels.
 */
export function matchesChannelFrame(data: string, channel: string): boolean {
  try {
    const msg = JSON.parse(data) as { channel?: unknown };
    return msg !== null && typeof msg === "object" && msg.channel === channel;
  } catch {
    return false;
  }
}
