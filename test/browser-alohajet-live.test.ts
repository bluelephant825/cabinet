import test from "node:test";
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const enabled = process.env.CABINET_TEST_ALOHAJET_LIVE === "1";

test("AlohaJet drives Cabinet Chromium through the private bridge", { skip: !enabled, timeout: 180_000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "cabinet-alohajet-live-"));
  const fixture = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end('<!doctype html><title>Fixture Page</title><button id="change" onclick="this.textContent=\'Changed\'">Change</button><p>Ready</p>');
  });
  await new Promise<void>((resolve) => fixture.listen(0, "127.0.0.1", resolve));
  const fixtureUrl = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  process.env.CABINET_USER_DATA = path.join(root, "user-data");
  process.env.CABINET_DATA_DIR = path.join(root, "data-parent");
  const [{ createBrowserDaemon }, { AlohaJetManager }, { BrowserAutomationService }] = await Promise.all([
    import("../server/browser/facade"),
    import("../server/browser/alohajet-manager"),
    import("../server/browser/automation-service"),
  ]);
  const daemon = createBrowserDaemon();
  const manager = new AlohaJetManager({
    installDir: path.join(root, "alohajet"),
    settingsPath: path.join(root, ".devin", "browser-automation.json"),
  });
  const automation = new BrowserAutomationService({
    manager,
    ensureBrowser: async () => { await daemon.manager.ensureRunning(); },
    getCdp: () => daemon.manager.cdpClient,
    hiddenOrigin: "http://127.0.0.1:4000",
    idleMs: 60_000,
  });
  try {
    await manager.updateSettings({ enabled: true });
    await daemon.manager.ensureRunning();
    const userTab = await daemon.facade.openTab("about:blank");
    automation.registerRun({ runId: "live", agentSlug: "test" });

    const closed = await automation.call("live", "browser_tabs", { action: "close", tabId: userTab.id });
    assert.equal(closed.isError, true);

    const opened = await automation.call("live", "browser_tabs", { action: "open", url: fixtureUrl });
    const openText = opened.content.map((item) => item.type === "text" ? String(item.text ?? "") : "").join("\n");
    const tabId = /ID:\s*"([^"]+)"/.exec(openText)?.[1];
    assert.ok(tabId, openText);
    assert.match(openText, /Fixture Page/);
    const alohaId = /aloha-id="([0-9a-f]{8})"/.exec(openText)?.[1];
    assert.ok(alohaId, openText);

    const clicked = await automation.call("live", "browser_click", { tabId, alohaId });
    assert.equal(clicked.isError, false, JSON.stringify(clicked));
    const clickText = clicked.content.map((item) => item.type === "text" ? String(item.text ?? "") : "").join("\n");
    assert.match(clickText, /Clicked element|Changed/i);
    const reread = await automation.call("live", "browser_read", { tabId });
    const rereadText = reread.content.map((item) => item.type === "text" ? String(item.text ?? "") : "").join("\n");
    assert.match(rereadText, /Changed/);
    assert.equal((await daemon.facade.listTabs()).some((tab) => tab.id === userTab.id), true);
  } finally {
    await automation.releaseRun("live").catch(() => {});
    await daemon.automation.closeAll().catch(() => {});
    await daemon.manager.shutdown().catch(() => {});
    await new Promise<void>((resolve) => fixture.close(() => resolve()));
    await fsp.rm(root, { recursive: true, force: true });
  }
});
