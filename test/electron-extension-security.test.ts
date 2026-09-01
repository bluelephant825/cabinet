import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = process.cwd();
const mainSource = readFileSync(path.join(root, "electron", "main.cjs"), "utf8");
const browserViewsSource = readFileSync(
  path.join(root, "electron", "browser-views.cjs"),
  "utf8"
);

const rendererExtensionChannels = [
  "install-extension",
  "get-extensions",
  "update-extension",
  "toggle-extension",
  "uninstall-extension",
  "show-extension-popup",
];

test("extension lifecycle IPC handlers authorize their sender", () => {
  for (const channel of rendererExtensionChannels) {
    const start = mainSource.indexOf(`ipcMain.handle("cabinet:${channel}"`);
    assert.notEqual(start, -1, `missing cabinet:${channel} handler`);
    const nextHandler = mainSource.indexOf("ipcMain.handle(", start + 20);
    const handler = mainSource.slice(start, nextHandler === -1 ? undefined : nextHandler);
    assert.match(
      handler,
      /isTrustedRendererSender\(event\)/,
      `cabinet:${channel} must reject untrusted senders`
    );
  }
});

test("native extension menu and toast handlers authorize their sender", () => {
  for (const channel of ["show-extensions-menu", "show-native-toast"]) {
    const start = browserViewsSource.indexOf(`ipcMain.handle("cabinet:${channel}"`);
    assert.notEqual(start, -1, `missing cabinet:${channel} handler`);
    const handler = browserViewsSource.slice(start, start + 500);
    assert.match(handler, /isMainRendererSender\(event\)/);
  }
});

test("CRX extraction rejects paths outside the staging directory", () => {
  assert.match(mainSource, /path\.relative\(stagingDir, destination\)/);
  assert.match(mainSource, /relative\.startsWith\("\.\."\) \|\| path\.isAbsolute\(relative\)/);
});
