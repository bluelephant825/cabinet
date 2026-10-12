"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");

const HOST_NAME = "ai.cabinet.clipper";
const EXTENSION_ORIGIN = "chrome-extension://bbddlgefpahcbpcaikiacdpghikifabf/";
const MAX_REQUEST_BYTES = 8192;

function encodeNativeMessage(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function readNativeMessage(input) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      input.off("error", onError);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const onError = () => fail(new Error("Native input failed."));
    const onEnd = () => fail(new Error("Truncated native message."));
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32LE(0);
      if (length === 0 || length > MAX_REQUEST_BYTES || buffer.length > length + 4) {
        fail(new Error("Invalid native message length."));
        return;
      }
      if (buffer.length < length + 4) return;
      try {
        const message = JSON.parse(buffer.subarray(4).toString("utf8"));
        cleanup();
        input.pause();
        resolve(message);
      } catch {
        fail(new Error("Invalid native JSON."));
      }
    };
    input.on("data", onData);
    input.on("end", onEnd);
    input.on("error", onError);
  });
}

async function atomicWrite(file, content, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, content, { mode, flag: "wx" });
  await fs.rename(temporary, file);
}

async function registerNativeHost({ userDataDir, nodePath, hostScript, launcherPath, homeDir = os.homedir(), platform = process.platform }) {
  if (!path.isAbsolute(nodePath) || !path.isAbsolute(hostScript) || !path.isAbsolute(launcherPath)) {
    throw new Error("Native host executable paths must be absolute.");
  }
  if (platform !== "darwin" && platform !== "linux") return [];
  const hostDir = path.join(userDataDir, "ClipperBridge");
  const executable = path.join(hostDir, HOST_NAME);
  const quote = (value) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const command = [nodePath, hostScript, "--user-data-dir", userDataDir, "--launcher", launcherPath].map(quote).join(" ");
  await atomicWrite(executable, `#!/bin/sh\nexec ${command} "$@"\n`, 0o700);
  const directories = platform === "darwin"
    ? ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium"].map(name => path.join(homeDir, "Library/Application Support", name, "NativeMessagingHosts"))
    : ["google-chrome", "google-chrome-beta", "google-chrome-unstable", "chromium"].map(name => path.join(homeDir, ".config", name, "NativeMessagingHosts"));
  directories.push(path.join(userDataDir, "Browser/Profile/NativeMessagingHosts"));
  const manifest = JSON.stringify({ name: HOST_NAME, description: "Discover the active local Cabinet API", path: executable, type: "stdio", allowed_origins: [EXTENSION_ORIGIN] }, null, 2);
  const files = directories.map(dir => path.join(dir, `${HOST_NAME}.json`));
  for (const file of files) await atomicWrite(file, `${manifest}\n`);
  return files;
}

async function discoverCabinet({ userDataDir, launcherPath, fetchImpl = fetch, launch, deadlineMs = 30000, pollMs = 250 }) {
  const deadline = Date.now() + deadlineMs;
  let launched = false;
  do {
    try {
      const config = JSON.parse(await fs.readFile(path.join(userDataDir, "cabinet-config.json"), "utf8"));
      const port = config.appPort;
      if (Number.isInteger(port) && port > 0 && port < 65536) {
        const apiUrl = `http://127.0.0.1:${port}`;
        const remaining = Math.max(1, deadline - Date.now());
        const response = await fetchImpl(`${apiUrl}/api/health`, { redirect: "error", signal: AbortSignal.timeout(Math.min(1000, remaining)) });
        const health = response.ok ? await response.json() : null;
        if (health?.status === "ok" && typeof health.dataDir === "string" && typeof health.installKind === "string" && health.stale !== true) {
          return { success: true, version: 1, apiUrl };
        }
      }
    } catch {}
    if (!launched) {
      launched = true;
      if (launch) {
        await launch();
      } else if (launcherPath && path.isAbsolute(launcherPath)) {
        const child = spawn(launcherPath, [], { detached: true, stdio: "ignore", env: { ...process.env, CABINET_USER_DATA: userDataDir } });
        child.on("error", () => {});
        child.unref();
      } else {
        break;
      }
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
  return { success: false, error: "Cabinet did not become available. Start Cabinet and try again." };
}

async function handleNativeRequest(message, options) {
  if (!message || message.action !== "discover" || message.version !== 1) {
    return { success: false, error: "Unsupported native bridge request." };
  }
  return discoverCabinet(options);
}

async function main() {
  const args = process.argv.slice(2);
  const userDataDir = args[args.indexOf("--user-data-dir") + 1];
  const launcherPath = args[args.indexOf("--launcher") + 1];
  let response;
  try {
    if (!args.includes(EXTENSION_ORIGIN) || !args.includes("--user-data-dir") || !path.isAbsolute(userDataDir)) {
      throw new Error("Unauthorized native caller.");
    }
    response = await handleNativeRequest(await readNativeMessage(process.stdin), { userDataDir, launcherPath });
  } catch {
    response = { success: false, error: "Invalid native bridge request." };
  }
  process.stdout.write(encodeNativeMessage(response), () => process.exit(0));
}

module.exports = { HOST_NAME, EXTENSION_ORIGIN, registerNativeHost, discoverCabinet, encodeNativeMessage, readNativeMessage, handleNativeRequest };

if (require.main === module) void main();
