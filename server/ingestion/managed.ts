import { readWikiCabinet } from "../../src/lib/llm-wiki/config";
import { statOrNull } from "../../src/lib/llm-wiki/filesystem";
import { SourceStore, type SourceManifest } from "../../src/lib/llm-wiki/source-store";
import type { IngestionQueue } from "../../src/lib/llm-wiki/queue";
import type { SourceId } from "../../src/lib/llm-wiki/types";
import { isProcessStale } from "../../src/lib/runtime/runtime-config";
import { signature, stableHash } from "./stable-file";

interface Observation { key: string; since: number; checked: boolean }

/** Poll only registered working paths. Registry discovery reads manifests, never
 * evidence contents. Polling survives atomic saves and missing/rebound paths.
 * This service submits intent; it never claims jobs or changes source evidence.
 */
export class ManagedSourceWatcher {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private started = false;
  private work = Promise.resolve();
  private observations = new Map<SourceId, Observation>();
  private errors = new Map<SourceId, string>();
  private error: string | null = null;
  private enabled = false;
  private queue: IngestionQueue | null = null;

  constructor(
    private readonly root: string,
    private readonly openQueue: () => Promise<IngestionQueue | null>,
    private readonly options: { pollMs?: number; stabilityMs?: number; onError?: (message: string) => void } = {},
  ) {
    for (const interval of [options.pollMs ?? 1000, options.stabilityMs ?? 1500]) {
      if (!Number.isSafeInteger(interval) || interval < 20) throw new Error("Invalid watcher interval");
    }
  }

  status() {
    return { enabled: this.enabled, watching: this.started && !this.closed && this.enabled && !this.error,
      error: this.error, sources: [...this.observations.keys()],
      errors: [...this.errors].map(([sourceId, error]) => ({ sourceId, error })) };
  }

  async start(): Promise<void> {
    if (this.started || this.closed) return;
    this.started = true;
    await this.refresh();
    this.schedule();
  }

  private schedule(): void {
    if (this.closed) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().then(() => this.schedule());
    }, this.options.pollMs ?? 1000);
  }

  /** Serialized refresh also discovers registration, rebinding and config changes. */
  refresh(): Promise<void> {
    this.work = this.work.then(async () => {
      if (this.closed) return;
      try {
        if (isProcessStale()) throw new Error("Cabinet root changed; restart required");
        const cabinet = await readWikiCabinet(this.root);
        this.enabled = cabinet?.config.enabled ?? false;
        if (!this.enabled) {
          this.observations.clear(); this.errors.clear(); this.error = null; this.queue = null;
          return;
        }
        this.queue ??= await this.openQueue();
        if (!this.queue) throw new Error("Ingestion queue unavailable");
        const store = new SourceStore(this.root);
        const entries = (await store.list()).filter(({ source }) => source.mode === "managed" && source.status !== "archived" &&
          source.lifecycle?.action !== "purge" && !(source.status === "deleted" && source.deletionReason === "user"));
        const ids = new Set(entries.map(({ source }) => source.id));
        for (const id of this.observations.keys()) if (!ids.has(id)) this.observations.delete(id);
        for (const id of this.errors.keys()) if (!ids.has(id)) this.errors.delete(id);
        this.error = null;
        for (const entry of entries) {
          if (this.closed) return;
          try {
            await this.inspect(store, entry);
            this.errors.delete(entry.source.id);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (this.errors.get(entry.source.id) !== message) this.options.onError?.(`${entry.source.title}: ${message}`);
            this.errors.set(entry.source.id, message);
            this.observations.delete(entry.source.id); // Retry after stability when access returns.
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (this.error !== message) this.options.onError?.(message);
        this.error = message;
        this.observations.clear(); this.errors.clear(); this.queue = null;
      }
    });
    return this.work;
  }

  private async inspect(store: SourceStore, entry: SourceManifest): Promise<void> {
    const { source, versions } = entry;
    if (source.mode !== "managed") return;
    // Resolve authorization separately from stat: ENOENT resolving a mount is
    // unavailability, whereas a missing file inside an accessible mount is deletion.
    const file = await store.resolveManagedPath(source);
    const stat = await statOrNull(file);
    if (stat && !stat.isFile()) throw new Error("Managed input is not a regular file");
    const fingerprint = stat ? signature(stat) : "missing";
    const latest = this.queue!.list().filter((job) => job.sourceId === source.id && job.operation !== "reprocess").at(-1);
    const version = versions.find((item) => item.id === source.currentVersionId);
    const key = JSON.stringify([file, source.managedLocation, source.status, source.currentVersionId, latest?.id, latest?.status, fingerprint]);
    let observation = this.observations.get(source.id);
    if (!observation || observation.key !== key) {
      observation = { key, since: Date.now(), checked: false };
      this.observations.set(source.id, observation);
      return;
    }
    if (observation.checked || Date.now() - observation.since < (this.options.stabilityMs ?? 1500)) return;
    const current = () => !this.closed && !isProcessStale();
    const digest = stat ? await stableHash(file, fingerprint, current) : null;
    if (!current()) return;
    if (stat && digest === null) { this.observations.delete(source.id); return; }
    // Binding/permission/config can change during a long read. Revalidate before
    // any submission, particularly deletion, whose queue request has no location.
    const fresh = await store.get(source.id);
    const cabinet = await readWikiCabinet(this.root);
    if (!current() || !cabinet?.config.enabled || !fresh || JSON.stringify(fresh.source) !== JSON.stringify(source)) return;
    if (await store.resolveManagedPath(source) !== file) return;
    const finalStat = await statOrNull(file);
    if ((finalStat ? signature(finalStat) : "missing") !== fingerprint || !current()) return;

    // Outstanding jobs describe the last observed state, including reverts and
    // restores. Completed work defers to the authoritative manifest projection.
    const pending = latest && latest.status !== "complete";
    const deleted = pending ? latest.operation === "delete" : source.status === "deleted";
    const previousHash = pending ? latest.contentHash : version?.contentHash;
    const same = stat ? !deleted && digest === previousHash : deleted;
    if (!same) {
      const base = { sourceId: source.id, roomPath: source.roomPath,
        generation: `managed-v1:${latest?.id ?? "initial"}:${source.currentVersionId ?? "none"}` };
      if (!stat) await this.queue!.enqueue({ ...base, operation: "delete" });
      else await this.queue!.enqueue({ ...base,
        operation: !version && !latest ? "create" : "update",
        input: source.managedLocation, contentHash: digest!,
      });
    }
    observation.checked = true;
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    await this.work;
    this.observations.clear();
  }
}
