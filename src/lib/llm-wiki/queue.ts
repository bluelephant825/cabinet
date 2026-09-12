import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { opaqueId, readWikiCabinet } from "./config";
import { contains, relativePath } from "./filesystem";
import { SourceStore } from "./source-store";
import type { CabinetId, IngestionJobId, IngestionOperation, IngestionStatus, SourceId, SourceLocation, SourceVersionId } from "./types";

type Intent =
  | { operation: "create"; sourceId: SourceId | null; input: SourceLocation; contentHash: string }
  | { operation: "update"; sourceId: SourceId; input: SourceLocation; contentHash: string }
  | { operation: "delete"; sourceId: SourceId; input?: never; contentHash?: never }
  | { operation: "reprocess"; sourceId: SourceId; sourceVersionId: SourceVersionId; input?: never; contentHash?: never };

export type EnqueueInput = Intent & {
  roomPath: string | null;
  /** Stable caller revision: current source generation, or explicit reprocess request ID.
   * Repeated events reuse it; a deliberate new operation uses a new generation.
   */
  generation: string;
  maxAttempts?: number;
};

export interface QueuedJob {
  id: IngestionJobId;
  cabinetId: CabinetId;
  roomPath: string | null;
  sourceId: SourceId | null;
  operation: IngestionOperation;
  generation: string;
  input: SourceLocation | null;
  contentHash: string | null;
  sourceVersionId: SourceVersionId | null;
  status: IngestionStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: number;
  createdAt: string;
  updatedAt: string;
  error: string | null;
}

export interface JobLease { job: QueuedJob; token: string; expiresAt: number }

interface Row {
  id: IngestionJobId; cabinet_id: CabinetId; room_path: string | null;
  source_id: SourceId | null; operation: IngestionOperation; generation: string; input_json: string | null;
  content_hash: string | null; source_version_id: SourceVersionId | null;
  status: IngestionStatus; attempts: number; max_attempts: number; available_at: number;
  created_at: string; updated_at: string; error: string | null;
  lease_token: string | null; lease_expires_at: number | null;
}

function job(row: Row): QueuedJob {
  return {
    id: row.id, cabinetId: row.cabinet_id, roomPath: row.room_path, sourceId: row.source_id,
    operation: row.operation, generation: row.generation, input: row.input_json ? JSON.parse(row.input_json) : null,
    contentHash: row.content_hash, sourceVersionId: row.source_version_id,
    status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts,
    availableAt: row.available_at, createdAt: row.created_at, updatedAt: row.updated_at, error: row.error,
  };
}

function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Invalid queue limit");
  return value;
}

function nonempty(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw new Error("Invalid queue text");
  return value;
}

function normalizedLocation(value: SourceLocation): SourceLocation {
  const inputPath = relativePath(value.path);
  if (value.kind === "cabinet") return { kind: "cabinet", path: inputPath };
  if (value.kind !== "knowledge-mount") throw new Error("Invalid source location");
  return { kind: value.kind, path: inputPath, mountId: nonempty(value.mountId), roomPath: value.roomPath === "." ? "." : relativePath(value.roomPath) };
}

function locationKey(value: SourceLocation): string {
  return JSON.stringify([value.kind, value.kind === "knowledge-mount" ? value.mountId : null,
    value.kind === "knowledge-mount" ? value.roomPath.normalize("NFC").toLowerCase() : null,
    value.path.normalize("NFC").toLowerCase()]);
}

// Source registration happens after entering classifying and before binding its
// ID to the job. A crash in that gap also needs manifest reconciliation.
const writeStages = new Set<IngestionStatus>(["classifying", "promoting", "compiling", "reconciling"]);
const routes: Record<IngestionOperation, IngestionStatus[]> = {
  create: ["normalizing", "classifying", "promoting", "compiling", "complete"],
  update: ["normalizing", "promoting", "reconciling", "complete"],
  reprocess: ["normalizing", "promoting", "reconciling", "complete"],
  delete: ["reconciling", "complete"],
};

/**
 * Durable queue over Cabinet's existing DB, with one leased writer per root.
 * It invokes no converters/providers and performs no source or Wiki mutations.
 */
export class IngestionQueue {
  private constructor(
    private readonly db: Database.Database,
    private readonly root: string,
    readonly cabinetId: CabinetId,
    private readonly clock: () => number,
  ) {}

  static async open(db: Database.Database, root: string, clock = Date.now): Promise<IngestionQueue> {
    const cabinet = await readWikiCabinet(root);
    if (!cabinet) throw new Error("LLM Wiki is not initialized");
    if (await fs.realpath(db.name) !== path.join(cabinet.rootPath, ".cabinet.db")) {
      throw new Error("Queue database does not belong to this root Cabinet");
    }
    // Require the existing migration runner, never create tables ad hoc here.
    db.prepare("SELECT id FROM llm_wiki_jobs LIMIT 0").all();
    return new IngestionQueue(db, cabinet.rootPath, cabinet.cabinetId, clock);
  }

  private async enabled(): Promise<void> {
    const cabinet = await readWikiCabinet(this.root);
    if (!cabinet || cabinet.cabinetId !== this.cabinetId || !cabinet.config.enabled) throw new Error("LLM Wiki is disabled or root identity changed");
  }

  private row(id: IngestionJobId): Row {
    const row = this.db.prepare("SELECT * FROM llm_wiki_jobs WHERE cabinet_id = ? AND id = ?").get(this.cabinetId, id) as Row | undefined;
    if (!row) throw new Error("Ingestion job not found in this Cabinet");
    return row;
  }

  get(id: IngestionJobId): QueuedJob { return job(this.row(id)); }

  list(): QueuedJob[] {
    return (this.db.prepare("SELECT * FROM llm_wiki_jobs WHERE cabinet_id = ? ORDER BY sequence").all(this.cabinetId) as Row[]).map(job);
  }

  attempts(id: IngestionJobId): unknown[] {
    this.row(id);
    return this.db.prepare("SELECT attempt, worker, started_at, ended_at, stage, outcome, error FROM llm_wiki_attempts WHERE job_id = ? ORDER BY attempt").all(id);
  }

  async enqueue(input: EnqueueInput): Promise<QueuedJob> {
    await this.enabled();
    if (!Object.hasOwn(routes, input.operation)) throw new Error("Invalid ingestion operation");
    const room = input.roomPath === null ? null : relativePath(input.roomPath);
    const generation = nonempty(input.generation);
    const limit = bounded(input.maxAttempts ?? 3, 1, 100);
    const store = new SourceStore(this.root);
    if (input.sourceId !== null) opaqueId(input.sourceId);
    if (input.operation !== "create" && !input.sourceId) throw new Error("Source identity required");
    const source = input.sourceId ? await store.get(input.sourceId) : null;
    if (input.sourceId && (!source || source.source.roomPath !== room)) throw new Error("Unknown or differently scoped Source");
    let location: SourceLocation | null = null;
    let hash: string | null = null;
    let version: SourceVersionId | null = null;
    if (input.operation === "create" || input.operation === "update") {
      location = normalizedLocation(input.input);
      hash = input.contentHash;
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("Queue requires a captured/observed SHA-256");
      if (location.kind === "knowledge-mount" && location.roomPath !== (room ?? ".")) throw new Error("Input room mismatch");
      if (location.kind === "cabinet" && room !== null && !contains(room, location.path)) throw new Error("Input outside its room");
      if (input.operation === "update" && (source?.source.mode !== "managed" ||
          locationKey(source.source.managedLocation) !== locationKey(location))) throw new Error("Update must use the registered managed binding");
      if (input.operation === "create") {
        if (source?.source.mode === "managed") {
          if (locationKey(source.source.managedLocation) !== locationKey(location)) throw new Error("Create must use the registered managed binding");
        } else {
          const cabinet = await readWikiCabinet(this.root);
          if (!cabinet || location.kind !== "cabinet" || !contains(cabinet.config.paths.inbox, location.path)) {
            throw new Error("Snapshot creation must originate in the configured Inbox");
          }
        }
      }
    } else {
      if (input.input !== undefined || input.contentHash !== undefined) throw new Error("Operation does not accept file input");
      if (input.operation === "reprocess") {
        version = opaqueId(input.sourceVersionId) as SourceVersionId;
        if (!source?.versions.some((item) => item.id === version)) throw new Error("Unknown SourceVersion");
      }
    }
    const stream = input.sourceId ? `source:${input.sourceId}` : `input:${locationKey(location!)}`;
    const dedup = createHash("sha256").update(JSON.stringify([room, stream, input.operation, hash, version, generation])).digest("hex");
    const now = this.clock();
    const iso = new Date(now).toISOString();
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM llm_wiki_jobs WHERE cabinet_id = ? AND dedup_key = ?").get(this.cabinetId, dedup) as Row | undefined;
      if (prior) return job(prior);
      if (source && input.operation === "create" && source.versions.length) throw new Error("Source already has evidence; use update or reprocess");
      const id = randomUUID() as IngestionJobId;
      this.db.prepare(`INSERT INTO llm_wiki_jobs
        (id,cabinet_id,room_path,source_id,operation,input_json,content_hash,source_version_id,dedup_key,generation,stream_key,status,max_attempts,available_at,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,'queued',?,?,?,?)`).run(id, this.cabinetId, room, input.sourceId,
        input.operation, location ? JSON.stringify(location) : null, hash, version, dedup, generation, stream, limit, now, iso, iso);
      return this.get(id);
    }).immediate();
  }

  /** Safe to call on startup: live leases are left alone; expired writes need review. */
  recoverExpired(): number {
    return this.db.transaction(() => {
      const now = this.clock();
      const rows = this.db.prepare("SELECT * FROM llm_wiki_jobs WHERE cabinet_id = ? AND lease_expires_at <= ?").all(this.cabinetId, now) as Row[];
      for (const row of rows) this.endAttempt(row, "Worker lease expired", now, true);
      return rows.length;
    }).immediate();
  }

  async claim(worker: string, leaseMs = 60_000): Promise<JobLease | null> {
    await this.enabled();
    nonempty(worker);
    bounded(leaseMs, 1000, 3_600_000);
    return this.db.transaction(() => {
      this.recoverExpired();
      const now = this.clock();
      if (this.db.prepare("SELECT id FROM llm_wiki_jobs WHERE cabinet_id = ? AND lease_token IS NOT NULL").get(this.cabinetId)) return null;
      const row = this.db.prepare(`SELECT j.* FROM llm_wiki_jobs j WHERE j.cabinet_id = ? AND j.status = 'queued'
        AND j.available_at <= ? AND NOT EXISTS (SELECT 1 FROM llm_wiki_jobs previous
          WHERE previous.cabinet_id = j.cabinet_id AND previous.stream_key = j.stream_key
          AND previous.sequence < j.sequence AND previous.status != 'complete') ORDER BY j.sequence LIMIT 1`).get(this.cabinetId, now) as Row | undefined;
      if (!row) return null;
      const token = randomUUID();
      const stage = routes[row.operation][0];
      const iso = new Date(now).toISOString();
      this.db.prepare("UPDATE llm_wiki_jobs SET status=?,attempts=attempts+1,lease_token=?,lease_expires_at=?,updated_at=?,error=NULL WHERE id=?").run(stage, token, now + leaseMs, iso, row.id);
      this.db.prepare("INSERT INTO llm_wiki_attempts(job_id,attempt,worker,token,started_at,stage) VALUES (?,?,?,?,?,?)").run(row.id, row.attempts + 1, worker, token, iso, stage);
      return { job: this.get(row.id), token, expiresAt: now + leaseMs };
    }).immediate();
  }

  private leased(id: IngestionJobId, token: string): Row {
    const row = this.row(id);
    if (!token || row.lease_token !== token || row.lease_expires_at === null || row.lease_expires_at <= this.clock()) throw new Error("Expired or stale worker lease");
    return row;
  }

  heartbeat(id: IngestionJobId, token: string, leaseMs = 60_000): number {
    bounded(leaseMs, 1000, 3_600_000);
    return this.db.transaction(() => {
      this.leased(id, token);
      const expiry = this.clock() + leaseMs;
      this.db.prepare("UPDATE llm_wiki_jobs SET lease_expires_at=?,updated_at=? WHERE id=?").run(expiry, new Date(this.clock()).toISOString(), id);
      return expiry;
    }).immediate();
  }

  advance(id: IngestionJobId, token: string, next: IngestionStatus): QueuedJob {
    return this.db.transaction(() => {
      const row = this.leased(id, token);
      const stages = routes[row.operation];
      if (stages[stages.indexOf(row.status) + 1] !== next) throw new Error("Invalid ingestion stage transition");
      if (next === "promoting" && !row.source_id) throw new Error("Bind a Source before promotion");
      const iso = new Date(this.clock()).toISOString();
      if (next === "complete") {
        this.db.prepare("UPDATE llm_wiki_jobs SET status='complete',lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(iso, id);
        this.db.prepare("UPDATE llm_wiki_attempts SET stage=?,ended_at=?,outcome='complete' WHERE token=?").run(next, iso, token);
      } else {
        this.db.prepare("UPDATE llm_wiki_jobs SET status=?,updated_at=? WHERE id=?").run(next, iso, id);
        this.db.prepare("UPDATE llm_wiki_attempts SET stage=? WHERE token=?").run(next, token);
      }
      return this.get(id);
    }).immediate();
  }

  async bindSource(id: IngestionJobId, token: string, sourceId: SourceId): Promise<void> {
    const source = await new SourceStore(this.root).get(sourceId);
    this.db.transaction(() => {
      const row = this.leased(id, token);
      if (!source || source.source.roomPath !== row.room_path || row.operation !== "create" ||
          source.versions.length || row.status !== "classifying" ||
          (row.source_id && row.source_id !== sourceId)) throw new Error("Invalid Source binding");
      if (source.source.mode === "managed" && locationKey(source.source.managedLocation) !== locationKey(JSON.parse(row.input_json!))) {
        throw new Error("Source working binding differs from job input");
      }
      if (this.db.prepare(`SELECT id FROM llm_wiki_jobs WHERE cabinet_id=? AND source_id=?
        AND status != 'complete' AND sequence < (SELECT sequence FROM llm_wiki_jobs WHERE id=?)`).get(this.cabinetId, sourceId, id)) {
        throw new Error("An earlier operation for this Source must be reconciled first");
      }
      this.db.prepare("UPDATE llm_wiki_jobs SET source_id=?,stream_key=?,updated_at=? WHERE id=?").run(sourceId, `source:${sourceId}`, new Date(this.clock()).toISOString(), id);
    }).immediate();
  }

  private endAttempt(row: Row, error: string, now: number, retryable: boolean): void {
    const status = writeStages.has(row.status) ? "needs-review" : retryable && row.attempts < row.max_attempts ? "queued" : "failed";
    const delay = status === "queued" ? Math.min(300_000, 1000 * 2 ** Math.min(row.attempts - 1, 9)) : 0;
    const iso = new Date(now).toISOString();
    this.db.prepare("UPDATE llm_wiki_jobs SET status=?,available_at=?,lease_token=NULL,lease_expires_at=NULL,updated_at=?,error=? WHERE id=?").run(status, now + delay, iso, error, row.id);
    this.db.prepare("UPDATE llm_wiki_attempts SET ended_at=?,outcome=?,error=? WHERE token=?").run(iso, status === "queued" ? "retry" : status, error, row.lease_token);
  }

  fail(id: IngestionJobId, token: string, error: string, retryable = true): QueuedJob {
    nonempty(error);
    return this.db.transaction(() => {
      const row = this.leased(id, token);
      this.endAttempt(row, error, this.clock(), retryable);
      return this.get(id);
    }).immediate();
  }

  /** Trusted connected worker retries the SAME operation through its durable
   * Raw/publication receipts. This never acknowledges a proposed compilation. */
  async resumeReviewed(id: IngestionJobId, expectedUpdatedAt: string): Promise<QueuedJob> {
    await this.enabled();
    return this.db.transaction(() => {
      const row = this.row(id);
      if (!["needs-review", "failed"].includes(row.status) || row.updated_at !== expectedUpdatedAt) throw new Error("Job changed; refresh before retrying");
      const now = this.clock();
      this.db.prepare("UPDATE llm_wiki_jobs SET status='queued',max_attempts=attempts+3,available_at=?,updated_at=?,error=NULL WHERE id=?").run(now, new Date(now).toISOString(), id);
      return this.get(id);
    }).immediate();
  }

  /** Only failed pre-write work can be explicitly retried without reconciliation. */
  async retry(id: IngestionJobId, additionalAttempts = 3, expected?: { updatedAt: string; attempts: number }): Promise<QueuedJob> {
    await this.enabled();
    bounded(additionalAttempts, 1, 100);
    return this.db.transaction(() => {
      const row = this.row(id);
      if (row.status !== "failed") throw new Error("Job requires reconciliation or is not failed");
      if (expected && (row.updated_at !== expected.updatedAt || row.attempts !== expected.attempts)) throw new Error("Retry state changed; inspect again");
      bounded(row.attempts + additionalAttempts, 1, 1_000_000);
      const now = this.clock();
      this.db.prepare("UPDATE llm_wiki_jobs SET status='queued',max_attempts=?,available_at=?,updated_at=?,error=NULL WHERE id=?").run(row.attempts + additionalAttempts, now, new Date(now).toISOString(), id);
      return this.get(id);
    }).immediate();
  }
}
