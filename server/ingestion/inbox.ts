import fs from "node:fs/promises";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { signature, stableHash } from "./stable-file";
import { readWikiCabinet, setAutoIngestInbox } from "../../src/lib/llm-wiki/config";
import { ownedPath, relativePath } from "../../src/lib/llm-wiki/filesystem";
import { isHiddenEntry } from "../../src/lib/storage/path-utils";
import { isProcessStale } from "../../src/lib/runtime/runtime-config";
import type { IngestionQueue } from "../../src/lib/llm-wiki/queue";
import type { InboxStatus, InboxCandidate } from "../../src/lib/llm-wiki/inbox-types";

const GENERATION = "inbox-snapshot-v1";


export function isInboxCandidate(relative: string): boolean {
  try { relativePath(relative); } catch { return false; }
  if (relative.split("/").some(isHiddenEntry)) return false;
  return !/(?:~|\.(?:tmp|temp|part|partial|crdownload|download|swp|swo|lock))$/i.test(relative);
}

/** Narrow validation/enqueue service. No queue claims or model calls. */
export class InboxWatcher {
  private watcher: FSWatcher | null = null;
  private configWatcher: FSWatcher | null = null;
  private queue: IngestionQueue | null = null;
  private inboxPath: string | null = null;
  private closed = false;
  private epoch = 0;
  private revision = 0;
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private candidates = new Map<string, InboxCandidate>();
  private versions = new Map<string, number>();
  private manual = new Set<string>();
  private work = Promise.resolve();
  private refreshWork = Promise.resolve();
  private failure: string | null = null;
  private enabled = false;
  private automatic = false;

  constructor(
    private root: string,
    private readonly openQueue: () => Promise<IngestionQueue | null>,
    private readonly options: { stabilityMs?: number; onChange?: () => void } = {},
  ) {
    const delay = options.stabilityMs ?? 1500;
    if (!Number.isSafeInteger(delay) || delay < 20) throw new Error("Invalid write stability interval");
  }

  async start(): Promise<void> {
    await this.refresh();
    if (this.closed) return;
    // Separate exact-file subscription for settings; never a recursive root watch.
    this.configWatcher = chokidar.watch(path.join(this.root, ".cabinet"), {
      ignoreInitial: true, followSymlinks: false,
      // Atomic manifest replacement changes the inode. Poll only this single
      // small config file so rapid consecutive renames cannot lose its watch.
      usePolling: true, interval: 250,
    });
    this.configWatcher.on("all", () => { void this.refresh(); });
    this.configWatcher.on("error", (error) => {
      void this.configWatcher?.close();
      void this.disable(error);
    });
    await new Promise<void>((resolve) => {
      this.configWatcher!.once("ready", resolve);
      this.configWatcher!.once("error", () => resolve());
    });
    // A settings change between the first read and subscription is not an event
    // when ignoreInitial is true. Close that startup gap with another read.
    await this.refresh();
  }

  status(): InboxStatus {
    const items = [...this.candidates.values()].sort((a, b) => a.path.localeCompare(b.path));
    return { enabled: this.enabled, autoIngestInbox: this.automatic, watching: this.watcher !== null,
      pending: items.filter((item) => item.status === "awaiting" || item.status === "checking").length,
      queued: items.filter((item) => item.status === "queued").length,
      failed: items.filter((item) => item.status === "error").length,
      error: this.failure, items };
  }

  private changed(): void { this.options.onChange?.(); }

  refresh(): Promise<void> {
    this.refreshWork = this.refreshWork.then(async () => {
      if (this.closed) return;
      try {
        if (isProcessStale()) throw new Error("Cabinet root changed; restart required");
        this.root = await fs.realpath(this.root);
        const cabinet = await readWikiCabinet(this.root);
        this.enabled = cabinet?.config.enabled ?? false;
        this.automatic = cabinet?.config.autoIngestInbox ?? false;
        if (!cabinet || !this.enabled) { await this.stopInbox(); this.changed(); return; }
        const absolute = await ownedPath(cabinet.rootPath, cabinet.config.paths.inbox);
        if (this.inboxPath === absolute && this.watcher) {
          if (this.automatic) this.scheduleAwaiting();
          this.changed();
          return;
        }
        await this.stopInbox();
        // Explicitly enabled configuration permits creating its absent Inbox.
        await fs.mkdir(absolute, { recursive: true });
        this.queue = await this.openQueue();
        if (!this.queue) throw new Error("Ingestion queue unavailable");
        if (this.closed) return;
        this.inboxPath = absolute;
        this.failure = null;
        const watcher = chokidar.watch(absolute, {
          ignoreInitial: false, followSymlinks: false,
          awaitWriteFinish: { stabilityThreshold: this.options.stabilityMs ?? 1500, pollInterval: 100 },
          ignored: (entry, stat) => {
            const relative = path.relative(absolute, entry).split(path.sep).join("/");
            return !!relative && (!isInboxCandidate(relative) || !!stat?.isSymbolicLink());
          },
        });
        this.watcher = watcher;
        watcher.on("add", (file) => this.schedule(file));
        watcher.on("change", (file) => this.schedule(file));
        watcher.on("unlink", (file) => this.remove(file));
        watcher.on("unlinkDir", (directory) => {
          for (const file of this.candidates.keys()) if (file === directory || file.startsWith(directory + path.sep)) this.remove(file);
        });
        watcher.on("error", (error) => { if (this.watcher === watcher) void this.disable(error); });
        this.changed();
      } catch (error) { await this.disable(error); }
    });
    return this.refreshWork;
  }

  private scheduleAwaiting(): void {
    for (const [file, candidate] of this.candidates) if (candidate.status === "awaiting") this.schedule(file);
  }

  private schedule(file: string): void {
    if (this.closed || !this.inboxPath) return;
    if (isProcessStale()) { void this.disable(new Error("Cabinet root changed; restart required")); return; }
    const relative = path.relative(this.inboxPath, file).split(path.sep).join("/");
    if (!isInboxCandidate(relative)) return;
    const version = ++this.revision;
    this.versions.set(file, version);
    clearTimeout(this.timers.get(file));
    this.candidates.set(file, { path: path.relative(this.root, file).split(path.sep).join("/"), status: "checking" });
    const epoch = this.epoch;
    // Also stabilizes startup discovery (Chokidar's initial add is immediate).
    void fs.stat(file).then((stat) => {
      if (this.closed || epoch !== this.epoch || version !== this.versions.get(file)) return;
      const before = signature(stat);
      const timer = setTimeout(() => {
        this.timers.delete(file);
        this.work = this.work.then(() => this.inspect(file, before, epoch, version));
      }, this.options.stabilityMs ?? 1500);
      this.timers.set(file, timer);
    }).catch((error) => {
      if (epoch !== this.epoch || version !== this.versions.get(file)) return;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") this.remove(file);
      else {
        this.candidates.set(file, { path: path.relative(this.root, file).split(path.sep).join("/"), status: "error", error: String(error) });
        this.changed();
      }
    });
    this.changed();
  }

  private async inspect(file: string, expected: string, epoch: number, version: number): Promise<void> {
    const current = () => !this.closed && epoch === this.epoch && this.versions.get(file) === version;
    if (!current()) return;
    const relative = path.relative(this.root, file).split(path.sep).join("/");
    try {
      await ownedPath(this.root, relative);
      const digest = await stableHash(file, expected, current);
      if (digest === null) { if (current()) this.schedule(file); return; }
      if (!current()) return;
      const cabinet = await readWikiCabinet(this.root);
      if (!current() || isProcessStale() || !cabinet?.config.enabled || path.join(cabinet.rootPath, cabinet.config.paths.inbox) !== this.inboxPath) return;
      const prior = this.queue!.list().find((item) => item.operation === "create" && item.generation === GENERATION &&
        item.input?.kind === "cabinet" && item.input.path === relative && item.contentHash === digest);
      if (prior) {
        this.candidates.set(file, { path: relative, status: "queued", jobId: prior.id });
      } else if (cabinet.config.autoIngestInbox || this.manual.has(file)) {
        const result = await this.queue!.enqueue({ operation: "create", sourceId: null, roomPath: null,
          input: { kind: "cabinet", path: relative }, contentHash: digest, generation: GENERATION });
        if (!current()) return;
        this.candidates.set(file, { path: relative, status: "queued", jobId: result.id });
      } else this.candidates.set(file, { path: relative, status: "awaiting" });
      this.manual.delete(file);
      this.changed();
    } catch (error) {
      if (!current()) return;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.remove(file); return; }
      this.candidates.set(file, { path: relative, status: "error", error: error instanceof Error ? error.message : String(error) });
      this.manual.delete(file);
      this.changed();
    }
  }

  private remove(file: string): void {
    clearTimeout(this.timers.get(file));
    this.timers.delete(file);
    this.versions.delete(file);
    this.candidates.delete(file);
    this.manual.delete(file);
    // Inbox disappearance never deletes a job, Source, or evidence.
    this.changed();
  }

  async ingestAll(): Promise<InboxStatus> {
    await this.refresh();
    if (!this.enabled || !this.watcher) throw new Error("Inbox watcher is unavailable");
    for (const [file, candidate] of this.candidates) {
      if (candidate.status === "queued") continue;
      this.manual.add(file);
      this.schedule(file);
    }
    return this.status(); // Enqueue continues asynchronously after stabilization.
  }

  async setAutomatic(enabled: boolean): Promise<InboxStatus> {
    await setAutoIngestInbox(this.root, enabled);
    await this.refresh();
    return this.status();
  }

  private async stopInbox(): Promise<void> {
    this.epoch++;
    const watcher = this.watcher;
    this.watcher = null;
    this.inboxPath = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear(); this.candidates.clear(); this.manual.clear(); this.versions.clear();
    if (watcher) await watcher.close();
  }

  private async disable(error: unknown): Promise<void> {
    this.failure = error instanceof Error ? error.message : String(error);
    await this.stopInbox();
    this.changed();
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.configWatcher?.close();
    await this.stopInbox();
    await this.refreshWork;
    await this.work;
  }
}
