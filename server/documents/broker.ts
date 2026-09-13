/**
 * DocumentBroker — the daemon-side coordinator for document work:
 *
 *  - per-canonical-path async mutex (serializes ALL mutations to a file)
 *  - open-session registry (30-minute idle expiry, swept periodically)
 *  - job registry (queued → running → done/failed/cancelled)
 *  - bounded pool of worker child processes speaking JSON-lines over stdio
 *    (see worker.ts). Bytes never cross the channel — workers read/write
 *    broker-owned temp files and return metadata only.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import readline from "node:readline";
import { createRequire } from "node:module";
import { workerEntry } from "./worker";
import { revisionOf } from "../../src/lib/documents/revision";
import { DocumentError } from "../../src/lib/documents/errors";
import type { DocumentErrorCode } from "../../src/lib/documents/errors";
import type {
  DocumentFormat,
  JobInfo,
  JobResult,
  JobStatus,
} from "../../src/lib/documents/types";

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_CONCURRENCY = 2;

export interface DocumentSession {
  sessionId: string;
  virtualPath: string;
  absPath: string;
  format: DocumentFormat;
  revision: string;
  openedAt: Date;
  lastSeenAt: Date;
}

export interface DocumentJob {
  jobId: string;
  kind: string;
  status: JobStatus;
  progress?: number;
  result?: JobResult;
  error?: { code: DocumentErrorCode; message: string };
  createdAt: Date;
  /** Set when a worker is actively running this job (cancel kills it). */
  worker?: WorkerHandle;
  outputPaths?: string[];
}

interface PendingRequest {
  id: number;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  job?: DocumentJob;
}

interface WorkerHandle {
  child: ChildProcess;
  busy: boolean;
  pending: Map<number, PendingRequest>;
  rl: readline.Interface;
}

interface QueuedCall {
  op: string;
  args: Record<string, unknown>;
  job?: DocumentJob;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class DocumentBroker {
  readonly sessions = new Map<string, DocumentSession>();
  readonly jobs = new Map<string, DocumentJob>();
  private workers: WorkerHandle[] = [];
  private queue: QueuedCall[] = [];
  private locks = new Map<string, Promise<void>>();
  private nextRequestId = 1;
  private sweeper: ReturnType<typeof setInterval> | null = null;
  private shuttingDown = false;
  private revisionCache = new Map<string, { size: number; mtimeMs: number; revision: string }>();
  /** Fired on every job status transition (queued/running/done/failed/cancelled). */
  onJobChange?: (job: DocumentJob) => void;

  constructor(private readonly opts: { concurrency?: number } = {}) {}

  get concurrency(): number {
    const env = Number.parseInt(process.env.CABINET_DOC_WORKERS ?? "", 10);
    return this.opts.concurrency ?? (Number.isFinite(env) && env > 0 ? env : DEFAULT_CONCURRENCY);
  }

  start(): void {
    this.sweeper ??= setInterval(() => this.sweepSessions(), SWEEP_INTERVAL_MS);
    this.sweeper.unref();
  }

  /** Serialize all mutations against one canonical file path. */
  async withPathLock<T>(absPath: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(absPath) ?? Promise.resolve();
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const chained = prior.then(() => gate);
    this.locks.set(absPath, chained);
    await prior;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(absPath) === chained) this.locks.delete(absPath);
    }
  }

  openSession(init: Omit<DocumentSession, "sessionId" | "openedAt" | "lastSeenAt">): DocumentSession {
    const session: DocumentSession = {
      ...init,
      sessionId: randomUUID(),
      openedAt: new Date(),
      lastSeenAt: new Date(),
    };
    this.sessions.set(session.sessionId, session);
    return session;
  }

  touchSession(sessionId: string): DocumentSession {
    const s = this.sessions.get(sessionId);
    if (!s) throw new DocumentError("not-found", "Document session not found or expired");
    s.lastSeenAt = new Date();
    return s;
  }

  closeSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Cheap revision lookup: recompute the sha only when the file's size or
   * mtime changed since the cached read — polling stays cheap for big PDFs.
   */
  async revisionFor(absPath: string): Promise<{ size: number; mtimeMs: number; revision: string }> {
    const stat = await fs.stat(absPath).catch(() => null);
    if (!stat) throw new DocumentError("not-found", "Document does not exist");
    const cached = this.revisionCache.get(absPath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached;
    }
    const bytes = await fs.readFile(absPath);
    const entry = { size: stat.size, mtimeMs: stat.mtimeMs, revision: revisionOf(bytes) };
    this.revisionCache.set(absPath, entry);
    return entry;
  }

  /** After a successful commit, trust the returned revision instead of re-hashing. */
  async recordCommit(absPath: string, revision: string, size: number): Promise<void> {
    const stat = await fs.stat(absPath).catch(() => null);
    this.revisionCache.set(absPath, {
      size,
      mtimeMs: stat?.mtimeMs ?? Date.now(),
      revision,
    });
  }

  private sweepSessions(): void {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, s] of this.sessions) {
      if (s.lastSeenAt.getTime() < cutoff) this.sessions.delete(id);
    }
  }

  /** Broker-owned temp file for a worker output, in the same directory as the target. */
  tempPathFor(targetAbsPath: string): string {
    return path.join(
      path.dirname(targetAbsPath),
      `.${path.basename(targetAbsPath)}.${randomUUID().slice(0, 12)}.docwork`,
    );
  }

  /** Broker-owned temp file in the OS temp dir (staging areas not tied to a target). */
  scratchTempPath(suffix = ".tmp"): string {
    return path.join(os.tmpdir(), `cabinet-doc-${process.pid}-${randomUUID()}${suffix}`);
  }

  createJob(kind: string, outputPaths: string[] = []): DocumentJob {
    const job: DocumentJob = {
      jobId: randomUUID(),
      kind,
      status: "queued",
      createdAt: new Date(),
      outputPaths,
    };
    this.jobs.set(job.jobId, job);
    return job;
  }

  jobInfo(jobId: string): JobInfo {
    const job = this.jobs.get(jobId);
    if (!job) throw new DocumentError("not-found", `Job not found: ${jobId}`);
    return {
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
      progress: job.progress,
      result: job.result,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
    };
  }

  cancelJob(jobId: string): JobInfo {
    const job = this.jobs.get(jobId);
    if (!job) throw new DocumentError("not-found", `Job not found: ${jobId}`);
    if (job.status === "done" || job.status === "failed" || job.status === "cancelled") {
      return this.jobInfo(jobId);
    }
    job.status = "cancelled";
    job.error = { code: "cancelled", message: "Cancelled" };
    this.onJobChange?.(job);
    if (job.worker) {
      // Kill the running request: the worker is discarded and respawned on demand.
      killWorker(job.worker, this.workers);
      this.failWorkerPending(job.worker);
    }
    void this.cleanupOutputs(job);
    this.drainQueue();
    return this.jobInfo(jobId);
  }

  markJobRecorded(jobId: string): JobInfo {
    const job = this.jobs.get(jobId);
    if (!job) throw new DocumentError("not-found", `Job not found: ${jobId}`);
    job.result = { ...(job.result ?? {}), mutationRecorded: true };
    return this.jobInfo(jobId);
  }

  private async cleanupOutputs(job: DocumentJob): Promise<void> {
    for (const p of job.outputPaths ?? []) {
      await fs.rm(p, { force: true }).catch(() => {});
    }
  }

  /** Run a worker op. With `job`, the request is bound to the job lifecycle. */
  run(op: string, args: Record<string, unknown>, job?: DocumentJob): Promise<unknown> {
    if (this.shuttingDown) {
      return Promise.reject(new DocumentError("busy", "Document service is shutting down"));
    }
    return new Promise((resolve, reject) => {
      this.queue.push({ op, args, job, resolve, reject });
      this.drainQueue();
    });
  }

  private drainQueue(): void {
    while (this.queue.length > 0) {
      const call = this.queue[0]!;
      if (call.job && call.job.status === "cancelled") {
        this.queue.shift();
        call.reject(new DocumentError("cancelled", "Cancelled"));
        continue;
      }
      let worker = this.workers.find((w) => !w.busy);
      if (!worker) {
        if (this.workers.length >= this.concurrency) return;
        worker = this.spawnWorker();
      }
      this.queue.shift();
      this.dispatch(worker, call);
    }
  }

  private spawnWorker(): WorkerHandle {
    const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
    const entry = workerEntry();
    const child = spawn(process.execPath, [tsxCli, entry], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, CABINET_DOC_WORKER: "1" },
    });
    const handle: WorkerHandle = {
      child,
      busy: false,
      pending: new Map(),
      rl: readline.createInterface({ input: child.stdout! }),
    };
    handle.rl.on("line", (line) => {
      const t = line.trim();
      if (!t) return;
      let msg: { id: number; ok: boolean; result?: unknown; error?: { code: DocumentErrorCode; message: string; details?: Record<string, unknown> } };
      try {
        msg = JSON.parse(t);
      } catch {
        return;
      }
      const req = handle.pending.get(msg.id);
      if (!req) return;
      handle.pending.delete(msg.id);
      if (handle.pending.size === 0) handle.busy = false;
      if (msg.ok) req.resolve(msg.result);
      else req.reject(new DocumentError(msg.error?.code ?? "worker-failed", msg.error?.message ?? "Worker error", msg.error?.details));
      this.drainQueue();
    });
    child.on("exit", () => {
      killWorker(handle, this.workers);
      this.failWorkerPending(handle);
      this.drainQueue();
    });
    this.workers.push(handle);
    return handle;
  }

  private failWorkerPending(handle: WorkerHandle): void {
    for (const req of handle.pending.values()) {
      if (req.job && req.job.status !== "cancelled") {
        req.job.status = "failed";
        req.job.error = { code: "worker-failed", message: "Document worker exited unexpectedly" };
        this.onJobChange?.(req.job);
      }
      req.reject(new DocumentError("worker-failed", "Document worker exited unexpectedly"));
    }
    handle.pending.clear();
    handle.busy = false;
  }

  private dispatch(worker: WorkerHandle, call: QueuedCall): void {
    if (call.job) {
      call.job.status = "running";
      call.job.worker = worker;
      this.onJobChange?.(call.job);
    }
    worker.busy = true;
    const id = this.nextRequestId++;
    worker.pending.set(id, { id, resolve: call.resolve, reject: call.reject, job: call.job });
    worker.child.stdin!.write(`${JSON.stringify({ id, op: call.op, args: call.args })}\n`);
  }

  stats(): { workers: number; sessions: number; jobs: number; queue: number } {
    return {
      workers: this.workers.length,
      sessions: this.sessions.size,
      jobs: this.jobs.size,
      queue: this.queue.length,
    };
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    if (this.sweeper) clearInterval(this.sweeper);
    for (const call of this.queue.splice(0)) {
      call.reject(new DocumentError("cancelled", "Document service shutting down"));
    }
    await Promise.all(
      this.workers.map(async (w) => {
        w.rl.close();
        const exited = new Promise<void>((r) => w.child.once("exit", () => r()));
        w.child.kill("SIGTERM");
        await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 3000))]);
        if (w.child.exitCode === null) w.child.kill("SIGKILL");
      }),
    );
    this.workers = [];
  }
}

function killWorker(handle: WorkerHandle, pool: WorkerHandle[]): void {
  handle.rl.close();
  if (handle.child.exitCode === null && !handle.child.killed) handle.child.kill("SIGKILL");
  const i = pool.indexOf(handle);
  if (i >= 0) pool.splice(i, 1);
}
