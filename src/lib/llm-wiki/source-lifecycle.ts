import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { opaqueId, readWikiCabinet, WIKI_STATE_PATH, type WikiCabinet } from "./config";
import { ownedPath, statOrNull, withRootLock } from "./filesystem";
import { SourceStore } from "./source-store";
import { decodeSourceManifest, encodeSourceManifest, type SourceManifest } from "./manifest";
import type { SourceId } from "./types";

/** Trusted compiler integration, never a model's self-reported success. Removal
 * must withdraw this Source's contribution, check alternative active support and
 * keep/mark unsupported/remove affected claims before returning. Must be
 * idempotent by request.key; must not acquire this Cabinet's lifecycle lock. */
export interface LifecycleReconciler {
  reconcile(request: { key: string; manifest: SourceManifest; action: "remove" | "restore" | "purge" }):
    Promise<{ sourceId: SourceId; revision: number }>;
}
interface PurgeReceipt { schemaVersion: 1; manifest: string; revision: number; status: "reconciled" | "purged" }

/** Lifecycle metadata is authoritative even if Wiki reconciliation fails. */
export class SourceLifecycleStore {
  constructor(private readonly root: string,
    private readonly checkpoint?: (point: "reconciled" | "quarantined" | "erased") => void | Promise<void>) {}

  private async cabinet(): Promise<WikiCabinet> {
    const cabinet = await readWikiCabinet(this.root);
    if (!cabinet?.config.enabled) throw new Error("LLM Wiki is not enabled");
    return cabinet;
  }

  async remove(id: SourceId, expectedRevision: number, reason: "user" | "missing" = "user") {
    if (!["user", "missing"].includes(reason)) throw new Error("Invalid removal reason");
    return this.transition(id, expectedRevision, "remove", reason);
  }

  async restore(id: SourceId, expectedRevision: number, reason: "user" | "returned" = "user") {
    if (!["user", "returned"].includes(reason)) throw new Error("Invalid restoration reason");
    return this.transition(id, expectedRevision, "restore", reason);
  }

  private async transition(id: SourceId, expectedRevision: number, action: "remove" | "restore", reason: "user" | "missing" | "returned") {
    opaqueId(id); this.revision(expectedRevision);
    const first = await this.cabinet();
    return withRootLock(first.rootPath, async () => {
      const cabinet = await this.cabinet(), store = new SourceStore(cabinet.rootPath);
      const entry = await store.get(id);
      if (!entry || entry.source.status === "archived") throw new Error("Source unavailable for lifecycle change");
      const current = entry.source.lifecycle;
      if (current?.action === "purge") throw new Error("Permanent deletion is pending; restoration requires review");
      if (current?.revision === expectedRevision + 1 && current.action === action &&
          (action === "restore" || entry.source.deletionReason === reason)) return entry;
      if ((current?.revision ?? 0) !== expectedRevision) throw new Error("Stale lifecycle revision");
      if ((action === "remove" && entry.source.status !== "active") || (action === "restore" && entry.source.status !== "deleted")) throw new Error("Invalid lifecycle transition");
      if (reason !== "user") {
        if (entry.source.mode !== "managed") throw new Error("Working-file lifecycle requires a managed Source");
        if (reason === "returned" && entry.source.deletionReason !== "missing") throw new Error("User removal requires explicit restoration");
        const file = await store.resolveManagedPath(entry.source);
        const stat = await statOrNull(file);
        if (reason === "missing" && stat) throw new Error("Working file returned; deletion is stale");
        if (reason === "returned" && !stat?.isFile()) throw new Error("Working file has not returned");
      }
      const now = new Date().toISOString();
      entry.source.status = action === "remove" ? "deleted" : "active";
      entry.source.updatedAt = now;
      if (action === "remove") { entry.source.deletedAt = now; entry.source.deletionReason = reason as "user" | "missing"; }
      else { delete entry.source.deletedAt; delete entry.source.deletionReason; }
      entry.source.lifecycle = { revision: expectedRevision + 1, action, reconciliation: "pending" };
      await this.save(cabinet, entry);
      return entry;
    });
  }

  /** Retry separately from remove/restore; failure leaves pending visible on disk. */
  async reconcile(id: SourceId, expectedRevision: number, reconciler: LifecycleReconciler) {
    opaqueId(id); this.revision(expectedRevision);
    const first = await this.cabinet();
    return withRootLock(first.rootPath, async () => {
      const cabinet = await this.cabinet();
      const entry = await new SourceStore(cabinet.rootPath).get(id);
      if (!entry?.source.lifecycle || entry.source.lifecycle.revision !== expectedRevision) throw new Error("Stale lifecycle revision");
      if (entry.source.lifecycle.action === "purge") throw new Error("Use the explicit permanent deletion workflow");
      if (entry.source.lifecycle.reconciliation === "complete") return entry;
      await this.runReconciler(cabinet, entry, reconciler);
      entry.source.lifecycle.reconciliation = "complete";
      await this.save(cabinet, entry);
      return entry;
    });
  }

  /** Explicit confirmation is bound to this Source ID. No automatic caller may
   * use this operation. The working document/mount is never deleted. */
  async permanentlyDelete(id: SourceId, expectedRevision: number, confirmation: SourceId, reconciler: LifecycleReconciler) {
    opaqueId(id); this.revision(expectedRevision);
    if (confirmation !== id) throw new Error("Explicit Source confirmation required");
    if (!reconciler || typeof reconciler.reconcile !== "function") throw new Error("Wiki reconciliation is required before permanent deletion");
    const first = await this.cabinet();
    return withRootLock(first.rootPath, async () => {
      const cabinet = await this.cabinet();
      const receiptRelative = `${WIKI_STATE_PATH}/purges/${id}/receipt.json`;
      const receiptPath = await ownedPath(cabinet.rootPath, receiptRelative);
      const quarantine = await ownedPath(cabinet.rootPath, `${WIKI_STATE_PATH}/purges/${id}/evidence`);
      const store = new SourceStore(cabinet.rootPath);
      let entry = await store.get(id);
      let receipt: PurgeReceipt | undefined;
      if (await statOrNull(receiptPath)) {
        const bytes = await fs.readFile(receiptPath, "utf8");
        if (bytes.length > 10_000_000) throw new Error("Invalid purge receipt");
        receipt = JSON.parse(bytes);
        if (!receipt || receipt.schemaVersion !== 1 || receipt.revision !== expectedRevision + 1 ||
            !["reconciled", "purged"].includes(receipt.status)) throw new Error("Conflicting purge receipt");
        // Decode using the path retained in the receipt, then validate root/identity.
        const yaml = await import("js-yaml");
        const raw = yaml.load(receipt.manifest, { schema: yaml.JSON_SCHEMA }) as SourceManifest;
        const saved = decodeSourceManifest(receipt.manifest, cabinet, raw.source.rawPath);
        if (saved.source.id !== id || saved.source.lifecycle?.action !== "purge" ||
            saved.source.lifecycle.revision !== receipt.revision) throw new Error("Foreign purge receipt");
        if (entry && encodeSourceManifest(entry, cabinet) !== receipt.manifest) throw new Error("Source changed after reconciliation; review required");
        entry ??= saved;
      } else {
        if (!entry || entry.source.status !== "deleted") throw new Error("Remove Source from active knowledge first");
        if (entry.source.lifecycle?.action !== "purge") {
          if ((entry.source.lifecycle?.revision ?? 0) !== expectedRevision) throw new Error("Stale lifecycle revision");
          entry.source.lifecycle = { revision: expectedRevision + 1, action: "purge", reconciliation: "pending" };
          entry.source.updatedAt = new Date().toISOString();
          await this.save(cabinet, entry);
        } else if (entry.source.lifecycle.revision !== expectedRevision + 1) throw new Error("Stale lifecycle revision");
        await this.runReconciler(cabinet, entry, reconciler);
        // Retain pending in the source manifest until it is quarantined. The
        // durable receipt is the proof that reconciliation completed for it.
        receipt = { schemaVersion: 1, manifest: encodeSourceManifest(entry, cabinet), revision: expectedRevision + 1, status: "reconciled" };
        await this.writeDurable(cabinet, receiptPath, JSON.stringify(receipt));
        await this.checkpoint?.("reconciled");
      }
      const rawPath = await ownedPath(cabinet.rootPath, entry.source.rawPath);
      if (receipt.status === "purged") {
        if (await statOrNull(rawPath) || await statOrNull(quarantine)) throw new Error("Evidence reappeared after purge; review required");
        return { sourceId: id, status: "purged" as const };
      }
      if (await statOrNull(rawPath)) {
        if (await statOrNull(quarantine)) throw new Error("Conflicting purge quarantine");
        await fs.rename(rawPath, quarantine);
        await this.syncDirectories(cabinet, path.dirname(rawPath));
        await this.syncDirectories(cabinet, path.dirname(quarantine));
        await this.checkpoint?.("quarantined");
      }
      // Recursive removal never follows nested symlinks. The owned quarantine
      // root itself is checked above; only this operation's directory is erased.
      await fs.rm(quarantine, { recursive: true, force: true });
      await this.syncDirectories(cabinet, path.dirname(quarantine));
      await this.checkpoint?.("erased");
      receipt.status = "purged";
      await this.writeDurable(cabinet, receiptPath, JSON.stringify(receipt));
      return { sourceId: id, status: "purged" as const };
    });
  }

  private revision(value: number) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) throw new Error("Invalid lifecycle revision");
  }
  private async save(cabinet: WikiCabinet, entry: SourceManifest) {
    await this.writeDurable(cabinet, await ownedPath(cabinet.rootPath, `${entry.source.rawPath}/manifest.yaml`), encodeSourceManifest(entry, cabinet));
  }
  private async syncDirectories(cabinet: WikiCabinet, directory: string) {
    if (process.platform === "win32") return; // Node cannot fsync Windows directory handles.
    for (let cursor = directory; ; cursor = path.dirname(cursor)) {
      const handle = await fs.open(cursor, "r");
      try { await handle.sync(); } finally { await handle.close(); }
      if (cursor === cabinet.rootPath) break;
    }
  }
  private async writeDurable(cabinet: WikiCabinet, target: string, content: string) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const temp = `${target}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, "wx", 0o600);
    try { await handle.writeFile(content); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temp, target);
    await this.syncDirectories(cabinet, path.dirname(target));
  }
  private async runReconciler(cabinet: WikiCabinet, entry: SourceManifest, reconciler: LifecycleReconciler) {
    if (!reconciler || typeof reconciler.reconcile !== "function") throw new Error("Wiki reconciler unavailable");
    const target = await ownedPath(cabinet.rootPath, `${entry.source.rawPath}/manifest.yaml`);
    const before = await fs.readFile(target, "utf8");
    const lifecycle = entry.source.lifecycle!;
    const result = await reconciler.reconcile({ key: `${entry.source.id}:${lifecycle.revision}`, manifest: structuredClone(entry), action: lifecycle.action });
    if (result.sourceId !== entry.source.id || result.revision !== lifecycle.revision) throw new Error("Reconciliation identity mismatch");
    if (await fs.readFile(target, "utf8") !== before) throw new Error("Source changed during reconciliation; review required");
  }
}
