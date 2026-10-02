import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { CdpBridge, type BridgeCdpClient } from "../server/browser/cdp-bridge";
import type { CdpEventMessage } from "../server/browser/cdp-client";

class FakeCdp implements BridgeCdpClient {
  readonly calls: { method: string; params?: Record<string, unknown>; sessionId?: string }[] = [];
  readonly handlers = new Map<string, (event: CdpEventMessage) => void>();

  async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    this.calls.push({ method, params, sessionId });
    if (method === "Target.attachToBrowserTarget") return { sessionId: "ROOT" };
    if (method === "Target.getTargets") {
      return {
        targetInfos: [
          { targetId: "USER", type: "page", url: "https://example.com" },
          { targetId: "SHELL", type: "page", url: "http://127.0.0.1:4000/app" },
          { targetId: "EXT", type: "page", url: "chrome-extension://abc/options.html" },
          { targetId: "WORKER", type: "worker", url: "https://example.com/worker.js" },
        ],
      };
    }
    if (method === "Target.createTarget") return { targetId: "AGENT" };
    if (method === "Target.attachToTarget") return { sessionId: "PAGE" };
    if (method === "Runtime.evaluate") return { result: { value: 7 } };
    return {};
  }

  claimIsolatedSession(sessionId: string, handler: (event: CdpEventMessage) => void): void {
    this.handlers.set(sessionId, handler);
  }

  releaseIsolatedSession(sessionId: string, handler?: (event: CdpEventMessage) => void): void {
    if (!handler || this.handlers.get(sessionId) === handler) this.handlers.delete(sessionId);
  }
}

async function connect(url: string): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

async function call(socket: WebSocket, id: number, method: string, params?: Record<string, unknown>, sessionId?: string) {
  const result = new Promise<Record<string, unknown>>((resolve, reject) => {
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (message.id !== id) return;
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) }));
  return result;
}

async function waitForRoot(fake: FakeCdp): Promise<void> {
  for (let index = 0; index < 100 && !fake.handlers.has("ROOT"); index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(fake.handlers.has("ROOT"), true);
}

test("bridge filters targets, isolates sessions, and protects user tabs", async () => {
  const fake = new FakeCdp();
  const bridge = new CdpBridge(fake, "http://127.0.0.1:4000");
  const url = await bridge.start();
  const socket = await connect(url);
  await waitForRoot(fake);

  const listed = await call(socket, 1, "Target.getTargets");
  assert.deepEqual(listed, {
    id: 1,
    result: { targetInfos: [{ targetId: "USER", type: "page", url: "https://example.com" }] },
  });

  const denied = await call(socket, 2, "Target.closeTarget", { targetId: "USER" });
  assert.equal((denied.error as { message: string }).message, "Browser automation cannot close a user tab");

  const opened = await call(socket, 3, "Target.createTarget", { url: "https://example.org" });
  assert.deepEqual(opened, { id: 3, result: { targetId: "AGENT" } });
  assert.deepEqual(await call(socket, 4, "Target.closeTarget", { targetId: "AGENT" }), { id: 4, result: {} });
  fake.handlers.get("ROOT")?.({
    method: "Target.targetCreated",
    sessionId: "ROOT",
    params: { targetInfo: { targetId: "POPUP", type: "page", url: "https://popup.example", openerId: "AGENT" } },
  });
  assert.deepEqual(await call(socket, 41, "Target.closeTarget", { targetId: "POPUP" }), { id: 41, result: {} });

  assert.deepEqual(await call(socket, 5, "Target.attachToTarget", { targetId: "USER", flatten: true }), {
    id: 5,
    result: { sessionId: "PAGE" },
  });
  assert.equal(fake.handlers.has("PAGE"), true);
  assert.deepEqual(await call(socket, 6, "Runtime.evaluate", { expression: "7" }, "PAGE"), {
    id: 6,
    result: { result: { value: 7 } },
  });

  socket.close();
  await new Promise((resolve) => socket.once("close", resolve));
  for (let index = 0; index < 100 && fake.handlers.size > 0; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await bridge.close();
  assert.equal(fake.handlers.size, 0);
  assert.equal(fake.calls.some((entry) => entry.method === "Target.detachFromTarget"), true);
});

test("bridge rejects invalid capabilities and browser-destructive methods", async () => {
  const fake = new FakeCdp();
  const bridge = new CdpBridge(fake);
  const url = await bridge.start();
  const invalid = url.replace(/[^/]+$/, "wrong");
  const status = await new Promise<number>((resolve) => {
    const socket = new WebSocket(invalid);
    socket.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
  });
  assert.equal(status, 403);

  const socket = await connect(url);
  await waitForRoot(fake);
  const denied = await call(socket, 1, "Browser.close");
  assert.equal((denied.error as { message: string }).message, "CDP method is not allowed: Browser.close");
  socket.close();
  await new Promise((resolve) => socket.once("close", resolve));
  await bridge.close();
});
