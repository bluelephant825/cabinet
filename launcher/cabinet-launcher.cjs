/* eslint-disable @typescript-eslint/no-require-imports */
"use strict";

/**
 * Cabinet packaged launcher — the Chromium-host equivalent of the Electron
 * main.cjs backend half.
 *
 * This file runs inside the app bundle as `Contents/MacOS/Cabinet`, a Node
 * single-executable application (SEA). It owns everything Electron used to do
 * short of the window itself:
 *
 *   - resolve the user data dir + content cabinet (same rules as main.cjs)
 *   - extract node-pty / the Vision OCR helper out of the read-only bundle
 *   - allocate the app port (stable across launches — the shell origin keys
 *     localStorage/IndexedDB) and a fresh daemon port
 *   - spawn the standalone Next server + cabinet-daemon with the packaged env
 *     (CABINET_RUNTIME=chromium, host mode, bundled Chromium path, …)
 *   - respawn backends on crash (with a crash-loop guard)
 *   - launch the bundled Chromium fork once the app is healthy
 *   - shut the whole stack down when the browser quits (daemon exits on clean
 *     browser exit in packaged mode → we tear down and exit)
 *
 * The browser is spawned by the daemon (CDP pipes only work parent→child), so
 * this process is the supervisor root, not the browser's parent. The Dock/menu
 * identity still resolves to Cabinet.app because the Chromium binary lives at
 * Contents/MacOS/Chromium inside this bundle.
 */

const { execFile, execFileSync, spawn } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const util = require("util");

// ---------------------------------------------------------------------------
// LaunchServices detach — the process opened via `open`/Dock IS the bundle's
// launch record. If it stays alive without ever checking in with the
// WindowServer (we're a plain Node binary, not an app), the Dock keeps a
// second, forever-bouncing tile next to the real Chromium one. Respawn
// detached and exit immediately so the launch record dies with this process;
// the child does all supervision work. The single-instance guard below runs
// in the child, so a repeat `open` still routes to activate-and-exit.
// ---------------------------------------------------------------------------
if (process.env.CABINET_LAUNCHER_DETACHED !== "1") {
  const child = spawn(process.execPath, process.argv.slice(1), {
    env: { ...process.env, CABINET_LAUNCHER_DETACHED: "1" },
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// Inside the bundle: Contents/MacOS/Cabinet → Contents/Resources/app holds the
// standalone Next tree staged by scripts/prepare-electron-package.mjs
// (server.js, server/cabinet-daemon.cjs, bin/node, .native/, .seed/, documents/).
// CABINET_RESOURCES_DIR lets a plain `node launcher/cabinet-launcher.cjs` run
// against a staging dir for testing.
const execDir = path.dirname(process.execPath);
const bundleContentsDir = path.dirname(execDir); // .../Cabinet.app/Contents
const resourcesDir =
  process.env.CABINET_RESOURCES_DIR?.trim() ||
  path.join(bundleContentsDir, "Resources");
const appRoot = path.join(resourcesDir, "app");

function packagedStandalonePath(...parts) {
  return path.join(appRoot, ...parts);
}

// Same userData dir Electron used for the "Cabinet" app: migrating installs
// keep cabinet-config.json (dataDir choice, persisted port) and Browser/.
const userDataDir =
  process.env.CABINET_USER_DATA?.trim() ||
  path.join(os.homedir(), "Library", "Application Support", "Cabinet");
const cabinetConfigPath = path.join(userDataDir, "cabinet-config.json");
const legacyDataDir = path.join(userDataDir, "cabinet-data");

// The bundled Chromium binary sits next to the launcher in Contents/MacOS so
// it resolves Chromium Framework.framework from this same bundle.
const chromiumBinaryPath = path.join(execDir, "Chromium");

// ---------------------------------------------------------------------------
// Minimal logger — tee console to <dataDir>/.cabinet-state/logs/launcher.log,
// 5 MB × 2 rotation (same shape as electron/logger.cjs).
// ---------------------------------------------------------------------------

let logFile = null;
const orig = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function appendLog(line) {
  if (!logFile) return;
  try {
    const stat = fs.existsSync(logFile) ? fs.statSync(logFile) : null;
    if (stat && stat.size > 5 * 1024 * 1024) {
      const prev = logFile.replace(/\.log$/, ".1.log");
      fs.rmSync(prev, { force: true });
      fs.renameSync(logFile, prev);
    }
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
  } catch {
    // logging must never crash the launcher
  }
}

function initLogging(dir) {
  try {
    const logsDir = path.join(dir, ".cabinet-state", "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    logFile = path.join(logsDir, "launcher.log");
    for (const level of ["log", "info", "warn", "error"]) {
      console[level] = (...args) => {
        orig[level](...args);
        appendLog(
          args
            .map((a) => (typeof a === "string" ? a : util.format("%o", a)))
            .join(" "),
        );
      };
    }
  } catch {
    // non-fatal
  }
}
// ---------------------------------------------------------------------------
// Data dir resolution (ported from electron/main.cjs)
// ---------------------------------------------------------------------------

function defaultUserVisibleDataDir() {
  const home = os.homedir();
  if (process.platform === "darwin" || process.platform === "win32") {
    return path.join(home, "Documents", "Cabinet");
  }
  return path.join(home, "Cabinet");
}

function readPersistedConfig() {
  try {
    return JSON.parse(fs.readFileSync(cabinetConfigPath, "utf8")) || {};
  } catch {
    return {};
  }
}

function writePersistedConfig(patch) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    const existing = readPersistedConfig();
    fs.writeFileSync(
      cabinetConfigPath,
      JSON.stringify({ ...existing, ...patch }, null, 2),
      "utf8",
    );
  } catch {
    // best effort
  }
}

function readPersistedDataDir() {
  const dir = readPersistedConfig()?.dataDir;
  return typeof dir === "string" && dir.trim() ? dir.trim() : null;
}

function dirHasContent(dir) {
  try {
    return fs.readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

function resolveManagedDataDir() {
  const envDir = process.env.CABINET_DATA_DIR?.trim();
  if (envDir) return path.resolve(envDir);
  const persisted = readPersistedDataDir();
  if (persisted) return persisted;
  // Legacy <userData>/cabinet-data installs (v0.4.3 and earlier).
  if (dirHasContent(legacyDataDir)) {
    writePersistedConfig({ dataDir: legacyDataDir });
    return legacyDataDir;
  }
  const fresh = defaultUserVisibleDataDir();
  writePersistedConfig({ dataDir: fresh });
  return fresh;
}

const managedDataDir = resolveManagedDataDir();

initLogging(managedDataDir);

// ---------------------------------------------------------------------------
// Single instance — second launch activates the running app and exits.
// ---------------------------------------------------------------------------

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireSingleInstance() {
  const stateDir = path.join(userDataDir, ".cabinet-state");
  const pidPath = path.join(stateDir, "launcher.pid");
  try {
    const existing = Number.parseInt(
      fs.readFileSync(pidPath, "utf8").trim(),
      10,
    );
    if (Number.isInteger(existing) && existing > 0 && existing !== process.pid && pidAlive(existing)) {
      // Activate the running instance's window via LaunchServices.
      try {
        execFile("open", ["-b", "com.runcabinet.cabinet"], () => {});
      } catch {}
      return false;
    }
  } catch {
    // missing/corrupt pidfile is fine
  }
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(pidPath, String(process.pid), { mode: 0o600 });
  } catch {}
  return true;
}

// ---------------------------------------------------------------------------
// Native module + OCR helper extraction (ported from main.cjs)
// ---------------------------------------------------------------------------

function extractOcrHelper() {
  const platformDir =
    process.platform === "win32" ? "win32-x64" : `darwin-${process.arch}`;
  const bundledDir = packagedStandalonePath("documents", "ocr", platformDir);
  if (process.platform !== "darwin" || !fs.existsSync(bundledDir)) {
    return fs.existsSync(bundledDir) ? bundledDir : null;
  }

  const externalDir = path.join(userDataDir, "documents-ocr", platformDir);
  const bundledBinary = path.join(bundledDir, "vision-ocr");
  const externalBinary = path.join(externalDir, "vision-ocr");
  if (!fs.existsSync(bundledBinary)) return null;

  let needsCopy = true;
  if (fs.existsSync(externalBinary)) {
    needsCopy =
      fs.statSync(bundledBinary).mtimeMs > fs.statSync(externalBinary).mtimeMs;
  }
  if (needsCopy) {
    fs.mkdirSync(externalDir, { recursive: true });
    fs.copyFileSync(bundledBinary, externalBinary);
    fs.chmodSync(externalBinary, 0o755);
    try {
      execFileSync("xattr", ["-dr", "com.apple.quarantine", externalBinary]);
    } catch {}
    try {
      execFileSync("codesign", ["--force", "--sign", "-", externalBinary]);
    } catch {}
  }
  return externalDir;
}

function extractNativeModules() {
  if (process.platform !== "darwin") {
    return packagedStandalonePath(".native");
  }

  const externalModulesDir = path.join(userDataDir, "native-modules");
  const externalNodePty = path.join(externalModulesDir, "node-pty");
  const bundledNodePty = packagedStandalonePath(".native", "node-pty");
  const bundledPkgPath = path.join(bundledNodePty, "package.json");
  const externalPkgPath = path.join(externalNodePty, "package.json");

  let needsCopy = true;
  if (fs.existsSync(externalPkgPath) && fs.existsSync(bundledPkgPath)) {
    needsCopy =
      fs.statSync(bundledPkgPath).mtimeMs > fs.statSync(externalPkgPath).mtimeMs ||
      !fs.existsSync(path.join(externalNodePty, "prebuilds", `darwin-${process.arch}`, "pty.node"));
  }

  if (needsCopy) {
    fs.rmSync(externalNodePty, { recursive: true, force: true });
    fs.mkdirSync(externalModulesDir, { recursive: true });
    fs.cpSync(bundledNodePty, externalNodePty, { recursive: true });
    console.log("launcher: native pty after copy", fs.existsSync(path.join(externalNodePty, "prebuilds", `darwin-${process.arch}`, "pty.node")));

    const prebuildsDir = path.join(externalNodePty, "prebuilds", "darwin-arm64");
    for (const name of ["spawn-helper", "pty.node"]) {
      const target = path.join(prebuildsDir, name);
      if (fs.existsSync(target)) {
        try {
          execFileSync("xattr", ["-dr", "com.apple.quarantine", target]);
        } catch {}
        try {
          execFileSync("codesign", ["--force", "--sign", "-", target]);
        } catch {}
      }
    }
    console.log("launcher: native pty after signing", fs.existsSync(path.join(prebuildsDir, "pty.node")));
  }

  return externalModulesDir;
}

/** Copy bundled seed content into the data dir, never overwriting user files. */
function seedDefaultContent() {
  const seedDir = packagedStandalonePath(".seed");
  if (!fs.existsSync(seedDir)) return;
  const copyRecursive = (src, dest) => {
    if (fs.statSync(src).isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      for (const entry of fs.readdirSync(src)) {
        copyRecursive(path.join(src, entry), path.join(dest, entry));
      }
    } else if (!fs.existsSync(dest)) {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  };
  copyRecursive(seedDir, managedDataDir);
}

function ensureManagedData() {
  fs.mkdirSync(managedDataDir, { recursive: true });
  seedDefaultContent();
}

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

function readPersistedAppPort() {
  const port = readPersistedConfig()?.appPort;
  return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a loopback port."));
      });
    });
    server.on("error", reject);
  });
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

// The port is part of the shell origin — a fresh port every launch wipes
// localStorage/IndexedDB. Reuse the persisted port unless it's taken.
async function getStableAppPort() {
  const persisted = readPersistedAppPort();
  if (persisted && (await isPortAvailable(persisted))) return persisted;
  const port = await getFreePort();
  writePersistedConfig({ appPort: port });
  return port;
}

// ---------------------------------------------------------------------------
// Backend supervision (ported from main.cjs)
// ---------------------------------------------------------------------------

let backendChildren = [];
let backendsQuitting = false;

function spawnBackend(command, args, env, meta) {
  const child = spawn(command, args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  backendChildren.push(child);
  const spawnedAt = Date.now();
  child.stdout?.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) console.log(`[${meta.name}] ${line.trimEnd()}`);
    }
  });
  child.stderr?.on("data", (chunk) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) console.warn(`[${meta.name}] ${line.trimEnd()}`);
    }
  });
  child.on("exit", (code, signal) => {
    backendChildren = backendChildren.filter((entry) => entry !== child);
    if (backendsQuitting) return;
    if (meta.name === "app" && code === 42 && signal == null) {
      void restartBackends().catch((err) => {
        console.error("launcher: restart failed:", err);
        cleanupBackends();
        showFatalDialog(`Cabinet could not restart. Please reopen it.\n\nLog: ${logFile || "unknown"}`);
        process.exit(1);
      });
      return;
    }
    // A clean exit means intentional shutdown (e.g. the daemon exits after a
    // clean browser quit in packaged mode) — unwind the whole stack rather
    // than respawning. The app cannot run without either backend.
    if (code === 0 && signal == null) {
      console.warn(`launcher: ${meta.name} exited cleanly — shutting down`);
      // The daemon exits cleanly when the browser fails to launch too — if the
      // window was never confirmed up, surface that instead of vanishing.
      if (!browserConfirmed) {
        showFatalDialog(
          `Cabinet could not open its browser window and has quit.\n\nLog: ${logFile || "unknown"}`,
        );
      }
      cleanupBackends();
      process.exit(0);
    }
    // A backend that survives >60s resets the crash-loop budget; rapid
    // exits indicate a real failure — stop respawning rather than spinning.
    meta.quickDeaths = Date.now() - spawnedAt > 60_000 ? 0 : (meta.quickDeaths || 0) + 1;
    if (meta.quickDeaths > 3) {
      console.error(`launcher: ${meta.name} backend is crash-looping — not respawning`);
      cleanupBackends();
      process.exit(1);
    }
    console.warn(`launcher: ${meta.name} backend exited — respawning`);
    spawnBackend(command, args, env, meta);
  });
  return child;
}

function bundledNodePath() {
  const bundled = packagedStandalonePath(
    "bin",
    process.platform === "win32" ? "node.exe" : "node",
  );
  if (!fs.existsSync(bundled)) {
    // No fallback to process.execPath: this binary is a SEA that runs the
    // embedded launcher regardless of args — spawning it as "node" would
    // recurse into a second launcher instance.
    throw new Error(`bundled node runtime missing at ${bundled}`);
  }
  return bundled;
}

function spawnNodeBackend(args, env, meta) {
  return spawnBackend(bundledNodePath(), args, env, meta);
}

async function waitForHealth(url, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await checkHealth(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function checkHealth(url, timeoutMs = 1200) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Daemon auth — the token file lives under <managedDataDir>/.cabinet-state
// (cabinet-independent: DATA_DIR resolves to the active cabinet, which can
// change while the stack is booting and desync the two sides).
// Create it if missing so the launch POST can authenticate immediately.
// ---------------------------------------------------------------------------

function ensureDaemonToken() {
  const runtimeDir = path.join(managedDataDir, ".cabinet-state");
  const tokenPath = path.join(runtimeDir, "daemon-token");
  try {
    const existing = fs.readFileSync(tokenPath, "utf8").trim();
    if (existing) return existing;
  } catch {
    // create below
  }
  const token = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(runtimeDir, { recursive: true });
    const fd = fs.openSync(tokenPath, "wx", 0o600);
    fs.writeFileSync(fd, `${token}\n`, "utf8");
    fs.closeSync(fd);
    return token;
  } catch {
    // raced with the daemon creating it — read whatever won
    try {
      return fs.readFileSync(tokenPath, "utf8").trim();
    } catch {
      return token;
    }
  }
}

// Set once the daemon confirms the browser window is up. The app is invisible
// until then — if the whole tree tears down before this flips, the user would
// otherwise see a bounce in the Dock and nothing else.
let browserConfirmed = false;
let appOriginForLinks = null;
let browserExecutableForLinks = null;
const pendingDeepLinks = [];

function flushDeepLinks() {
  if (!browserConfirmed || !appOriginForLinks || !browserExecutableForLinks) return;
  while (pendingDeepLinks.length > 0) {
    const uri = pendingDeepLinks.shift();
    console.log("launcher: dispatching cabinet deep link");
    const browser = spawn(browserExecutableForLinks, [
      `--user-data-dir=${path.join(userDataDir, "Browser", "Profile")}`,
      `--cabinet-ui-url=${appOriginForLinks}`,
      uri,
    ], { stdio: "ignore" });
    browser.on("error", (error) => console.error("launcher: deep link delivery failed:", error));
    browser.on("exit", (code) => {
      if (code !== 0) console.error("launcher: deep link dispatch exited with code", code);
    });
  }
}

if (process.env.CABINET_PROTOCOL_BRIDGE === "1") {
  const input = require("readline").createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (Buffer.byteLength(line) > 8 * 1024 * 1024) return;
    try {
      const uri = JSON.parse(line)?.uri;
      if (typeof uri !== "string") return;
      const url = new URL(uri);
      if (url.protocol !== "cabinet:" || url.hostname !== "new") return;
      pendingDeepLinks.push(uri);
      console.log("launcher: received cabinet deep link");
      if (pendingDeepLinks.length > 16) pendingDeepLinks.shift();
      flushDeepLinks();
    } catch {}
  });
}

// Packaged app has no terminal to surface errors in — put up a real dialog so
// "no window appeared" isn't a silent mystery. Detached so it outlives us.
function showFatalDialog(message) {
  if (process.platform !== "darwin") return;
  try {
    const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    spawn("osascript", [
      "-e",
      `display dialog "${esc(message)}" with title "Cabinet" buttons {"OK"} default button "OK" with icon stop`,
    ], { detached: true, stdio: "ignore" }).unref();
  } catch {}
}

async function launchBrowser(daemonOrigin, token) {
  const deadline = Date.now() + 45_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${daemonOrigin}/browser/launch`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        browserConfirmed = true;
        flushDeepLinks();
        return;
      }
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  const detail = lastError?.message || String(lastError);
  console.warn("launcher: browser launch did not confirm:", detail);
  showFatalDialog(
    `Cabinet could not open its browser window (${detail}). The app has quit — relaunch it to try again.\n\nLog: ${logFile || "unknown"}`,
  );
  cleanupBackends();
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

function cleanupBackends() {
  backendsQuitting = true;
  for (const child of backendChildren) {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
  backendChildren = [];
}

function installSignalHandlers() {
  const quit = () => {
    cleanupBackends();
    process.exit(0);
  };
  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
}

async function restartBackends() {
  const children = [...backendChildren];
  cleanupBackends();
  await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => reject(new Error("Backend did not exit for restart")), 45000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  })));
  backendsQuitting = false;
  browserConfirmed = false;
  await startBackends();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function startBackends() {
  ensureManagedData();

  const externalModulesDir = extractNativeModules();
  const ocrHelperDir = extractOcrHelper();
  const [appPort, daemonPort] = await Promise.all([
    getStableAppPort(),
    getFreePort(),
  ]);
  const appOrigin = `http://127.0.0.1:${appPort}`;
  appOriginForLinks = appOrigin;
  browserExecutableForLinks = process.env.CABINET_CHROMIUM_PATH?.trim() || chromiumBinaryPath;
  const daemonOrigin = `http://127.0.0.1:${daemonPort}`;
  const daemonWsOrigin = `ws://127.0.0.1:${daemonPort}`;

  const env = {
    ...process.env,
    NODE_ENV: "production",
    PORT: String(appPort),
    CABINET_RUNTIME: "chromium",
    CABINET_INSTALL_KIND: "chromium-macos",
    CABINET_DATA_DIR: managedDataDir,
    CABINET_USER_DATA: userDataDir,
    CABINET_APP_PORT: String(appPort),
    CABINET_DAEMON_PORT: String(daemonPort),
    CABINET_APP_ORIGIN: appOrigin,
    CABINET_DAEMON_URL: daemonOrigin,
    CABINET_PUBLIC_DAEMON_ORIGIN: daemonWsOrigin,
    // Host mode: the daemon spawns the bundled Chromium fork, which hosts the
    // shell UI in-window. The binary sits next to this launcher in the bundle.
    CABINET_BROWSER_HOST_MODE: "1",
    // Env override wins so a bare `node launcher/cabinet-launcher.cjs` run can
    // point at a dev build; inside the bundle the binary sits next to us.
    CABINET_CHROMIUM_PATH:
      process.env.CABINET_CHROMIUM_PATH?.trim() || chromiumBinaryPath,
    // The app exists only while the browser window does: when the user quits
    // Chromium, the daemon shuts down (and its exit unwinds us below).
    CABINET_EXIT_ON_BROWSER_QUIT: "1",
  };

  const serverEntry = packagedStandalonePath("server.js");
  const daemonEntry = packagedStandalonePath("server", "cabinet-daemon.cjs");
  const daemonEnv = {
    ...env,
    NODE_PATH: [externalModulesDir, env.NODE_PATH].filter(Boolean).join(path.delimiter),
    CABINET_DOC_WORKER_ENTRY: packagedStandalonePath("server", "document-worker.mjs"),
    CABINET_DOC_RESOURCES_DIR: packagedStandalonePath("documents"),
    ...(ocrHelperDir ? { CABINET_OCR_HELPER_DIR: ocrHelperDir } : {}),
  };

  backendsQuitting = false;
  spawnNodeBackend([serverEntry], env, { name: "app" });
  spawnNodeBackend([daemonEntry], daemonEnv, { name: "daemon" });

  await waitForHealth(`${appOrigin}/api/health`);

  // Shell must be serving before the fork loads --cabinet-ui-url.
  const token = ensureDaemonToken();
  void launchBrowser(daemonOrigin, token);

  console.log(`launcher: Cabinet up at ${appOrigin} (daemon ${daemonOrigin})`);
}

async function main() {
  if (!acquireSingleInstance()) return;
  installSignalHandlers();
  await startBackends();
}

main().catch((err) => {
  const detail = err instanceof Error ? err.message : String(err);
  console.error("launcher: fatal startup error:", detail);
  showFatalDialog(
    `Cabinet failed to start (${detail}).\n\nLog: ${logFile || "unknown"}`,
  );
  cleanupBackends();
  process.exit(1);
});
