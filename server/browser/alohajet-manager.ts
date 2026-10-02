import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { EventEmitter } from "node:events";
import { DATA_PARENT_DIR } from "../../src/lib/storage/path-utils";
import {
  ALOHAJET_VERSION,
  DEFAULT_BROWSER_AUTOMATION_SETTINGS,
  type BrowserAutomationSettings,
  type BrowserAutomationStatus,
} from "../../src/lib/browser/automation-types";
import { alohaJetDir } from "./paths";

const execFileAsync = promisify(execFile);
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 300 * 1024 * 1024;
const RELEASES = {
  darwin: {
    url: `https://github.com/AlohaBrowser/alohajet-cli/releases/download/v${ALOHAJET_VERSION}/alohajet-macos-universal.tar.gz`,
    sha256: "6ba310171fe1158520afd144f1740e139a921a471c36e4d22ba3931bca3c819d",
  },
  linux: {
    url: `https://github.com/AlohaBrowser/alohajet-cli/releases/download/v${ALOHAJET_VERSION}/alohajet-linux-x86_64.tar.gz`,
    sha256: "84651f318e0845a93e73f2584ad683d2d6cde80405fd50370e72815ae031215f",
  },
} as const;

type FetchLike = typeof fetch;

type ManagerOptions = {
  platform?: NodeJS.Platform;
  arch?: string;
  installDir?: string;
  settingsPath?: string;
  overridePath?: string;
  fetchImpl?: FetchLike;
  release?: { url: string; sha256: string };
};

function normalizeSettings(value: unknown): BrowserAutomationSettings {
  const input = value && typeof value === "object" ? value as Partial<BrowserAutomationSettings> : {};
  const cap = typeof input.maxObservationTokens === "number" && Number.isFinite(input.maxObservationTokens)
    ? Math.round(input.maxObservationTokens)
    : DEFAULT_BROWSER_AUTOMATION_SETTINGS.maxObservationTokens;
  return {
    enabled: input.enabled === true,
    maxObservationTokens: Math.min(100_000, Math.max(1000, cap)),
    compactTools: input.compactTools === true,
  };
}

async function readBounded(response: Response): Promise<Buffer> {
  if (!response.ok) throw new Error(`AlohaJet download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error("AlohaJet archive exceeds the download limit");
  if (!response.body) throw new Error("AlohaJet download returned no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      throw new Error("AlohaJet archive exceeds the download limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function tarEntries(archive: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_BYTES });
  const wanted = new Set(["alohajet", "LICENSE", "THIRD-PARTY-NOTICES"]);
  const entries = new Map<string, Buffer>();
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
    const fullName = `${prefix ? `${prefix}/` : ""}${name}`;
    const sizeText = header.subarray(124, 136).toString("ascii").replace(/\0.*$/, "").trim();
    const size = Number.parseInt(sizeText || "0", 8);
    if (!Number.isFinite(size) || size < 0 || offset + 512 + size > tar.length) {
      throw new Error("AlohaJet archive is malformed");
    }
    const base = path.posix.basename(fullName);
    const type = header[156];
    if (wanted.has(base) && (type === 0 || type === 48)) {
      if (entries.has(base)) throw new Error(`AlohaJet archive contains duplicate ${base}`);
      entries.set(base, Buffer.from(tar.subarray(offset + 512, offset + 512 + size)));
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  for (const name of wanted) {
    if (!entries.has(name)) throw new Error(`AlohaJet archive is missing ${name}`);
  }
  return entries;
}

export class AlohaJetManager extends EventEmitter {
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly installDir: string;
  private readonly executablePath: string;
  private readonly settingsPath: string;
  private readonly overridePath?: string;
  private readonly fetchImpl: FetchLike;
  private readonly release?: { url: string; sha256: string };
  private installPromise: Promise<string> | null = null;
  private lastError: string | undefined;

  constructor(options: ManagerOptions = {}) {
    super();
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.installDir = options.installDir ?? alohaJetDir();
    this.executablePath = path.join(this.installDir, "alohajet");
    this.settingsPath = options.settingsPath ?? path.join(DATA_PARENT_DIR, ".devin", "browser-automation.json");
    this.overridePath = options.overridePath ?? (process.env.CABINET_ALOHAJET_PATH?.trim() || undefined);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.release = options.release;
  }

  readSettings(): BrowserAutomationSettings {
    try {
      return normalizeSettings(JSON.parse(fs.readFileSync(this.settingsPath, "utf8")));
    } catch {
      return { ...DEFAULT_BROWSER_AUTOMATION_SETTINGS };
    }
  }

  async updateSettings(patch: Partial<BrowserAutomationSettings>): Promise<BrowserAutomationSettings> {
    const next = normalizeSettings({ ...this.readSettings(), ...patch });
    if (next.enabled) await this.ensureInstalled();
    await fsp.mkdir(path.dirname(this.settingsPath), { recursive: true, mode: 0o700 });
    const temp = `${this.settingsPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await fsp.writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await fsp.rename(temp, this.settingsPath);
    this.emit("status", await this.status());
    return next;
  }

  async status(): Promise<BrowserAutomationStatus> {
    const settings = this.readSettings();
    const source = this.overridePath && await this.fileExists(this.overridePath)
      ? "override"
      : await this.fileExists(this.executablePath)
        ? "managed"
        : null;
    return {
      ...settings,
      supported: this.isSupported(),
      installed: source !== null,
      installing: this.installPromise !== null,
      platform: `${this.platform}-${this.arch}`,
      version: ALOHAJET_VERSION,
      source,
      ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  async executable(): Promise<string> {
    const settings = this.readSettings();
    if (!settings.enabled) throw new Error("Browser automation is disabled");
    return this.ensureInstalled();
  }

  async ensureInstalled(): Promise<string> {
    if (this.overridePath) {
      await this.verifyExecutable(this.overridePath);
      return this.overridePath;
    }
    if (!this.isSupported()) throw new Error(`AlohaJet is not available on ${this.platform}-${this.arch}`);
    if (await this.fileExists(this.executablePath)) {
      await this.verifyExecutable(this.executablePath);
      return this.executablePath;
    }
    if (!this.installPromise) {
      this.installPromise = this.install().finally(() => {
        this.installPromise = null;
      });
    }
    return this.installPromise;
  }

  childEnvironment(settings = this.readSettings()): NodeJS.ProcessEnv {
    return {
      NODE_ENV: process.env.NODE_ENV ?? "production",
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      TMPDIR: process.env.TMPDIR ?? "/tmp",
      ALOHAJET_MARKDOWN_URLS: "1",
      ALOHAJET_CREDENTIAL_GUARD: "1",
      ALOHAJET_MAX_OBS_TOKENS: String(settings.maxObservationTokens),
      ALOHAJET_COMPACT_TOOLS: settings.compactTools ? "1" : "0",
      ALOHAJET_NETWORK_LOG: "0",
      ALOHAJET_DEBUG: "0",
    };
  }

  private isSupported(): boolean {
    return this.platform === "darwin" || (this.platform === "linux" && this.arch === "x64");
  }

  private async install(): Promise<string> {
    const release = this.release ?? (this.platform === "darwin" ? RELEASES.darwin : RELEASES.linux);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    this.lastError = undefined;
    this.emit("status", await this.status());
    try {
      const response = await this.fetchImpl(release.url, {
        redirect: "follow",
        signal: controller.signal,
        headers: { "user-agent": `Cabinet/${ALOHAJET_VERSION}` },
      });
      const archive = await readBounded(response);
      const digest = createHash("sha256").update(archive).digest("hex");
      if (digest !== release.sha256) throw new Error("AlohaJet archive checksum mismatch");
      const entries = tarEntries(archive);
      const parent = path.dirname(this.installDir);
      const stage = path.join(parent, `.alohajet-${randomBytes(8).toString("hex")}`);
      await fsp.mkdir(stage, { recursive: true, mode: 0o700 });
      try {
        await fsp.writeFile(path.join(stage, "alohajet"), entries.get("alohajet")!, { mode: 0o755 });
        await fsp.writeFile(path.join(stage, "LICENSE"), entries.get("LICENSE")!, { mode: 0o644 });
        await fsp.writeFile(path.join(stage, "THIRD-PARTY-NOTICES"), entries.get("THIRD-PARTY-NOTICES")!, { mode: 0o644 });
        const backup = `${this.installDir}.old-${randomBytes(4).toString("hex")}`;
        const existing = await this.fileExists(this.installDir);
        if (existing) await fsp.rename(this.installDir, backup);
        try {
          await fsp.rename(stage, this.installDir);
        } catch (error) {
          if (existing && !(await this.fileExists(this.installDir))) await fsp.rename(backup, this.installDir);
          throw error;
        }
        await this.verifyExecutable(this.executablePath);
        if (existing) await fsp.rm(backup, { recursive: true, force: true });
      } finally {
        await fsp.rm(stage, { recursive: true, force: true }).catch(() => {});
      }
      return this.executablePath;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : "AlohaJet installation failed";
      throw error;
    } finally {
      clearTimeout(timer);
      this.emit("status", await this.status());
    }
  }

  private async verifyExecutable(executable: string): Promise<void> {
    const stat = await fsp.stat(executable).catch(() => null);
    if (!stat?.isFile()) throw new Error("AlohaJet executable was not found");
    let stdout: string | Buffer;
    try {
      ({ stdout } = await execFileAsync(executable, ["--version"], {
        timeout: 10_000,
        env: this.childEnvironment(),
        maxBuffer: 1024 * 1024,
      }));
    } catch {
      throw new Error(this.platform === "darwin"
        ? "AlohaJet was downloaded and checksum-verified, but macOS blocked it from starting. Open System Settings > Privacy & Security, allow alohajet, then retry."
        : "AlohaJet executable could not be started");
    }
    if (!stdout.includes(ALOHAJET_VERSION)) {
      throw new Error(`AlohaJet ${ALOHAJET_VERSION} is required`);
    }
  }

  private async fileExists(target: string): Promise<boolean> {
    return Boolean(await fsp.stat(target).catch(() => null));
  }
}

export { tarEntries };
