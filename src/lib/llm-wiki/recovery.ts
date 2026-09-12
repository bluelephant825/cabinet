import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { readWikiCabinet, WIKI_STATE_PATH } from "./config";
import { ownedPath, record, statOrNull } from "./filesystem";
import { decodeSourceManifest } from "./manifest";
import { SourceStore } from "./source-store";
import { RawPublicationStore } from "./raw-publication";
import type { IngestionQueue } from "./queue";
import type { IngestionJobId } from "./types";

/** Recovery is explicit and stage-aware. This service cannot mark a queue job or
 * lifecycle complete, publish Wiki pages, erase evidence, or steal a root lock. */
export class IngestionRecoveryService {
  constructor(private readonly root: string, private readonly queue: IngestionQueue) {}
  private async cabinet() {
    const cabinet = await readWikiCabinet(this.root);
    if (!cabinet || cabinet.cabinetId !== this.queue.cabinetId) throw new Error("Recovery queue belongs to a different Cabinet");
    return cabinet;
  }
  async inspect(id: IngestionJobId) {
    const cabinet = await this.cabinet(), job = this.queue.get(id);
    const manifest = job.sourceId ? await new SourceStore(cabinet.rootPath).get(job.sourceId) : null;
    if (manifest && manifest.source.roomPath !== job.roomPath) throw new Error("Recovery Source scope changed");
    const attempts = this.queue.attempts(id).slice(-20);
    const last = attempts.length ? record(attempts.at(-1)) : null;
    const active = manifest?.source.status === "active" && manifest.source.lifecycle?.reconciliation !== "pending";
    let recommendation = "No recovery action needed.";
    let action: "none" | "retry" | "review-raw" | "recompile" | "review" = "none";
    if (job.status === "failed") {
      action = job.sourceId && !active ? "review" : "retry";
      recommendation = action === "retry" ? "Retry pre-write work with a bounded attempt budget. Existing evidence is preserved." : "The Source is missing or inactive; review lifecycle state before retrying.";
    } else if (job.status === "needs-review") {
      action = last?.stage === "promoting" && active ? "review-raw" : last?.stage === "compiling" || last?.stage === "reconciling" ? "recompile" : "review";
      recommendation = action === "review-raw" ? "Inspect an explicit Raw version receipt before resuming publication. The queue job remains under review." :
        action === "recompile" ? "Prepare a fresh Wiki plan from current verified evidence; completed publication is required before resolving this job." :
        "Inspect the interrupted operation and authoritative Source state before continuing.";
    }
    const fingerprint = createHash("sha256").update(JSON.stringify({ job, manifest, attempts })).digest("hex");
    return { fingerprint, enabled: cabinet.config.enabled, job, attempts, source: manifest?.source ?? null,
      currentVersion: manifest?.versions.find((version) => version.id === manifest.source.currentVersionId) ?? null,
      action, recommendation };
  }
  async retry(id: IngestionJobId, expectedFingerprint: string, additionalAttempts = 3) {
    const report = await this.inspect(id);
    if (report.fingerprint !== expectedFingerprint) throw new Error("Recovery state changed; inspect again");
    if (!report.enabled || report.action !== "retry") throw new Error("This job cannot be retried without review");
    return this.queue.retry(id, additionalAttempts, { updatedAt: report.job.updatedAt, attempts: report.job.attempts });
  }
  async recoverRaw(id: IngestionJobId, expectedFingerprint: string, versionNumber: number) {
    const report = await this.inspect(id);
    if (report.fingerprint !== expectedFingerprint) throw new Error("Recovery state changed; inspect again");
    if (!report.enabled || report.action !== "review-raw" || !report.source || !report.job.contentHash || !Number.isSafeInteger(versionNumber) || versionNumber < 1) throw new Error("Explicit Raw receipt review is required");
    const cabinet = await this.cabinet();
    const file = await ownedPath(cabinet.rootPath, `${WIKI_STATE_PATH}/publications/${report.source.id}/v${versionNumber}/receipt.json`);
    const stat = await statOrNull(file);
    if (!stat || stat.size > 10_000_000) throw new Error("Missing or oversized Raw recovery receipt");
    const bytes = await fs.readFile(file);
    if (bytes.length > 10_000_000) throw new Error("Oversized Raw recovery receipt");
    const receipt = record(JSON.parse(bytes.toString("utf8")));
    if (typeof receipt.manifest !== "string") throw new Error("Invalid recovery receipt");
    const intended = decodeSourceManifest(receipt.manifest, cabinet, report.source.rawPath);
    const version = intended.versions.at(-1);
    if (intended.source.id !== report.source.id || version?.version !== versionNumber || version.contentHash !== report.job.contentHash) throw new Error("Raw receipt does not match the failed job");
    if ((await this.inspect(id)).fingerprint !== expectedFingerprint) throw new Error("Recovery state changed; inspect again");
    const manifest = await new RawPublicationStore(cabinet.rootPath).recoverVersion(report.source.id, versionNumber);
    return { status: "raw-recovered" as const, sourceId: manifest.source.id, currentVersionId: manifest.source.currentVersionId,
      queueStatus: this.queue.get(id).status, wikiPublication: "not-completed" as const };
  }
  /** Existing lease recovery respects live workers and moves interrupted writes
   * to review. It never replays conversion/publication or removes lock files. */
  async recoverExpiredLeases() {
    const cabinet = await this.cabinet();
    if (!cabinet.config.enabled) throw new Error("Wiki recovery is disabled");
    return this.queue.recoverExpired();
  }
}
