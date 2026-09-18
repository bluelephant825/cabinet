/**
 * Minimal CDP transport over Chromium's --remote-debugging-pipe.
 *
 * With that flag Chromium reads commands from fd 3 and writes responses/events
 * to fd 4, each message a single JSON document terminated by NUL (\0). No
 * WebSocket, no puppeteer-core — just framed JSON on two pipes.
 *
 * CDPClient wraps a writable stream (our fd-3 side) and a readable stream
 * (fd-4 side). `send()` resolves on the matching `{id}` response and rejects
 * on `{id, error}` or when the pipe closes. `on("event")`-style handlers get
 * `{method, params, sessionId}` for every session-less or session-scoped event.
 */
import { EventEmitter } from "node:events";
import type { Readable, Writable } from "node:stream";
import { BrowserError } from "./types";

export type CdpEventMessage = {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
};

const DEFAULT_SEND_TIMEOUT_MS = 15_000;

export function encodeMessage(message: Record<string, unknown>): Buffer {
  return Buffer.concat([Buffer.from(JSON.stringify(message), "utf8"), Buffer.from([0])]);
}

/**
 * Incremental parser for the NUL-delimited stream coming back from Chromium.
 * Handles partial chunks and multiple messages per chunk; emits each parsed
 * JSON document to the callback.
 */
export class PipeParser {
  private pending: Buffer[] = [];

  push(chunk: Buffer, onMessage: (message: Record<string, unknown>) => void): void {
    this.pending.push(chunk);
    let buffer = Buffer.concat(this.pending);
    for (;;) {
      const nul = buffer.indexOf(0);
      if (nul === -1) break;
      const slice = buffer.subarray(0, nul);
      buffer = buffer.subarray(nul + 1);
      this.pending = [buffer];
      if (slice.length === 0) continue;
      try {
        onMessage(JSON.parse(slice.toString("utf8")) as Record<string, unknown>);
      } catch {
        // Ignore malformed frames; Chromium shouldn't send them.
      }
    }
    this.pending = buffer.length ? [buffer] : [];
  }

  reset(): void {
    this.pending = [];
  }
}

export class CDPClient extends EventEmitter {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly parser = new PipeParser();
  private closed = false;

  constructor(
    private readonly writable: Writable,
    private readonly readable: Readable,
  ) {
    super();
    readable.on("data", (chunk: Buffer) => {
      this.parser.push(chunk, (message) => this.handleMessage(message));
    });
    const failAll = (err: Error) => {
      this.closed = true;
      this.failPending(err);
    };
    readable.on("close", () => failAll(new BrowserError("cdp", "CDP pipe closed")));
    readable.on("error", (err) =>
      failAll(new BrowserError("cdp", `CDP pipe error: ${err.message}`)),
    );
    writable.on("error", (err) =>
      failAll(new BrowserError("cdp", `CDP pipe write error: ${err.message}`)),
    );
  }

  private handleMessage(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id === "number") {
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      const error = message.error as { message?: string } | undefined;
      if (error) {
        entry.reject(new BrowserError("cdp", error.message || "CDP error"));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    const method = message.method;
    if (typeof method === "string") {
      const eventMessage: CdpEventMessage = {
        method,
        params: message.params as Record<string, unknown> | undefined,
        sessionId: message.sessionId as string | undefined,
      };
      this.emit("event", eventMessage);
      this.emit(method, eventMessage);
    }
  }

  private failPending(err: Error): void {
    if (this.pending.size === 0) return;
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
  }

  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new BrowserError("cdp", `CDP client closed; cannot send ${method}`));
    }
    const id = this.nextId++;
    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) message.params = params;
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new BrowserError("cdp", `CDP request timed out: ${method}`));
        }
      }, DEFAULT_SEND_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });
      this.writable.write(encodeMessage(message), (err) => {
        if (err) {
          const entry = this.pending.get(id);
          this.pending.delete(id);
          if (entry) clearTimeout(entry.timer);
          reject(new BrowserError("cdp", `CDP write failed: ${err.message}`));
        }
      });
    });
  }

  /** Subscribe to CDP events. `method` may be "*" for every event. */
  onEvent(method: string, handler: (event: CdpEventMessage) => void): void {
    this.on(method === "*" ? "event" : method, handler);
  }

  offEvent(method: string, handler: (event: CdpEventMessage) => void): void {
    this.off(method === "*" ? "event" : method, handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.failPending(new BrowserError("cdp", "CDP client closed"));
    try {
      this.writable.end();
    } catch {}
    try {
      this.readable.destroy();
    } catch {}
  }
}
