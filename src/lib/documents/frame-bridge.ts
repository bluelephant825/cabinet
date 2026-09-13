/**
 * postMessage bridge between the Cabinet host (document viewers) and the
 * same-origin `/document-editor` iframe.
 *
 * Every message is `{ cabinetDoc: 1, channel, type, ... }`. Receivers validate:
 * same origin, expected `event.source` window, matching channel nonce, and a
 * `type` in the allowlist. Anything else is dropped and counted.
 */

export const BRIDGE_MARKER = 1;

export type HostToFrameType =
  | "init"
  | "save-request"
  | "revision-changed"
  | "theme"
  | "dispose";
export type FrameToHostType =
  | "ready"
  | "state"
  | "saved"
  | "conflict"
  | "title"
  | "request";

const HOST_TO_FRAME: readonly string[] = [
  "init",
  "save-request",
  "revision-changed",
  "theme",
  "dispose",
];
const FRAME_TO_HOST: readonly string[] = [
  "ready",
  "state",
  "saved",
  "conflict",
  "title",
  "request",
];

export interface BridgeMessage {
  cabinetDoc: 1;
  channel: string;
  type: string;
  [key: string]: unknown;
}

export interface ParsedBridgeMessage {
  ok: boolean;
  message?: BridgeMessage;
}

/**
 * Pure validator — exported for unit tests. `expectedSource` may be null in
 * pure-logic tests (source check skipped); browser callers pass the real
 * window/iframe contentWindow.
 */
export function parseBridgeMessage(
  data: unknown,
  opts: { channel: string; direction: "host-to-frame" | "frame-to-host" },
): ParsedBridgeMessage {
  if (typeof data !== "object" || data === null) return { ok: false };
  const m = data as Record<string, unknown>;
  if (m.cabinetDoc !== BRIDGE_MARKER) return { ok: false };
  if (m.channel !== opts.channel) return { ok: false };
  const allowlist = opts.direction === "host-to-frame" ? HOST_TO_FRAME : FRAME_TO_HOST;
  if (typeof m.type !== "string" || !allowlist.includes(m.type)) return { ok: false };
  return { ok: true, message: m as BridgeMessage };
}

export type BridgeHandler = (message: BridgeMessage) => void;

/** Host side: post to the iframe, listen for frame → host messages. */
export function createHostBridge(
  iframe: HTMLIFrameElement,
  channel: string,
  onMessage: BridgeHandler,
): { send: (type: HostToFrameType, payload?: Record<string, unknown>) => void; dispose: () => void; dropped: () => number } {
  let droppedCount = 0;
  const listener = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return void droppedCount++;
    if (event.source !== iframe.contentWindow) return void droppedCount++;
    const parsed = parseBridgeMessage(event.data, { channel, direction: "frame-to-host" });
    if (!parsed.ok) return void droppedCount++;
    onMessage(parsed.message!);
  };
  window.addEventListener("message", listener);
  const send = (type: HostToFrameType, payload: Record<string, unknown> = {}) => {
    iframe.contentWindow?.postMessage(
      { cabinetDoc: BRIDGE_MARKER, channel, type, ...payload },
      window.location.origin,
    );
  };
  return {
    send,
    dropped: () => droppedCount,
    dispose: () => window.removeEventListener("message", listener),
  };
}

/** Frame side: post to the parent, listen for host → frame messages. */
export function createFrameBridge(
  channel: string,
  onMessage: BridgeHandler,
): { send: (type: FrameToHostType, payload?: Record<string, unknown>) => void; dispose: () => void; dropped: () => number } {
  let droppedCount = 0;
  const listener = (event: MessageEvent) => {
    if (event.origin !== window.location.origin) return void droppedCount++;
    if (event.source !== window.parent) return void droppedCount++;
    const parsed = parseBridgeMessage(event.data, { channel, direction: "host-to-frame" });
    if (!parsed.ok) return void droppedCount++;
    onMessage(parsed.message!);
  };
  window.addEventListener("message", listener);
  const send = (type: FrameToHostType, payload: Record<string, unknown> = {}) => {
    window.parent.postMessage(
      { cabinetDoc: BRIDGE_MARKER, channel, type, ...payload },
      window.location.origin,
    );
  };
  return {
    send,
    dropped: () => droppedCount,
    dispose: () => window.removeEventListener("message", listener),
  };
}
