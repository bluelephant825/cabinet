/**
 * ChromiumManager owns the Cabinet Browser sidecar: a pinned Chrome for
 * Testing binary downloaded into app data, launched with a persistent profile
 * and --remote-debugging-pipe, and driven through CDPClient/BrowserSession.
 *
 * Status machine:
 *   missing    no binary on disk and no download in flight
 *   downloading CfT install running
 *   stopped    binary present, no process
 *   starting   spawn in flight / CDP handshake
 *   running    process up, CDP pipe live
 *   error      last operation failed (message in `lastError`)
 *
 * ensureRunning() is the single entry point — it downloads if needed, launches,
 * and concurrent callers share the one in-flight promise. An unexpected child
 * exit relaunches at most once within 60 s (crash-loop guard); after that the
 * browser stays stopped until the next ensureRunning.
 *
 * Host mode (CABINET_BROWSER_HOST_MODE=1/true, or browser.hostMode in
 * cabinet-config.json): the Cabinet Chromium fork renders the shell UI inside
 * its own window and positions tab content in-window, so launch passes
 * --cabinet-ui-url=<app origin> and callers skip the floating-window bounds
 * sync / OS-level hide-unhide entirely.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { Browser, computeExecutablePath, install } from "@puppeteer/browsers";
import { CDPClient } from "./cdp-client";
import { BrowserSession, type BrowserSessionOptions } from "./browser-session";
import { BrowserError, type BrowserStatus } from "./types";
import {
  browserBinDir,
  browserProfileDir,
  browserStatePath,
  cabinetConfigPath,
} from "./paths";
import {
  ensureHostExtensionFiles,
  installHostExtension,
  isHostExtensionEnabled,
} from "./host-extension";
import { getAppOrigin } from "../../src/lib/runtime/runtime-config";

export const PINNED_CHROME_BUILD = "153.0.8010.47";

export type DownloadProgress = { downloadedBytes: number; totalBytes: number };

export type PersistedBrowserState = {
  tabs?: string[];
  activeTab?: string;
  bounds?: { x?: number; y?: number; width?: number; height?: number };
};

export type ChromiumManagerEvents = {
  status: (status: BrowserStatus) => void;
  "download-progress": (progress: DownloadProgress) => void;
  /** Emitted when the Chromium child exits; `clean` means the user quit it
   *  from the browser UI (not a crash, not a daemon-initiated stop). */
  "browser-exit": (info: {
    code: number | null;
    signal: NodeJS.Signals | null;
    clean: boolean;
  }) => void;
};

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function readOverridePath(): string | null {
  const envPath = process.env.CABINET_CHROMIUM_PATH?.trim();
  if (envPath && fs.existsSync(envPath)) return envPath;
  const configPath = cabinetConfigPath();
  if (configPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        browser?: { chromiumPath?: unknown };
      };
      const fromConfig = parsed?.browser?.chromiumPath;
      if (typeof fromConfig === "string" && fromConfig.trim() && fs.existsSync(fromConfig.trim())) {
        return fromConfig.trim();
      }
    } catch {
      // missing/invalid config is fine
    }
  }
  return null;
}

/** Host mode: the Cabinet Chromium fork hosts the shell UI inside its own
 *  window and lays tab content out in-window. On when the
 *  CABINET_BROWSER_HOST_MODE env var is "1"/"true" or `browser.hostMode` is
 *  true in cabinet-config.json (same parse-and-ignore-errors pattern as
 *  readOverridePath). */
function readHostMode(): boolean {
  const env = process.env.CABINET_BROWSER_HOST_MODE?.trim().toLowerCase();
  if (env === "1" || env === "true") return true;
  const configPath = cabinetConfigPath();
  if (configPath) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        browser?: { hostMode?: unknown };
      };
      if (parsed?.browser?.hostMode === true) return true;
    } catch {
      // missing/invalid config is fine
    }
  }
  return false;
}

/** Origin the fork loads the Cabinet shell UI from in host mode. Resolves
 *  env-first but also consults runtime-ports.json, which matters when the app
 *  port was assigned dynamically. */
function cabinetAppOrigin(): string {
  return getAppOrigin();
}

export type BuildArgsInput = {
  /** Chromium user-data-dir. */
  profileDir: string;
  /** Last persisted tab set + window bounds (relaunch restore). */
  persisted: PersistedBrowserState;
  initialUrl: string | null;
  /** Emit --cabinet-ui-url so the fork hosts the shell UI in-window. */
  hostMode: boolean;
};

/** Chromium launch args as a pure function so tests can assert flag emission
 *  without spawning a browser. In host mode the shell UI URL rides along as
 *  --cabinet-ui-url — a flag, not a tab — grouped with the other switches
 *  before the positional tab-restore URLs. */
export function buildChromiumArgs(input: BuildArgsInput): string[] {
  const bounds = input.persisted.bounds ?? {};
  const width = Number.isFinite(bounds.width) && (bounds.width ?? 0) > 0 ? Math.round(bounds.width!) : 1200;
  const height = Number.isFinite(bounds.height) && (bounds.height ?? 0) > 0 ? Math.round(bounds.height!) : 800;
  const args = [
    `--user-data-dir=${input.profileDir}`,
    "--remote-debugging-pipe",
    "--enable-unsafe-extension-debugging",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--disable-features=Translate,MediaRouter",
    "--disable-sync",
    "--disable-background-networking",
    `--window-size=${width},${height}`,
  ];
  // Dev escape hatch: CABINET_BROWSER_DEBUG_PORT adds a TCP debugging
  // endpoint alongside the CDP pipe so tooling can inspect the shell target
  // (browser_ui), which the daemon's own session intentionally filters out.
  const debugPort = Number.parseInt(
    process.env.CABINET_BROWSER_DEBUG_PORT ?? "",
    10,
  );
  if (Number.isFinite(debugPort) && debugPort > 0) {
    args.push(`--remote-debugging-port=${debugPort}`);
  }
  if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
    args.push(`--window-position=${Math.round(bounds.x!)},${Math.round(bounds.y!)}`);
  }
  if (input.hostMode) {
    args.push(`--cabinet-ui-url=${cabinetAppOrigin()}`);
  }
  if (input.initialUrl) {
    args.push(input.initialUrl);
  } else {
    // No explicit target: reopen the persisted tab set so a relaunch
    // (daemon restart, crash, user quit) restores the previous session.
    const seen = new Set<string>();
    const restore: string[] = [];
    for (const entry of input.persisted.tabs ?? []) {
      if (typeof entry !== "string") continue;
      // Extension pages (welcome/onboarding, options, the host panel) are
      // ephemeral browser UI — never worth reopening on launch.
      if (!/^https?:/.test(entry)) continue;
      if (seen.has(entry) || restore.length >= 20) continue;
      seen.add(entry);
      restore.push(entry);
    }
    args.push(...(restore.length > 0 ? restore : ["about:blank"]));
  }
  return args;
}

/** Read CFBundleIdentifier from `<App>.app/Contents/Info.plist` next to an
 *  executable (exe = App.app/Contents/MacOS/bin). Null for plain binaries. */
function readBundleId(executable: string): string | null {
  try {
    const plist = fs.readFileSync(join(executable, "..", "..", "Info.plist"), "utf8");
    const match = plist.match(/<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

export class ChromiumManager extends EventEmitter {
  status: BrowserStatus = "missing";
  lastError: string | null = null;
  downloadProgress: DownloadProgress | null = null;
  executablePath: string | null = null;

  private child: ChildProcess | null = null;
  private cdp: CDPClient | null = null;
  private session: BrowserSession | null = null;
  private bundleId: string | null = null;
  private hostExtensionId: string | null = null;
  private inFlight: Promise<BrowserSession> | null = null;
  private relaunchedAt = 0;
  private stopping = false;
  private onLaunched:
    | ((session: BrowserSession) => Promise<void> | void)
    | null = null;

  constructor(private readonly options: BrowserSessionOptions = {}) {
    super();
    this.refreshMissingState();
  }

  /** Called right after each launch (used by ExtensionManager.applyAll). */
  setLaunchHook(
    hook: (session: BrowserSession) => Promise<void> | void,
  ): void {
    this.onLaunched = hook;
  }

  get browserSession(): BrowserSession | null {
    return this.session;
  }

  get cdpClient(): CDPClient | null {
    return this.cdp;
  }

  /** OS pid + macOS bundle id of the running Chromium, for the Electron
   *  shell's visibility IPC (daemon-issued Apple Events get dropped). */
  get childPid(): number | null {
    return this.child?.pid ?? null;
  }

  get chromiumBundleId(): string | null {
    return this.bundleId;
  }

  /** True when the next launch should run the fork in host mode (its own
   *  window hosts the Cabinet shell UI; tab content is laid out in-window).
   *  Re-read each call so a config/env change is picked up by the next
   *  ensureRunning() without a daemon restart. */
  get hostMode(): boolean {
    return readHostMode();
  }

  /** P1 host extension state for /browser/status: enabled via env/config,
   *  id once loaded into the running browser. */
  get hostExtension(): { enabled: boolean; id: string | null } {
    return {
      enabled: isHostExtensionEnabled(),
      id: this.hostExtensionId,
    };
  }

  /** Unhide + raise the Chromium process (focusWindow / bounds visible:true).
   *  `open -b` goes through LaunchServices: it unhides and activates without
   *  the Automation permission that Apple Events would require (TCC silently
   *  denies `set visible true`/`activate` issued by the daemon). */
  async activateApp(): Promise<void> {
    if (process.platform !== "darwin") return;
    if (this.status !== "running") return;
    if (!this.child?.pid || !this.bundleId) return;
    await new Promise<void>((resolve) => {
      execFile("open", ["-b", this.bundleId!], { timeout: 4000 }, (err, _stdout, stderr) => {
        if (err) console.warn(`[browser] activateApp failed: ${stderr || err.message}`);
        resolve();
      });
    });
  }

  /** Hide the Chromium process. `set visible false` on another process is
   *  allowed without Automation consent (unhide is not, hence `open -b` for
   *  the reverse). The hide lands asynchronously — observed lag is ~1-3 s —
   *  so callers must not re-show immediately after hiding. Degrading on
   *  failure is intentional: a denied event leaves the window visible. */
  async setAppHidden(hidden: boolean): Promise<void> {
    if (process.platform !== "darwin") return;
    if (this.status !== "running") return;
    const pid = this.child?.pid;
    if (!pid) return;
    if (!hidden) {
      await this.activateApp();
      return;
    }
    const script = `tell application "System Events" to set visible of (first process whose unix id is ${pid}) to false`;
    await new Promise<void>((resolve) => {
      execFile("osascript", ["-e", script], { timeout: 4000 }, (err, _stdout, stderr) => {
        if (err) console.warn(`[browser] setAppHidden(${hidden}) failed: ${stderr || err.message}`);
        resolve();
      });
    });
    // Chromium briefly re-shows itself when CDP work races the hide (e.g. a
    // page calling window.focus on visibilitychange) — re-assert once.
    await new Promise((r) => setTimeout(r, 600));
    await new Promise<void>((resolve) => {
      execFile("osascript", ["-e", script], { timeout: 4000 }, () => resolve());
    });
  }

  private setStatus(status: BrowserStatus, error?: string | null): void {
    this.status = status;
    this.lastError = error === undefined ? this.lastError : error;
    if (status !== "error") this.lastError = error ?? null;
    this.emit("status", status);
  }

  private refreshMissingState(): void {
    const override = readOverridePath();
    if (override) {
      this.executablePath = override;
      this.status = "stopped";
      return;
    }
    try {
      this.executablePath = computeExecutablePath({
        browser: Browser.CHROME,
        buildId: PINNED_CHROME_BUILD,
        cacheDir: browserBinDir(),
      });
      this.status = fs.existsSync(this.executablePath) ? "stopped" : "missing";
    } catch {
      this.executablePath = null;
      this.status = "missing";
    }
  }

  /** True only when running AND the request came from loopback (or has no
   * Origin header at all — the local CLI/agent case). */
  isAvailable(requestOrigin: string | undefined | null): boolean {
    if (this.status !== "running" || !this.session) return false;
    if (!requestOrigin) return true;
    return isLoopbackOrigin(requestOrigin);
  }

  async download(): Promise<string> {
    const override = readOverridePath();
    if (override) {
      this.executablePath = override;
      if (this.status === "missing") this.setStatus("stopped");
      return override;
    }
    if (this.inFlight) {
      await this.inFlight.catch(() => {});
      this.refreshMissingState();
      if (this.executablePath && fs.existsSync(this.executablePath)) {
        return this.executablePath;
      }
    }
    this.setStatus("downloading", null);
    try {
      const result = await install({
        browser: Browser.CHROME,
        buildId: PINNED_CHROME_BUILD,
        cacheDir: browserBinDir(),
        downloadProgressCallback: (downloadedBytes: number, totalBytes: number) => {
          this.downloadProgress = { downloadedBytes, totalBytes };
          this.emit("download-progress", this.downloadProgress);
        },
      });
      this.executablePath = result.executablePath;
      this.downloadProgress = null;
      this.setStatus("stopped", null);
      return result.executablePath;
    } catch (err) {
      this.downloadProgress = null;
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", message);
      throw new BrowserError("download-failed", `Chromium download failed: ${message}`);
    }
  }

  private async resolveExecutable(): Promise<string> {
    const override = readOverridePath();
    if (override) return override;
    if (this.executablePath && fs.existsSync(this.executablePath)) {
      return this.executablePath;
    }
    return this.download();
  }

  private readPersistedState(): PersistedBrowserState {
    try {
      return JSON.parse(fs.readFileSync(browserStatePath(), "utf8")) as PersistedBrowserState;
    } catch {
      return {};
    }
  }

  private buildArgs(initialUrl: string | null): string[] {
    return buildChromiumArgs({
      profileDir: browserProfileDir(),
      persisted: this.readPersistedState(),
      initialUrl,
      hostMode: this.hostMode,
    });
  }

  private async launch(initialUrl: string | null): Promise<BrowserSession> {
    const executable = await this.resolveExecutable();
    this.setStatus("starting", null);
    const profileDir = browserProfileDir();
    await fsp.mkdir(profileDir, { recursive: true });
    // P1 host extension: regenerate before spawn so a profile-persisted copy
    // picks up a changed app origin at startup; loaded over CDP below.
    const hostExt = isHostExtensionEnabled()
      ? await ensureHostExtensionFiles({
          appOrigin: cabinetAppOrigin(),
          platform: process.platform,
        }).catch((err) => {
          console.warn(
            "[browser] host extension generation failed:",
            err instanceof Error ? err.message : err,
          );
          return null;
        })
      : null;
    // The daemon restores tabs itself via buildArgs(); clear Chrome's own
    // session-restore data or an unclean shutdown stacks its restored tabs on
    // top of ours (duplicates grow on every relaunch).
    for (const dir of ["Sessions", "Sessions_Encrypted"]) {
      const sessionsDir = join(profileDir, "Default", dir);
      for (const name of await fsp.readdir(sessionsDir).catch(() => [] as string[])) {
        await fsp.rm(join(sessionsDir, name), { force: true }).catch(() => {});
      }
    }

    const args = this.buildArgs(initialUrl);
    this.bundleId = readBundleId(executable);
    const child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) console.warn(`[browser] ${line.trimEnd()}`);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split("\n")) {
        if (line.trim()) console.warn(`[browser] ${line.trimEnd()}`);
      }
    });

    const out = child.stdio[3] as import("node:stream").Writable | null;
    const inp = child.stdio[4] as import("node:stream").Readable | null;
    if (!out || !inp) {
      child.kill("SIGKILL");
      this.setStatus("error", "remote-debugging-pipe fds missing");
      throw new BrowserError("launch-failed", "Chromium did not expose debugging pipes (fd 3/4)");
    }

    const cdp = new CDPClient(out, inp);
    this.cdp = cdp;
    const session = new BrowserSession(cdp, this.options);
    this.session = session;

    child.once("exit", (code, signal) => {
      this.child = null;
      cdp.close();
      this.session = null;
      this.cdp = null;
      this.hostExtensionId = null;
      const wasStopping = this.stopping;
      if (this.status === "running" || this.status === "starting") {
        this.setStatus("stopped", null);
      }
      // A clean exit (code 0, no signal) means the user quit Chromium from
      // its own UI — stay stopped; the next ensureRunning() relaunches.
      const abnormal = code !== 0 || signal != null;
      // Packaged host mode (CABINET_EXIT_ON_BROWSER_QUIT) lets the daemon's
      // supervisor shut the whole stack down when the user quits the browser.
      this.emit("browser-exit", {
        code,
        signal,
        clean: !abnormal && !wasStopping && !this.stopping,
      });
      if (!wasStopping && !this.stopping && abnormal) {
        const now = Date.now();
        if (now - this.relaunchedAt < 60_000 && this.relaunchedAt !== 0) {
          console.warn(`[browser] chromium exited (code=${code} signal=${signal}); crash-loop guard: not relaunching`);
          return;
        }
        this.relaunchedAt = now;
        console.warn(`[browser] chromium exited unexpectedly (code=${code} signal=${signal}); relaunching`);
        void this.ensureRunning().catch((err) => {
          console.warn("[browser] auto-relaunch failed:", err instanceof Error ? err.message : err);
        });
      }
    });

    try {
      await session.start();
    } catch (err) {
      try {
        child.kill("SIGKILL");
      } catch {}
      const message = err instanceof Error ? err.message : String(err);
      this.setStatus("error", message);
      throw new BrowserError("launch-failed", `Chromium launch failed: ${message}`);
    }

    this.setStatus("running", null);
    if (hostExt) {
      try {
        this.hostExtensionId = await installHostExtension(cdp, hostExt);
      } catch (err) {
        console.warn(
          "[browser] host extension load failed:",
          err instanceof Error ? err.message : err,
        );
      }
    } else {
      this.hostExtensionId = null;
    }
    try {
      await this.onLaunched?.(session);
    } catch (err) {
      console.warn("[browser] post-launch hook failed:", err instanceof Error ? err.message : err);
    }
    return session;
  }

  ensureRunning(initialUrl?: string): Promise<BrowserSession> {
    if (this.session && this.status === "running") {
      return Promise.resolve(this.session);
    }
    if (this.inFlight) return this.inFlight;
    this.stopping = false;
    const promise = this.launch(initialUrl ?? null);
    this.inFlight = promise;
    void promise.finally(() => {
      if (this.inFlight === promise) this.inFlight = null;
    });
    return promise;
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    const cdp = this.cdp;
    this.child = null;
    this.session = null;
    this.cdp = null;
    if (cdp) {
      try {
        await cdp.send("Browser.close");
      } catch {}
      cdp.close();
    }
    if (child) {
      const exited = new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
      });
      const termTimer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
        } catch {}
      }, 3_000);
      const killTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 6_000);
      await Promise.race([
        exited,
        new Promise<void>((resolve) => setTimeout(resolve, 7_000)),
      ]);
      clearTimeout(termTimer);
      clearTimeout(killTimer);
    }
    this.inFlight = null;
    this.refreshMissingState();
    if (this.status !== "missing") this.setStatus("stopped", null);
  }
}
