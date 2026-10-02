import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { CdpEventMessage } from "./cdp-client";
import { BrowserError } from "./types";

export type BridgeCdpClient = {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  claimIsolatedSession(sessionId: string, handler: (event: CdpEventMessage) => void): void;
  releaseIsolatedSession(sessionId: string, handler?: (event: CdpEventMessage) => void): void;
};

type TargetInfo = {
  targetId?: string;
  type?: string;
  url?: string;
  openerId?: string;
};

type RpcRequest = {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

const ROOT_METHODS = new Set([
  "Browser.getVersion",
  "Target.activateTarget",
  "Target.attachToTarget",
  "Target.closeTarget",
  "Target.createTarget",
  "Target.getTargets",
  "Target.setDiscoverTargets",
]);
const PAGE_DOMAINS = new Set([
  "Accessibility",
  "CSS",
  "DOM",
  "Debugger",
  "Emulation",
  "IO",
  "Input",
  "Network",
  "Page",
  "Runtime",
  "Target",
]);

function rpcError(id: RpcRequest["id"] | null, code: number, message: string, data?: unknown) {
  return JSON.stringify({
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

function visibleTarget(info: TargetInfo, hiddenOrigin?: string): boolean {
  if (info.type !== "page" || !info.targetId) return false;
  const url = info.url ?? "";
  if (url === "about:blank" || url === "") return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return !hiddenOrigin || parsed.origin !== hiddenOrigin;
  } catch {
    return false;
  }
}

function safeOpenUrl(value: unknown): boolean {
  if (value === "about:blank") return true;
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export class CdpBridge {
  private readonly capability = randomBytes(32).toString("hex");
  private readonly server = http.createServer((_req, res) => {
    res.writeHead(404).end();
  });
  private readonly sockets = new Set<WebSocket>();
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  private listening = false;

  constructor(
    private readonly cdp: BridgeCdpClient,
    private readonly hiddenOrigin?: string,
  ) {
    this.server.on("upgrade", (req, socket, head) => {
      let pathname = "";
      try {
        pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      } catch {}
      const origin = req.headers.origin;
      if (pathname !== `/${this.capability}` || (origin && origin !== "null")) {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });
    this.wss.on("connection", (ws) => {
      this.sockets.add(ws);
      ws.once("close", () => this.sockets.delete(ws));
      void this.serve(ws);
    });
  }

  async start(): Promise<string> {
    if (!this.listening) {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        this.server.once("error", onError);
        this.server.listen(0, "127.0.0.1", () => {
          this.server.off("error", onError);
          resolve();
        });
      });
      this.listening = true;
    }
    const address = this.server.address() as AddressInfo;
    return `ws://127.0.0.1:${address.port}/${this.capability}`;
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.close(1001, "bridge closing");
    this.sockets.clear();
    this.wss.close();
    if (!this.listening) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.listening = false;
  }

  private async serve(ws: WebSocket): Promise<void> {
    let attached: { sessionId?: string };
    try {
      attached = await this.cdp.send("Target.attachToBrowserTarget") as { sessionId?: string };
    } catch {
      ws.close(1011, "browser session unavailable");
      return;
    }
    if (!attached.sessionId) {
      ws.close(1011, "browser session unavailable");
      return;
    }
    const rootSessionId = attached.sessionId;
    const sessions = new Set([rootSessionId]);
    const ownedTargets = new Set<string>();
    const visibleTargets = new Set<string>();
    let queue = Promise.resolve();

    const eventHandler = (event: CdpEventMessage) => {
      const params = event.params ?? {};
      if (event.method === "Target.attachedToTarget") {
        const child = typeof params.sessionId === "string" ? params.sessionId : null;
        const info = params.targetInfo as TargetInfo | undefined;
        if (child) {
          sessions.add(child);
          this.cdp.claimIsolatedSession(child, eventHandler);
        }
        if (info && !visibleTarget(info, this.hiddenOrigin)) return;
      }
      if (event.method === "Target.detachedFromTarget") {
        const child = typeof params.sessionId === "string" ? params.sessionId : null;
        if (child) {
          sessions.delete(child);
          this.cdp.releaseIsolatedSession(child, eventHandler);
        }
      }
      if (event.method === "Target.targetCreated" || event.method === "Target.targetInfoChanged") {
        const info = params.targetInfo as TargetInfo | undefined;
        if (!info || !visibleTarget(info, this.hiddenOrigin)) return;
        visibleTargets.add(info.targetId!);
        if (event.method === "Target.targetCreated" && info.openerId && ownedTargets.has(info.openerId)) {
          ownedTargets.add(info.targetId!);
        }
      }
      if (event.method === "Target.targetDestroyed") {
        const targetId = typeof params.targetId === "string" ? params.targetId : null;
        if (!targetId || (!visibleTargets.has(targetId) && !ownedTargets.has(targetId))) return;
        visibleTargets.delete(targetId);
        ownedTargets.delete(targetId);
      }
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        method: event.method,
        ...(event.params ? { params: event.params } : {}),
        ...(event.sessionId && event.sessionId !== rootSessionId
          ? { sessionId: event.sessionId }
          : {}),
      }));
    };

    this.cdp.claimIsolatedSession(rootSessionId, eventHandler);

    const cleanup = () => {
      for (const sessionId of sessions) this.cdp.releaseIsolatedSession(sessionId, eventHandler);
      void this.cdp.send("Target.detachFromTarget", { sessionId: rootSessionId }).catch(() => {});
    };
    ws.once("close", cleanup);

    ws.on("message", (data, isBinary) => {
      queue = queue.then(async () => {
        if (isBinary) {
          ws.send(rpcError(null, -32700, "Binary CDP messages are not supported"));
          return;
        }
        let request: RpcRequest;
        try {
          request = JSON.parse(data.toString()) as RpcRequest;
        } catch {
          ws.send(rpcError(null, -32700, "Invalid JSON"));
          return;
        }
        if (request.id === undefined || typeof request.method !== "string") {
          ws.send(rpcError(request.id, -32600, "Invalid CDP request"));
          return;
        }
        try {
          const result = await this.forward(
            request,
            rootSessionId,
            sessions,
            ownedTargets,
            visibleTargets,
            eventHandler,
          );
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ id: request.id, result }));
          }
        } catch (error) {
          const browserError = error instanceof BrowserError ? error : null;
          const details = browserError?.details;
          const code = typeof details?.cdpCode === "number" ? details.cdpCode : -32000;
          const dataValue = details?.cdpData;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(rpcError(
              request.id,
              code,
              error instanceof Error ? error.message : "CDP request failed",
              dataValue,
            ));
          }
        }
      });
    });
  }

  private async forward(
    request: RpcRequest,
    rootSessionId: string,
    sessions: Set<string>,
    ownedTargets: Set<string>,
    visibleTargets: Set<string>,
    eventHandler: (event: CdpEventMessage) => void,
  ): Promise<unknown> {
    const sessionId = request.sessionId ?? rootSessionId;
    if (!sessions.has(sessionId)) throw new BrowserError("unauthorized", "Unknown CDP session");
    const isRoot = sessionId === rootSessionId;
    const domain = request.method!.split(".", 1)[0];
    if (isRoot && !ROOT_METHODS.has(request.method!)) {
      throw new BrowserError("unauthorized", `CDP method is not allowed: ${request.method}`);
    }
    if (!isRoot && !PAGE_DOMAINS.has(domain)) {
      throw new BrowserError("unauthorized", `CDP domain is not allowed: ${domain}`);
    }
    const params = request.params ?? {};
    if (request.method === "Target.createTarget" && !safeOpenUrl(params.url)) {
      throw new BrowserError("invalid", "Target URL is not allowed");
    }
    if (request.method === "Target.attachToTarget" || request.method === "Target.activateTarget") {
      const targetId = typeof params.targetId === "string" ? params.targetId : "";
      if (!targetId || !(await this.refreshVisibleTarget(targetId, rootSessionId, visibleTargets))) {
        throw new BrowserError("not-found", "Target is not available to browser automation");
      }
    }
    if (request.method === "Target.closeTarget") {
      const targetId = typeof params.targetId === "string" ? params.targetId : "";
      if (!ownedTargets.has(targetId)) {
        throw new BrowserError("unauthorized", "Browser automation cannot close a user tab");
      }
    }
    const result = await this.cdp.send(request.method!, params, sessionId) as Record<string, unknown> | undefined;
    if (request.method === "Target.getTargets") {
      const targetInfos = Array.isArray(result?.targetInfos)
        ? (result!.targetInfos as TargetInfo[]).filter((info) => visibleTarget(info, this.hiddenOrigin))
        : [];
      for (const info of targetInfos) visibleTargets.add(info.targetId!);
      return { ...(result ?? {}), targetInfos };
    }
    if (request.method === "Target.createTarget" && typeof result?.targetId === "string") {
      ownedTargets.add(result.targetId);
      visibleTargets.add(result.targetId);
    }
    if (request.method === "Target.attachToTarget" && typeof result?.sessionId === "string") {
      sessions.add(result.sessionId);
      this.cdp.claimIsolatedSession(result.sessionId, eventHandler);
    }
    return result ?? {};
  }

  private async refreshVisibleTarget(
    targetId: string,
    rootSessionId: string,
    visibleTargets: Set<string>,
  ): Promise<boolean> {
    const result = await this.cdp.send("Target.getTargets", {}, rootSessionId) as { targetInfos?: TargetInfo[] };
    const visible = (result.targetInfos ?? []).find(
      (info) => info.targetId === targetId && visibleTarget(info, this.hiddenOrigin),
    );
    if (visible) visibleTargets.add(targetId);
    return Boolean(visible);
  }
}
