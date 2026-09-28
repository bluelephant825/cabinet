import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { BrowserSession } from "../server/browser/browser-session";
import type { CDPClient, CdpEventMessage } from "../server/browser/cdp-client";

type CdpCall = {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

type FakeCdp = CDPClient & {
  calls: CdpCall[];
  emitTarget: (targetInfo: Record<string, unknown>) => void;
  targets: Record<string, unknown>[];
};

function fakeCdp(metrics?: { viewportWidth: number; viewportHeight: number; contentWidth: number }): FakeCdp {
  const calls: CdpCall[] = [];
  const handlers = new Map<string, (event: CdpEventMessage) => void>();
  const targets: Record<string, unknown>[] = [];
  let seq = 0;
  return {
    calls,
    targets,
    send: async (
      method: string,
      params?: Record<string, unknown>,
      sessionId?: string,
    ) => {
      calls.push({ method, params, sessionId });
      if (method === "Target.attachToTarget") {
        return { sessionId: `sess-${params?.targetId}` };
      }
      if (method === "Target.createTarget") {
        return { targetId: `new-target-${++seq}` };
      }
      if (method === "Target.getTargets") {
        return { targetInfos: targets };
      }
      if (method === "Page.getLayoutMetrics" && metrics) {
        return {
          cssLayoutViewport: { clientWidth: metrics.viewportWidth, clientHeight: metrics.viewportHeight },
          cssContentSize: { width: metrics.contentWidth },
        };
      }
      return {};
    },
    onEvent: (method: string, handler: (event: CdpEventMessage) => void) => {
      handlers.set(method, handler);
    },
    emitTarget: (targetInfo: Record<string, unknown>) => {
      handlers.get("Target.targetCreated")?.({
        method: "Target.targetCreated",
        params: { targetInfo },
      });
    },
  } as unknown as FakeCdp;
}

function tmpUserData(): void {
  process.env.CABINET_USER_DATA = fs.mkdtempSync(
    path.join(os.tmpdir(), "cabinet-session-"),
  );
}

test("open() navigates a lone about:blank startup tab instead of stacking a second tab", async () => {
  tmpUserData();
  const cdp = fakeCdp();
  const session = new BrowserSession(cdp);
  await session.start();
  cdp.emitTarget({ targetId: "t-blank", type: "page", url: "about:blank", title: "" });

  const tab = await session.open("https://example.com/");

  assert.equal(tab.id, "t-blank");
  assert.equal(tab.url, "https://example.com/");
  const methods = cdp.calls.map((c) => c.method);
  assert.ok(!methods.includes("Target.createTarget"));
  const nav = cdp.calls.find((c) => c.method === "Page.navigate");
  assert.ok(nav, "expected Page.navigate on the blank tab");
  assert.equal(nav!.params?.url, "https://example.com/");
  assert.equal(nav!.sessionId, "sess-t-blank");
});

test("open() creates a new tab when an existing tab is a real page", async () => {
  tmpUserData();
  const cdp = fakeCdp();
  const session = new BrowserSession(cdp);
  await session.start();
  cdp.emitTarget({ targetId: "t-page", type: "page", url: "https://a.com/", title: "A" });

  await session.open("https://example.com/");

  const create = cdp.calls.find((c) => c.method === "Target.createTarget");
  assert.ok(create, "expected Target.createTarget");
  assert.equal(create!.params?.url, "https://example.com/");
  assert.equal(create!.params?.newWindow, false);
  assert.ok(!cdp.calls.some((c) => c.method === "Page.navigate"));
});

test("open() with no tracked targets opens a fresh window", async () => {
  tmpUserData();
  const cdp = fakeCdp();
  const session = new BrowserSession(cdp);
  await session.start();

  await session.open("https://example.com/");

  const create = cdp.calls.find((c) => c.method === "Target.createTarget");
  assert.ok(create);
  assert.equal(create!.params?.newWindow, true);
});

test("fitWidth() scales overflowing content without resizing the native tab view", async () => {
  tmpUserData();
  const metrics = { viewportWidth: 1074, viewportHeight: 698, contentWidth: 1249 };
  const cdp = fakeCdp(metrics);
  const session = new BrowserSession(cdp);
  await session.start();
  cdp.emitTarget({ targetId: "t-page", type: "page", url: "https://example.com/", title: "A" });

  assert.deepEqual(await session.fitWidth("t-page"), { ok: true, applied: true });
  const override = cdp.calls.find((call) => call.method === "Emulation.setDeviceMetricsOverride");
  assert.deepEqual(override?.params, {
    width: 1249,
    height: Math.ceil(698 / (1074 / 1249)),
    deviceScaleFactor: 0,
    mobile: false,
    scale: 1074 / 1249,
    dontSetVisibleSize: true,
  });
  assert.equal(override?.sessionId, "sess-t-page");

  metrics.contentWidth = 1074;
  assert.deepEqual(await session.fitWidth("t-page"), { ok: true, applied: false });
  assert.equal(cdp.calls.filter((call) => call.method === "Emulation.clearDeviceMetricsOverride").length, 1);
  assert.equal(cdp.calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride").length, 1);
});

test("closeExtensionPages() closes chrome-extension pages only", async () => {
  tmpUserData();
  const cdp = fakeCdp();
  const session = new BrowserSession(cdp);
  await session.start();
  cdp.targets.push(
    { targetId: "t-page", type: "page", url: "https://a.com/" },
    {
      targetId: "t-welcome",
      type: "page",
      url: "chrome-extension://cjibomnalgepdahkocplgeieoochilib/src/welcome.html",
    },
    {
      targetId: "t-sw",
      type: "service_worker",
      url: "chrome-extension://cjibomnalgepdahkocplgeieoochilib/sw.js",
    },
    { targetId: "t-devtools", type: "page", url: "devtools://devtools/x" },
  );

  const closed = await session.closeExtensionPages();

  assert.equal(closed, 1);
  const closedIds = cdp.calls
    .filter((c) => c.method === "Target.closeTarget")
    .map((c) => c.params?.targetId);
  assert.deepEqual(closedIds, ["t-welcome"]);
});
