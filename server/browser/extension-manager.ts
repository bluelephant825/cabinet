/**
 * ExtensionManager: Chrome Web Store installs for the Cabinet Browser.
 *
 * Flow: extract the [a-p]{32} id -> download the CRX from the update2 endpoint
 * -> strip the Cr24 header (v2/v3 offsets) -> unzip with jszip into
 * <appdata>/Browser/Extensions/<id> -> if the browser is running,
 * Extensions.loadUnpacked({path}) returns the runtime id.
 *
 * No manifest or JS patching — that was the Electron shim era; the sidecar is
 * real Chromium so extensions run unmodified.
 *
 * Records persist in <appdata>/Browser/extensions.json (atomic temp+rename).
 * migrateLegacyRecords() re-downloads ids found in cabinet-config.json
 * `extensions[]` (the old dirs were mutated by the stub patcher and are never
 * reused) and then strips that key.
 */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import type { CDPClient } from "./cdp-client";
import { BrowserError, type BrowserExtensionRecord } from "./types";
import {
  cabinetConfigPath,
  extensionDirFor,
  extensionsStatePath,
} from "./paths";
import { PINNED_CHROME_BUILD } from "./chromium-manager";

export function extractExtensionId(idOrUrl: string): string | null {
  const match = String(idOrUrl ?? "").match(/[a-p]{32}/);
  return match ? match[0] : null;
}

/** Byte offset of the embedded zip inside a CRX buffer (0 when not a Cr24). */
export function crxZipOffset(buffer: Buffer): number {
  if (buffer.length < 16) {
    throw new BrowserError(
      "invalid",
      "Chrome Web Store returned no CRX data. Check the extension ID and that the extension is still available.",
    );
  }
  const magic = buffer.readUInt32LE(0);
  if (magic !== 0x34327243) return 0; // 'Cr24' — raw zip fallback
  const version = buffer.readUInt32LE(4);
  if (version === 3) {
    const headerSize = buffer.readUInt32LE(8);
    return 12 + headerSize;
  }
  if (version === 2) {
    const pubKeyLength = buffer.readUInt32LE(8);
    const sigLength = buffer.readUInt32LE(12);
    return 16 + pubKeyLength + sigLength;
  }
  throw new BrowserError("invalid", `Unknown CRX version: ${version}`);
}

/** Resolve __MSG_key__ strings against _locales/<default_locale>/messages.json
 * with a case-insensitive key fallback (Chrome treats keys case-insensitively). */
export function resolveI18nMessage(
  value: string | undefined | null,
  extensionDir: string,
  manifest: { default_locale?: string },
): string | undefined | null {
  if (!value || typeof value !== "string" || !value.startsWith("__MSG_") || !value.endsWith("__")) {
    return value;
  }
  const msgKey = value.slice(6, -2);
  const defaultLocale = manifest.default_locale || "en";
  const messagesPath = path.join(extensionDir, "_locales", defaultLocale, "messages.json");
  if (!fs.existsSync(messagesPath)) return value;
  try {
    const messages = JSON.parse(fs.readFileSync(messagesPath, "utf8")) as Record<
      string,
      { message?: string }
    >;
    let match = messages[msgKey];
    if (!match) {
      const lowerKey = msgKey.toLowerCase();
      for (const key of Object.keys(messages)) {
        if (key.toLowerCase() === lowerKey) {
          match = messages[key];
          break;
        }
      }
    }
    if (match?.message) return match.message;
  } catch {}
  return value;
}

function iconDataUrlFor(extensionDir: string, manifest: Record<string, unknown>): string | null {
  const icons = (manifest.icons ?? {}) as Record<string, unknown>;
  const action = (manifest.action ?? manifest.browser_action ?? {}) as Record<string, unknown>;
  const ref = icons["128"] ?? icons["48"] ?? icons["16"] ?? action.default_icon;
  const candidates: string[] = [];
  if (typeof ref === "string") {
    candidates.push(ref);
  } else if (ref && typeof ref === "object") {
    for (const value of Object.values(ref as Record<string, unknown>)) {
      if (typeof value === "string") candidates.push(value);
    }
  }
  for (const rel of candidates) {
    const full = path.join(extensionDir, rel);
    if (!fs.existsSync(full)) continue;
    try {
      const ext = path.extname(full).slice(1) || "png";
      const base64 = fs.readFileSync(full).toString("base64");
      return `data:image/${ext};base64,${base64}`;
    } catch {}
  }
  return null;
}

export type ExtensionManagerDeps = {
  /** Live CDP client when the browser is running, else null. */
  getCdp: () => CDPClient | null;
  /** fetch override for tests. */
  fetchFn?: typeof fetch;
};

type LegacyExtensionRecord = {
  id?: unknown;
  enabled?: unknown;
  pinned?: unknown;
};

export class ExtensionManager extends EventEmitter {
  private records: BrowserExtensionRecord[] | null = null;
  private migrated = false;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly deps: ExtensionManagerDeps) {
    super();
    this.fetchFn = deps.fetchFn ?? fetch;
  }

  private async loadRecords(): Promise<BrowserExtensionRecord[]> {
    if (this.records) return this.records;
    try {
      const parsed = JSON.parse(await fsp.readFile(extensionsStatePath(), "utf8"));
      this.records = Array.isArray(parsed) ? (parsed as BrowserExtensionRecord[]) : [];
    } catch {
      this.records = [];
    }
    return this.records;
  }

  private async saveRecords(): Promise<void> {
    const records = this.records ?? [];
    await fsp.mkdir(path.dirname(extensionsStatePath()), { recursive: true });
    const tmp = `${extensionsStatePath()}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(records, null, 2), "utf8");
    await fsp.rename(tmp, extensionsStatePath());
  }

  private record(id: string, list: BrowserExtensionRecord[]): BrowserExtensionRecord {
    const found = list.find((entry) => entry.id === id);
    if (!found) throw new BrowserError("not-found", "Extension not found");
    return found;
  }

  async list(): Promise<BrowserExtensionRecord[]> {
    return [...(await this.loadRecords())];
  }

  private async downloadCrx(id: string): Promise<Buffer> {
    const url =
      `https://clients2.google.com/service/update2/crx?response=redirect` +
      `&prodversion=${PINNED_CHROME_BUILD}&acceptformat=crx2,crx3` +
      `&x=id%3D${id}%26uc`;
    const res = await this.fetchFn(url);
    if (!res.ok) {
      throw new BrowserError("invalid", `Failed to download extension CRX (HTTP ${res.status})`);
    }
    return Buffer.from(await res.arrayBuffer());
  }

  private async loadUnpacked(extensionDir: string): Promise<string | null> {
    const cdp = this.deps.getCdp();
    if (!cdp) return null;
    const result = (await cdp.send("Extensions.loadUnpacked", { path: extensionDir })) as
      | { id?: string }
      | undefined;
    return result?.id ?? null;
  }

  private async uninstallRuntime(runtimeId: string | null): Promise<void> {
    const cdp = this.deps.getCdp();
    if (!cdp || !runtimeId) return;
    try {
      await cdp.send("Extensions.uninstall", { id: runtimeId });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!/not found|no such|cannot find/i.test(message)) throw err;
    }
  }

  async install(idOrUrl: string): Promise<BrowserExtensionRecord> {
    const id = extractExtensionId(idOrUrl);
    if (!id) {
      throw new BrowserError(
        "invalid",
        "Could not find a valid extension ID in the input. Paste the Chrome Web Store URL or the 32-character extension ID.",
      );
    }

    const buffer = await this.downloadCrx(id);
    const zip = await JSZip.loadAsync(buffer.subarray(crxZipOffset(buffer)));

    const outDir = extensionDirFor(id);
    await fsp.rm(outDir, { recursive: true, force: true });
    await fsp.mkdir(outDir, { recursive: true });
    for (const [relativePath, file] of Object.entries(zip.files)) {
      const full = path.join(outDir, relativePath);
      // Skip entries that would escape the extension dir (zip traversal).
      if (full !== outDir && !full.startsWith(`${outDir}${path.sep}`)) continue;
      if (file.dir) {
        await fsp.mkdir(full, { recursive: true });
        continue;
      }
      await fsp.mkdir(path.dirname(full), { recursive: true });
      await fsp.writeFile(full, await file.async("nodebuffer"));
    }

    const manifestPath = path.join(outDir, "manifest.json");
    let manifest: Record<string, unknown> = {};
    if (fs.existsSync(manifestPath)) {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    }
    const i18n = (value: unknown) =>
      resolveI18nMessage(
        typeof value === "string" ? value : undefined,
        outDir,
        manifest as { default_locale?: string },
      );

    const action = (manifest.action ?? manifest.browser_action ?? {}) as {
      default_popup?: unknown;
    };
    const optionsUi = (manifest.options_ui ?? {}) as { page?: unknown };
    const contentScriptMatches: string[] = [];
    if (Array.isArray(manifest.content_scripts)) {
      for (const cs of manifest.content_scripts as { matches?: unknown }[]) {
        if (!Array.isArray(cs?.matches)) continue;
        for (const m of cs.matches) {
          if (typeof m === "string" && !contentScriptMatches.includes(m)) {
            contentScriptMatches.push(m);
          }
        }
      }
    }

    const records = await this.loadRecords();
    const existing = records.find((entry) => entry.id === id);
    const record: BrowserExtensionRecord = {
      id,
      name: (i18n(manifest.name) as string) || id,
      version: typeof manifest.version === "string" ? manifest.version : "unknown",
      path: outDir,
      description: (i18n(manifest.description) as string) || "",
      iconDataUrl: iconDataUrlFor(outDir, manifest),
      popupHtml: typeof action.default_popup === "string" ? action.default_popup : null,
      optionsPage:
        typeof manifest.options_page === "string"
          ? manifest.options_page
          : typeof optionsUi.page === "string"
            ? optionsUi.page
            : null,
      contentScriptMatches,
      enabled: existing?.enabled ?? true,
      pinned: existing?.pinned ?? false,
      runtimeId: null,
    };

    if (record.enabled && this.deps.getCdp()) {
      record.runtimeId = await this.loadUnpacked(outDir);
    }

    const index = records.findIndex((entry) => entry.id === id);
    if (index >= 0) records[index] = record;
    else records.push(record);
    await this.saveRecords();
    this.emit("installed", record);
    return record;
  }

  async uninstall(id: string): Promise<{ ok: true }> {
    const records = await this.loadRecords();
    const rec = this.record(id, records);
    await this.uninstallRuntime(rec.runtimeId);
    records.splice(records.indexOf(rec), 1);
    await this.saveRecords();
    await fsp.rm(rec.path, { recursive: true, force: true });
    this.emit("removed", rec);
    return { ok: true };
  }

  async disable(id: string): Promise<BrowserExtensionRecord> {
    const records = await this.loadRecords();
    const rec = this.record(id, records);
    await this.uninstallRuntime(rec.runtimeId);
    rec.runtimeId = null;
    rec.enabled = false;
    await this.saveRecords();
    this.emit("updated", rec);
    return rec;
  }

  async enable(id: string): Promise<BrowserExtensionRecord> {
    const records = await this.loadRecords();
    const rec = this.record(id, records);
    rec.enabled = true;
    rec.runtimeId = this.deps.getCdp() ? await this.loadUnpacked(rec.path) : null;
    await this.saveRecords();
    this.emit("updated", rec);
    return rec;
  }

  async setPinned(id: string, pinned: boolean): Promise<BrowserExtensionRecord> {
    const records = await this.loadRecords();
    const rec = this.record(id, records);
    rec.pinned = pinned;
    await this.saveRecords();
    this.emit("updated", rec);
    return rec;
  }

  /** Re-load every enabled record right after launch. Failures are logged and
   * the record keeps enabled:true with runtimeId:null. */
  async applyAll(): Promise<void> {
    const records = await this.loadRecords();
    if (!this.deps.getCdp()) return;
    for (const rec of records) {
      if (!rec.enabled) {
        rec.runtimeId = null;
        continue;
      }
      try {
        rec.runtimeId = await this.loadUnpacked(rec.path);
      } catch (err) {
        rec.runtimeId = null;
        console.warn(
          `[browser] failed to load extension ${rec.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    await this.saveRecords();
  }

  /** One-shot migration of Electron-era records out of cabinet-config.json.
   * Lazy (runs on first ensureRunning, needs network), never fatal. */
  async migrateLegacyRecords(): Promise<void> {
    if (this.migrated) return;
    this.migrated = true;
    try {
      if (fs.existsSync(extensionsStatePath())) return;
      const configPath = cabinetConfigPath();
      if (!configPath || !fs.existsSync(configPath)) return;
      const config = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        extensions?: LegacyExtensionRecord[];
      };
      const legacy = Array.isArray(config.extensions) ? config.extensions : [];
      const userData = process.env.CABINET_USER_DATA?.trim();
      for (const entry of legacy) {
        const id = typeof entry?.id === "string" ? extractExtensionId(entry.id) : null;
        if (!id) continue;
        try {
          await this.install(id);
          if (entry?.enabled === false) {
            // install() already loaded it into the runtime — route through
            // disable() so it is actually uninstalled there too.
            await this.disable(id);
          }
          if (entry?.pinned === true) {
            await this.setPinned(id, true);
          }
          // The old unpacked dir was mutated by the stub patcher — never reuse.
          if (userData) {
            await fsp.rm(path.join(userData, "extensions", id), { recursive: true, force: true });
          }
        } catch (err) {
          console.warn(
            `[browser] legacy extension migration failed for ${id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      }
      delete config.extensions;
      const tmp = `${configPath}.tmp`;
      await fsp.writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
      await fsp.rename(tmp, configPath);
    } catch (err) {
      console.warn(
        "[browser] legacy extension migration failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }
}
