/**
 * HTTP adapter for the Cabinet Browser daemon module, mounted in
 * cabinet-daemon under /browser/. Same auth shape as /documents/: bearer
 * token via daemon-auth. Errors map BrowserError.httpStatus.
 *
 * `browser` is a facade over ChromiumManager + BrowserSession +
 * ExtensionManager (see BrowserFacade) so tests can drive the routes with a
 * fake.
 */
import type http from "node:http";
import {
  getTokenFromAuthorizationHeader,
  isDaemonTokenValid,
} from "../../src/lib/agents/daemon-auth";
import { BrowserError, type BrowserExtensionRecord, type BrowserStatus, type BrowserTab } from "./types";
import { isLoopbackOrigin } from "./chromium-manager";

type Json = Record<string, unknown>;

export type BrowserFacade = {
  status(): BrowserStatus;
  lastError(): string | null;
  executablePath(): string | null;
  pid(): number | null;
  bundleId(): string | null;
  /** True when the fork hosts the shell UI in its own window (in-window tab
   *  layout replaces the floating-window bounds sync). */
  hostMode(): boolean;
  /** P1 host extension: enabled flag + runtime id once loaded. */
  hostExtension(): { enabled: boolean; id: string | null };
  version(): string;
  downloadProgress(): { downloadedBytes: number; totalBytes: number } | null;
  isAvailable(origin: string | undefined): boolean;
  launch(): Promise<unknown>;
  shutdown(): Promise<void>;
  download(): Promise<unknown>;
  ensureRunning(): Promise<unknown>;
  listTabs(): Promise<BrowserTab[]>;
  openTab(url: string): Promise<BrowserTab>;
  activateTab(id: string): Promise<BrowserTab>;
  closeTab(id: string): Promise<unknown>;
  navigateTab(id: string, url: string): Promise<BrowserTab>;
  backTab(id: string): Promise<unknown>;
  forwardTab(id: string): Promise<unknown>;
  reloadTab(id: string): Promise<unknown>;
  evaluateTab(id: string, expression: string): Promise<unknown>;
  extractTab(id: string, opts: { html?: boolean }): Promise<unknown>;
  screenshotTab(id: string): Promise<Buffer>;
  listExtensions(): Promise<BrowserExtensionRecord[]>;
  installExtension(idOrUrl: string): Promise<BrowserExtensionRecord>;
  uninstallExtension(id: string): Promise<unknown>;
  enableExtension(id: string): Promise<BrowserExtensionRecord>;
  disableExtension(id: string): Promise<BrowserExtensionRecord>;
  pinExtension(id: string, pinned: boolean): Promise<BrowserExtensionRecord>;
  setWindowBounds(bounds: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    visible?: boolean;
  }): Promise<unknown>;
  focusWindow(): Promise<unknown>;
};

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof BrowserError) {
    sendJson(res, err.httpStatus, {
      error: err.message,
      code: err.code,
      details: err.details,
    });
    return;
  }
  sendJson(res, 500, {
    error: "Internal browser error",
    code: "cdp",
  });
}

async function readJson(req: http.IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8")) as Json;
  } catch {
    throw new BrowserError("invalid", "Request body is not valid JSON");
  }
}

/**
 * The browser client's true origin. The Next proxy forwards the page's Origin
 * in `x-cabinet-client-origin` because a same-origin Next request to the proxy
 * carries no Origin header at all — without it, remote web clients would look
 * like local CLI callers (Origin absent = loopback) to isAvailable/eligible.
 */
function clientOrigin(req: http.IncomingMessage): string | undefined {
  const forwarded = req.headers["x-cabinet-client-origin"];
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  if (typeof value === "string" && value.trim()) return value.trim();
  const origin = req.headers.origin;
  return Array.isArray(origin) ? origin[0] : origin;
}

function validTabUrl(value: unknown): string {
  const url = typeof value === "string" ? value.trim() : "";
  if (!url) throw new BrowserError("invalid", "url is required");
  if (url === "about:blank") return url;
  if (url.startsWith("chrome-extension://")) return url;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return url;
  } catch {}
  throw new BrowserError("invalid", `Unsupported URL scheme: ${url.split(":")[0] || "none"}`);
}

export async function handleBrowserRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  browser: BrowserFacade,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/browser/") && url.pathname !== "/browser") return false;

  const token = getTokenFromAuthorizationHeader(req.headers.authorization);
  if (!isDaemonTokenValid(token)) {
    sendJson(res, 401, { error: "Unauthorized", code: "unauthorized" });
    return true;
  }

  try {
    const parts = url.pathname.split("/").filter(Boolean); // ["browser", ...]
    const method = req.method ?? "GET";

    if (method === "GET" && parts[1] === "status") {
      const download = browser.downloadProgress();
      const origin = clientOrigin(req);
      const status = browser.status();
      sendJson(res, 200, {
        status,
        available: browser.isAvailable(origin),
        // eligible = sidecar may be used for external URLs even before it is
        // running (mutations trigger the download/launch lazily); a remote
        // client or a broken install is never eligible.
        eligible: (origin ? isLoopbackOrigin(origin) : true) && status !== "error",
        version: browser.version(),
        executablePath: browser.executablePath(),
        pid: browser.pid(),
        bundleId: browser.bundleId(),
        hostMode: browser.hostMode(),
        hostExtension: browser.hostExtension(),
        ...(browser.lastError() ? { error: browser.lastError() } : {}),
        ...(download ? { download } : {}),
      });
      return true;
    }

    if (method === "POST" && parts[1] === "launch") {
      await browser.ensureRunning();
      sendJson(res, 200, { ok: true, status: browser.status() });
      return true;
    }

    if (method === "POST" && parts[1] === "shutdown") {
      await browser.shutdown();
      sendJson(res, 200, { ok: true, status: browser.status() });
      return true;
    }

    if (method === "POST" && parts[1] === "download") {
      await browser.download();
      sendJson(res, 200, { ok: true, status: browser.status() });
      return true;
    }

    if (parts[1] === "tabs") {
      if (method === "GET" && !parts[2]) {
        sendJson(res, 200, { tabs: await browser.listTabs() });
        return true;
      }
      if (method === "POST" && !parts[2]) {
        const body = await readJson(req);
        const target = validTabUrl(body.url);
        await browser.ensureRunning();
        sendJson(res, 200, { tab: await browser.openTab(target) });
        return true;
      }
      const tabId = decodeURIComponent(parts[2] ?? "");
      const op = parts[3];
      if (method !== "POST" && !(method === "GET" && (op === "extract" || op === "screenshot"))) {
        sendJson(res, 405, { error: "Method not allowed", code: "invalid" });
        return true;
      }
      switch (op) {
        case "activate":
          await browser.ensureRunning();
          sendJson(res, 200, { tab: await browser.activateTab(tabId) });
          return true;
        case "close":
          await browser.ensureRunning();
          sendJson(res, 200, await browser.closeTab(tabId));
          return true;
        case "navigate": {
          const body = await readJson(req);
          const target = validTabUrl(body.url);
          await browser.ensureRunning();
          sendJson(res, 200, { tab: await browser.navigateTab(tabId, target) });
          return true;
        }
        case "back":
          await browser.ensureRunning();
          sendJson(res, 200, await browser.backTab(tabId));
          return true;
        case "forward":
          await browser.ensureRunning();
          sendJson(res, 200, await browser.forwardTab(tabId));
          return true;
        case "reload":
          await browser.ensureRunning();
          sendJson(res, 200, await browser.reloadTab(tabId));
          return true;
        case "evaluate": {
          const body = await readJson(req);
          const expression = typeof body.expression === "string" ? body.expression : "";
          if (!expression) throw new BrowserError("invalid", "expression is required");
          await browser.ensureRunning();
          sendJson(res, 200, { result: await browser.evaluateTab(tabId, expression) });
          return true;
        }
        case "extract":
          await browser.ensureRunning();
          sendJson(
            res,
            200,
            await browser.extractTab(tabId, { html: url.searchParams.get("html") === "1" }),
          );
          return true;
        case "screenshot": {
          await browser.ensureRunning();
          const png = await browser.screenshotTab(tabId);
          res.writeHead(200, { "content-type": "image/png" });
          res.end(png);
          return true;
        }
        default:
          sendJson(res, 404, { error: "Unknown tab route", code: "not-found" });
          return true;
      }
    }

    if (parts[1] === "extensions") {
      if (method === "GET" && !parts[2]) {
        sendJson(res, 200, { extensions: await browser.listExtensions() });
        return true;
      }
      if (method === "POST" && !parts[2]) {
        const body = await readJson(req);
        const idOrUrl = typeof body.idOrUrl === "string" ? body.idOrUrl : body.id;
        if (typeof idOrUrl !== "string" || !idOrUrl.trim()) {
          throw new BrowserError("invalid", "idOrUrl is required");
        }
        await browser.ensureRunning();
        sendJson(res, 200, { extension: await browser.installExtension(idOrUrl) });
        return true;
      }
      const extId = decodeURIComponent(parts[2] ?? "");
      const op = parts[3];
      if (method === "DELETE" && !op) {
        await browser.uninstallExtension(extId);
        sendJson(res, 200, { ok: true });
        return true;
      }
      if (method === "POST") {
        switch (op) {
          case "enable":
            await browser.ensureRunning();
            sendJson(res, 200, { extension: await browser.enableExtension(extId) });
            return true;
          case "disable":
            sendJson(res, 200, { extension: await browser.disableExtension(extId) });
            return true;
          case "pin":
            sendJson(res, 200, { extension: await browser.pinExtension(extId, true) });
            return true;
          case "unpin":
            sendJson(res, 200, { extension: await browser.pinExtension(extId, false) });
            return true;
        }
      }
      sendJson(res, 404, { error: "Unknown extension route", code: "not-found" });
      return true;
    }

    if (parts[1] === "window" && method === "POST") {
      const body = await readJson(req);
      switch (parts[2]) {
        case "bounds": {
          await browser.ensureRunning();
          const bounds: Record<string, unknown> = {};
          for (const key of ["x", "y", "width", "height"] as const) {
            const value = body[key];
            if (typeof value === "number" && Number.isFinite(value)) bounds[key] = value;
          }
          if (typeof body.visible === "boolean") bounds.visible = body.visible;
          sendJson(res, 200, await browser.setWindowBounds(bounds));
          return true;
        }
        case "focus":
          await browser.ensureRunning();
          sendJson(res, 200, await browser.focusWindow());
          return true;
        default:
          sendJson(res, 404, { error: "Unknown window route", code: "not-found" });
          return true;
      }
    }

    sendJson(res, 404, { error: "Unknown browser route", code: "not-found" });
    return true;
  } catch (err) {
    sendError(res, err);
    return true;
  }
}

// Re-exported so callers can gate on origin without importing chromium-manager.
export { isLoopbackOrigin };
