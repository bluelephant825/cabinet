#!/usr/bin/env node
/**
 * Smoke-test the macOS Electron artifact the way a user receives it:
 * mount the DMG, launch Cabinet.app from the mounted volume, and verify both
 * the embedded Next.js server and daemon through their public health routes.
 *
 * Usage:
 *   node scripts/test-electron-macos-package.mjs [path/to/Cabinet.dmg]
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

if (process.platform !== "darwin") {
  console.error("This smoke test must run on macOS.");
  process.exit(1);
}

const root = process.cwd();
const runnerTemp = process.env.RUNNER_TEMP || os.tmpdir();
const workDir = fs.mkdtempSync(path.join(runnerTemp, "cabinet-electron-smoke-"));
const mountDir = path.join(workDir, "dmg");
const dataDir = path.join(workDir, "cabinet-data");
const processLogPath = path.join(workDir, "electron-process.log");
const exportedLogDir = process.env.CABINET_ELECTRON_SMOKE_LOG_DIR?.trim();
const userDataDir = path.join(os.homedir(), "Library", "Application Support", "Cabinet");
const configPath = path.join(userDataDir, "cabinet-config.json");

let appProcess;
let appSpawnError;
let mounted = false;
let originalConfig;
let configExisted = false;
let configTouched = false;

function findFirstFile(directory, predicate) {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && predicate(entryPath)) return entryPath;
    if (entry.isDirectory()) {
      const match = findFirstFile(entryPath, predicate);
      if (match) return match;
    }
  }
  return null;
}

function findAppBundle(directory) {
  if (!fs.existsSync(directory)) return null;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === "Cabinet.app") return entryPath;
    if (entry.isDirectory()) {
      const match = findAppBundle(entryPath);
      if (match) return match;
    }
  }
  return null;
}

function spawnSyncSafe(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "ignore" });
  return r.status ?? -1;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") resolve(address.port);
        else reject(new Error("Could not allocate a loopback port"));
      });
    });
    server.on("error", reject);
  });
}

async function waitForHealthyJson(url, timeoutMs) {
  const startedAt = Date.now();
  let lastError = "no response";
  while (Date.now() - startedAt < timeoutMs) {
    if (appSpawnError) throw appSpawnError;
    if (appProcess && (appProcess.exitCode !== null || appProcess.signalCode !== null)) {
      throw new Error(
        `Cabinet exited before becoming healthy (code ${appProcess.exitCode}, signal ${appProcess.signalCode})`
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      const body = await response.text();
      if (response.ok) {
        const parsed = JSON.parse(body);
        if (parsed.status === "ok") return parsed;
        lastError = `unexpected status payload: ${body}`;
      } else {
        lastError = `HTTP ${response.status}: ${body}`;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${url}: ${lastError}`);
}

function exportDiagnostics() {
  if (!exportedLogDir) return;
  fs.mkdirSync(exportedLogDir, { recursive: true });
  if (fs.existsSync(processLogPath)) {
    fs.copyFileSync(processLogPath, path.join(exportedLogDir, "electron-process.log"));
  }
  const cabinetLogs = path.join(dataDir, ".cabinet-state", "logs");
  if (fs.existsSync(cabinetLogs)) {
    fs.cpSync(cabinetLogs, path.join(exportedLogDir, "cabinet-logs"), {
      recursive: true,
      force: true,
    });
  }
}

async function stopApp() {
  if (!appProcess || appProcess.exitCode !== null || appProcess.signalCode !== null) return;
  appProcess.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => appProcess.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  if (appProcess.exitCode === null && appProcess.signalCode === null) appProcess.kill("SIGKILL");
}

async function cleanup() {
  await stopApp();
  exportDiagnostics();
  if (mounted) {
    try {
      execFileSync("hdiutil", ["detach", mountDir, "-force"], { stdio: "ignore" });
    } catch {}
  }
  if (configTouched) {
    try {
      if (configExisted) fs.writeFileSync(configPath, originalConfig);
      else fs.rmSync(configPath, { force: true });
    } catch {}
  }
  fs.rmSync(workDir, { recursive: true, force: true });
}

const argPath = process.argv[2] ? path.resolve(process.argv[2]) : null;
const dmgPath = argPath?.endsWith(".dmg")
  ? argPath
  : findFirstFile(path.join(root, "out", "make"), (candidate) => candidate.endsWith(".dmg"));
// `electron:package` (no DMG) leaves the signed-adhoc bundle in out/ — accept it.
const appArg =
  argPath && argPath.endsWith(".app")
    ? argPath
    : findAppBundle(path.join(root, "out")) ??
      findFirstFile(path.join(root, "out"), (c) => c.endsWith("Cabinet.app"));

if ((!dmgPath || !fs.existsSync(dmgPath)) && (!appArg || !fs.existsSync(appArg))) {
  console.error("No Electron DMG or Cabinet.app found. Run `npm run electron:package` or `electron:make` first.");
  process.exit(1);
}

try {
  fs.mkdirSync(mountDir, { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(userDataDir, { recursive: true });

  configExisted = fs.existsSync(configPath);
  if (configExisted) originalConfig = fs.readFileSync(configPath);
  configTouched = true;

  const appPort = await getFreePort();
  fs.writeFileSync(configPath, JSON.stringify({ appPort, dataDir }, null, 2));

  let appPath;
  if (appArg && (!dmgPath || !fs.existsSync(dmgPath))) {
    // Non-ASCII + spaced install path: copy the bundle there and launch from
    // it so path resolution bugs (é ü space) surface here, not on a user Mac.
    const installDir = path.join(workDir, "install é ü dir");
    fs.mkdirSync(installDir, { recursive: true });
    appPath = path.join(installDir, "Cabinet.app");
    console.log(`Copying bundle to non-ASCII path: ${installDir}`);
    // ditto preserves framework symlinks; fs.cpSync dereferences them, which
    // breaks codesign --deep verification ("unsealed contents").
    execFileSync("ditto", [appArg, appPath]);
  } else {
    console.log(`Mounting ${dmgPath}`);
    execFileSync("hdiutil", ["attach", dmgPath, "-nobrowse", "-readonly", "-mountpoint", mountDir], {
      stdio: "inherit",
    });
    mounted = true;
    appPath = findAppBundle(mountDir);
    if (!appPath) throw new Error("Mounted DMG does not contain Cabinet.app");
  }

  // Unsigned/adhoc builds fail --strict verification; only verify a real signature.
  const sig = spawnSyncSafe("codesign", ["-dv", appPath]);
  if (sig === 0) {
    execFileSync("codesign", ["--verify", "--deep", "--verbose=2", appPath], { stdio: "inherit" });
  } else {
    console.log("App bundle is unsigned — skipping codesign verification.");
  }

  const executable = path.join(appPath, "Contents", "MacOS", "Cabinet");
  if (!fs.existsSync(executable)) throw new Error(`Missing packaged executable: ${executable}`);

  const logFd = fs.openSync(processLogPath, "a");
  const appEnv = { ...process.env, CABINET_TELEMETRY_DISABLED: "1" };
  // Dev shells (e.g. running inside Electron-based tooling) may export
  // ELECTRON_RUN_AS_NODE=1, which would make the binary exit as plain Node.
  delete appEnv.ELECTRON_RUN_AS_NODE;
  appProcess = spawn(executable, [], {
    env: appEnv,
    stdio: ["ignore", logFd, logFd],
  });
  appProcess.once("error", (error) => {
    appSpawnError = error;
  });
  fs.closeSync(logFd);

  const appOrigin = `http://127.0.0.1:${appPort}`;
  console.log(`Waiting for packaged app health at ${appOrigin}`);
  const appHealth = await waitForHealthyJson(`${appOrigin}/api/health`, 90_000);
  console.log(`App healthy: ${JSON.stringify(appHealth)}`);

  const daemonHealth = await waitForHealthyJson(`${appOrigin}/api/health/daemon`, 30_000);
  console.log(`Daemon healthy: ${JSON.stringify(daemonHealth)}`);

  // Documents smoke: the daemon must answer document routes through the app
  // proxy (proves the worker entry + resource tree resolve inside the bundle).
  const ocrRes = await fetch(`${appOrigin}/api/documents/ocr/capabilities`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!ocrRes.ok) throw new Error(`GET /api/documents/ocr/capabilities → ${ocrRes.status}`);
  console.log(`OCR capabilities: ${(await ocrRes.text()).slice(0, 200)}`);

  // The staged agent helper must execute under the bundled Node runtime.
  const toolPath = path.join(
    appPath, "Contents", "Resources", "app.asar.unpacked",
    ".next", "standalone", "server", "document-tool.mjs"
  );
  const nodePath = path.join(
    appPath, "Contents", "Resources", "app.asar.unpacked",
    ".next", "standalone", "bin", "node"
  );
  if (!fs.existsSync(toolPath)) throw new Error(`document-tool.mjs not staged: ${toolPath}`);
  const helpRun = spawnSync(fs.existsSync(nodePath) ? nodePath : process.execPath,
    [toolPath, "--help"], { encoding: "utf8", timeout: 30_000 });
  if (helpRun.status !== 0 || !helpRun.stdout.includes("cabinet-documents")) {
    throw new Error(`document-tool.mjs --help failed: ${helpRun.stderr || helpRun.stdout}`);
  }
  console.log("document-tool.mjs --help ok under the bundled node");

  // The cabinet-browser helper is staged beside it.
  const browserToolPath = path.join(
    appPath, "Contents", "Resources", "app.asar.unpacked",
    ".next", "standalone", "server", "browser-tool.mjs"
  );
  if (!fs.existsSync(browserToolPath)) throw new Error(`browser-tool.mjs not staged: ${browserToolPath}`);
  const browserHelp = spawnSync(fs.existsSync(nodePath) ? nodePath : process.execPath,
    [browserToolPath, "--help"], { encoding: "utf8", timeout: 30_000 });
  if (browserHelp.status !== 0 || !browserHelp.stdout.includes("cabinet-browser")) {
    throw new Error(`browser-tool.mjs --help failed: ${browserHelp.stderr || browserHelp.stdout}`);
  }
  console.log("browser-tool.mjs --help ok under the bundled node");

  // Staged document assets must be present in the bundle.
  const standaloneRoot = path.join(
    appPath, "Contents", "Resources", "app.asar.unpacked", ".next", "standalone"
  );
  for (const rel of [
    path.join("server", "document-worker.mjs"),
    path.join("documents", "pdf-fonts", "LiberationSans-Regular.ttf"),
    path.join("node_modules", "takumi-pdf", "pkg", "takumi_pdf_wasm_bg.wasm"),
    path.join("node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm"),
    path.join("node_modules", "harfbuzzjs", "hb-subset.wasm"),
    "THIRD_PARTY_NOTICES.md",
  ]) {
    if (!fs.existsSync(path.join(standaloneRoot, rel))) {
      throw new Error(`missing document asset in bundle: ${rel}`);
    }
  }
  console.log("document assets present in the packaged bundle");

  const page = await fetch(`${appOrigin}/`, { signal: AbortSignal.timeout(5_000) });
  if (!page.ok || !(await page.text()).includes("<!DOCTYPE html")) {
    throw new Error("Packaged app did not serve its HTML shell");
  }

  console.log("macOS Electron DMG smoke test passed");
} catch (error) {
  console.error(error instanceof Error ? error.stack : error);
  if (fs.existsSync(processLogPath)) {
    console.error("--- electron process log ---");
    console.error(fs.readFileSync(processLogPath, "utf8").slice(-8_000));
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}
