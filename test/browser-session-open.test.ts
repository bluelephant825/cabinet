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
  emitTargetDestroyed: (targetId: string) => void;
  targets: Record<string, unknown>[];
};

function fakeCdp(metrics?: {
  viewportWidth: number;
  viewportHeight: number;
  contentWidth: number;
  innerWidth?: number;
  innerHeight?: number;
}): FakeCdp {
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
      if (method === "Runtime.evaluate" && String(params?.expression ?? "").includes("window.innerWidth")) {
        return {
          result: {
            value: metrics
              ? {
                  iw: metrics.innerWidth ?? metrics.viewportWidth,
                  ih: metrics.innerHeight ?? metrics.viewportHeight,
                  cw: metrics.viewportWidth,
                  ch: metrics.viewportHeight,
                }
              : null,
          },
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
    emitTargetDestroyed: (targetId: string) => {
      handlers.get("Target.targetDestroyed")?.({
        method: "Target.targetDestroyed",
        params: { targetId },
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

test("fitWidth() scales overflowing content to the full viewport without resizing the native tab view", async () => {
  tmpUserData();
  // Slim-scrollbar style is injected before measuring: the styled 5px
  // vertical bar leaves clientWidth = innerWidth - 5, and the hidden
  // horizontal bar leaves clientHeight = innerHeight.
  const metrics = { viewportWidth: 1069, viewportHeight: 698, innerWidth: 1074, innerHeight: 698, contentWidth: 1249 };
  const cdp = fakeCdp(metrics);
  const session = new BrowserSession(cdp);
  await session.start();
  cdp.emitTarget({ targetId: "t-page", type: "page", url: "https://example.com/", title: "A" });

  assert.deepEqual(await session.fitWidth("t-page"), { ok: true, applied: true });
  const override = cdp.calls.find((call) => call.method === "Emulation.setDeviceMetricsOverride");
  // Emulated width covers content + scrollbar; scale spans the FULL
  // viewport (innerWidth) so the painted frame reaches the view's right
  // and bottom edges rather than leaving unpainted strips.
  assert.deepEqual(override?.params, {
    width: 1254,
    height: Math.ceil(698 / (1074 / 1254)),
    deviceScaleFactor: 0,
    mobile: false,
    scale: 1074 / 1254,
    dontSetVisibleSize: true,
  });
  assert.equal(override?.sessionId, "sess-t-page");
  assert.ok(cdp.calls.some((call) => call.method === "Runtime.evaluate" && String(call.params?.expression).includes("html::-webkit-scrollbar{width:5px")));

  metrics.contentWidth = 1060;
  assert.deepEqual(await session.fitWidth("t-page"), { ok: true, applied: false });
  assert.equal(cdp.calls.filter((call) => call.method === "Emulation.clearDeviceMetricsOverride").length, 1);
  assert.equal(cdp.calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride").length, 1);
  assert.ok(cdp.calls.some((call) => call.method === "Runtime.evaluate" && String(call.params?.expression).includes('getElementById("cabinet-fit-width-scrollbar")?.remove()')));

  // No vertical scrollbar at measure time: no width reserve.
  metrics.contentWidth = 1249;
  metrics.innerWidth = metrics.viewportWidth;
  assert.deepEqual(await session.fitWidth("t-page"), { ok: true, applied: true });
  const withoutScrollbar = cdp.calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride")[1];
  assert.equal(withoutScrollbar.params?.width, 1249);
  assert.equal(withoutScrollbar.params?.scale, 1069 / 1249);
});

test("fitWidth() keeps an already-fitted page's emulation for the same pane instead of resetting it", async () => {
  tmpUserData();
  const metrics = { viewportWidth: 1069, viewportHeight: 698, innerWidth: 1074, innerHeight: 698, contentWidth: 1249 };
  const cdp = fakeCdp(metrics);
  const session = new BrowserSession(cdp);
  await session.start();
  cdp.emitTarget({ targetId: "t-page", type: "page", url: "https://example.com/", title: "A" });
  const pane = { width: 1074, height: 698 };
  const count = (method: string) => cdp.calls.filter((call) => call.method === method).length;

  assert.deepEqual(await session.fitWidth("t-page", pane), { ok: true, applied: true });
  // Under emulation the page lays out at the emulated width minus the bar.
  metrics.contentWidth = 1249;
  assert.deepEqual(await session.fitWidth("t-page", { ...pane }), { ok: true, applied: true });
  assert.equal(count("Emulation.clearDeviceMetricsOverride"), 0, "a repeat check must not flash the unscaled page");
  assert.equal(count("Emulation.setDeviceMetricsOverride"), 1);

  // Late content widened the page: re-scale directly, still without a reset.
  metrics.contentWidth = 1400;
  await session.fitWidth("t-page", pane);
  assert.equal(count("Emulation.clearDeviceMetricsOverride"), 0);
  const widened = cdp.calls.filter((call) => call.method === "Emulation.setDeviceMetricsOverride")[1];
  assert.equal(widened.params?.width, 1405);
  assert.equal(widened.params?.scale, 1074 / 1405);

  // A different pane size re-measures from natural metrics.
  metrics.contentWidth = 1249;
  await session.fitWidth("t-page", { width: 900, height: 698 });
  assert.equal(count("Emulation.clearDeviceMetricsOverride"), 1);
  assert.ok(
    cdp.calls.some((call) => call.method === "Runtime.evaluate" && String(call.params?.expression).includes("setTimeout(resolve, 100)")),
    "the post-reset frame wait must be bounded for background tabs",
  );
});

test("fitWidth() leaves pages that already fit untouched (no scrollbar style churn)", async () => {
  tmpUserData();
  const cdp = fakeCdp({ viewportWidth: 1059, viewportHeight: 698, innerWidth: 1074, innerHeight: 698, contentWidth: 1059 });
  const session = new BrowserSession(cdp);
  await session.start();
  cdp.emitTarget({ targetId: "t-page", type: "page", url: "https://example.com/", title: "A" });

  assert.deepEqual(await session.fitWidth("t-page", { width: 1074, height: 698 }), { ok: true, applied: false });
  assert.ok(
    !cdp.calls.some((call) => call.method === "Runtime.evaluate" && String(call.params?.expression).includes("cabinet-fit-width-scrollbar")),
    "injecting then removing the style repaints the scrollbar",
  );
});

test("fitWidth() skips a background tab that was never laid out at the pane's size", async () => {
  tmpUserData();
  // A restored background tab still has Chromium's default window size.
  const cdp = fakeCdp({ viewportWidth: 1195, viewportHeight: 800, innerWidth: 1200, innerHeight: 800, contentWidth: 1249 });
  const session = new BrowserSession(cdp);
  await session.start();
  cdp.emitTarget({ targetId: "t-page", type: "page", url: "https://example.com/", title: "A" });

  assert.deepEqual(await session.fitWidth("t-page", { width: 1074, height: 698 }), { ok: true, applied: false });
  assert.ok(!cdp.calls.some((call) => call.method === "Emulation.setDeviceMetricsOverride"));

  // Once it is the active tab the mismatch is page zoom, not stale sizing: fit.
  await session.activate("t-page");
  assert.deepEqual(await session.fitWidth("t-page", { width: 1074, height: 698 }), { ok: true, applied: true });
});

test("close() notifies listeners even when the targetDestroyed event arrives later", async () => {
  tmpUserData();
  const cdp = fakeCdp();
  const session = new BrowserSession(cdp);
  await session.start();
  cdp.emitTarget({ targetId: "t-page", type: "page", url: "https://example.com/", title: "Example" });
  const closed: string[] = [];
  session.on("tab-closed", (tab: { id: string }) => closed.push(tab.id));

  await session.close("t-page");
  assert.deepEqual(closed, ["t-page"]);
  cdp.emitTargetDestroyed("t-page");
  assert.deepEqual(closed, ["t-page"]);
  assert.deepEqual(session.listTabs(), []);
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
