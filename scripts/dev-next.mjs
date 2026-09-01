import fs from "fs";
import net from "net";
import path from "path";
import { spawn } from "child_process";
import {
  createDataDirChangeDetector,
  readConfiguredDataDir,
} from "./stale-process-watch.mjs";

const PROJECT_ROOT = process.cwd();

// Mirror dev-daemon.mjs: load .env at startup so the spawned Next.js
// process sees KB_PASSWORD / CABINET_APP_ORIGIN etc. without requiring
// the user to export them on every shell session.
function loadDotEnv(envPath) {
  try {
    const raw = fs.readFileSync(envPath, "utf8");
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = value;
    }
  } catch {}
}
loadDotEnv(path.join(PROJECT_ROOT, ".env"));

function parsePort(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getManagedDataDir() {
  return readConfiguredDataDir(PROJECT_ROOT);
}

function getRuntimePortsPath(dataDir = getManagedDataDir()) {
  return path.join(dataDir, ".cabinet-state", "runtime-ports.json");
}

function readRuntimePorts(dataDir) {
  try {
    return JSON.parse(fs.readFileSync(getRuntimePortsPath(dataDir), "utf8"));
  } catch {
    return {};
  }
}

function writeRuntimePorts(nextState, dataDir) {
  const filePath = getRuntimePortsPath(dataDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");
}

function updateRuntimeService(service, payload, dataDir) {
  const current = readRuntimePorts(dataDir);
  writeRuntimePorts({
    ...current,
    [service]: payload,
  }, dataDir);
}

function clearRuntimeService(service, pid, dataDir) {
  const current = readRuntimePorts(dataDir);
  const entry = current?.[service];
  if (!entry || (entry.pid && pid && entry.pid !== pid)) {
    return;
  }
  writeRuntimePorts({
    ...current,
    [service]: undefined,
  }, dataDir);
}

function getNextDevLockPath() {
  return path.join(PROJECT_ROOT, ".next", "dev", "lock");
}

function readNextDevLock() {
  try {
    const raw = fs.readFileSync(getNextDevLockPath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function originResponds(origin) {
  const normalized = String(origin || "").replace(/\/+$/, "");
  if (!normalized) return false;
  try {
    const response = await fetch(`${normalized}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok;
  } catch {
    try {
      const response = await fetch(`${normalized}/`, {
        method: "HEAD",
        signal: AbortSignal.timeout(1500),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}

async function maybeReuseExistingNextDevServer() {
  const lock = readNextDevLock();
  if (!lock?.pid || !lock?.port) return null;

  if (!isProcessAlive(lock.pid)) {
    fs.rmSync(getNextDevLockPath(), { force: true });
    return null;
  }

  const lockOrigin = typeof lock.appUrl === "string" && lock.appUrl.trim()
    ? lock.appUrl.replace(/\/+$/, "")
    : `http://127.0.0.1:${lock.port}`;
  const preferredOrigin = `http://127.0.0.1:${lock.port}`;

  if (await originResponds(lockOrigin) || await originResponds(preferredOrigin)) {
    return {
      pid: lock.pid,
      port: lock.port,
      origin: preferredOrigin,
    };
  }

  return null;
}

function isPortFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen({ port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 200; port += 1) {
    if (await isPortFree(port)) {
      return port;
    }
  }

  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen({ port: 0 }, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address && "port" in address
          ? address.port
          : startPort;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function main() {
  const existingServer = await maybeReuseExistingNextDevServer();
  if (existingServer) {
    updateRuntimeService("app", {
      port: existingServer.port,
      origin: existingServer.origin,
      pid: existingServer.pid,
      updatedAt: new Date().toISOString(),
    });
    console.log(
      `[cabinet] Reusing existing Next dev server at ${existingServer.origin}.`
    );
    return;
  }

  const preferredPort = parsePort(
    process.env.CABINET_APP_PORT || process.env.PORT,
    4000
  );
  const port = await findAvailablePort(preferredPort);
  const origin = `http://127.0.0.1:${port}`;

  if (port !== preferredPort) {
    console.log(
      `[cabinet] App port ${preferredPort} is busy, using ${port} instead.`
    );
  }

  const nextBin = path.join(
    PROJECT_ROOT,
    "node_modules",
    "next",
    "dist",
    "bin",
    "next"
  );
  let ownedChild;
  let ownedDataDir = getManagedDataDir();
  let restarting = false;
  let stopping = false;

  const spawnOwnedChild = () => {
    updateRuntimeService("app", {
      port,
      origin,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    }, ownedDataDir);

    ownedChild = spawn(
      process.execPath,
      [nextBin, "dev", "-p", String(port), ...process.argv.slice(2)],
      {
        cwd: PROJECT_ROOT,
        stdio: "inherit",
        env: {
          // Audit #107: telemetry off by default in dev. Explicit user opt-in
          // via CABINET_TELEMETRY_DISABLED=0 is honored (process.env spread
          // happens after the default).
          CABINET_TELEMETRY_DISABLED: "1",
          // Default CABINET_APP_ORIGIN to loopback, but let process.env spread
          // below override when an operator pinned a public hostname so
          // next.config.ts can auto-allow it through Next 15's dev origin guard.
          CABINET_APP_ORIGIN: origin,
          ...process.env,
          PORT: String(port),
          CABINET_APP_PORT: String(port),
        },
      }
    );

    ownedChild.on("exit", (code, signal) => {
      if (restarting && !stopping) {
        restarting = false;
        spawnOwnedChild();
        return;
      }
      clearRuntimeService("app", process.pid, ownedDataDir);
      if (!stopping && signal) {
        process.kill(process.pid, signal);
        return;
      }
      process.exit(code ?? 0);
    });
  };

  const detectDataDirChange = createDataDirChangeDetector(
    ownedDataDir,
    (nextDataDir, previousDataDir) => {
      clearRuntimeService("app", process.pid, previousDataDir);
      ownedDataDir = nextDataDir;
      if (!ownedChild || ownedChild.exitCode !== null || restarting) return;
      restarting = true;
      console.log(`[cabinet] Data directory changed; restarting Next dev server.`);
      ownedChild.kill("SIGTERM");
    }
  );
  const watcher = setInterval(() => {
    detectDataDirChange(getManagedDataDir());
  }, 500);

  const cleanup = () => {
    clearInterval(watcher);
    clearRuntimeService("app", process.pid, ownedDataDir);
  };
  const stop = (signal) => {
    stopping = true;
    clearInterval(watcher);
    ownedChild?.kill(signal);
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  spawnOwnedChild();
}

main().catch((error) => {
  console.error("[cabinet] Failed to start Next dev server:", error);
  process.exit(1);
});
