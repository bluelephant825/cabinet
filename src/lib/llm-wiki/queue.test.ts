import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import yaml from "js-yaml";
import { runSqlMigrations } from "../system/sql-migrations";
import { initializeWikiCabinet, setWikiEnabled } from "./config";
import { IngestionQueue, type EnqueueInput } from "./queue";
import { SourceStore } from "./source-store";
import type { IngestionJobId, SourceId, SourceVersionId } from "./types";

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-ingestion-queue-"));
  await fs.writeFile(path.join(root, ".cabinet"), "kind: root\nname: Queue test\n");
  await initializeWikiCabinet(root, { enabled: true });
  const connections: Database.Database[] = [];
  const connect = () => {
    const db = new Database(path.join(root, ".cabinet.db"));
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    connections.push(db);
    return db;
  };
  t.after(async () => {
    for (const db of connections) if (db.open) db.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const db = connect();
  const migrations = path.resolve("server/migrations");
  runSqlMigrations(db, migrations);
  let now = Date.parse("2026-09-11T00:00:00.000Z");
  const clock = () => now;
  const queue = await IngestionQueue.open(db, root, clock);
  return { root, db, queue, connect, clock, tick: (ms: number) => { now += ms; }, migrations };
}

function create(file = "article.html", generation = "initial"): EnqueueInput & { operation: "create" } {
  return {
    operation: "create", sourceId: null, roomPath: null,
    input: { kind: "cabinet", path: `Inbox/${file}` }, contentHash: "a".repeat(64), generation,
  };
}

async function snapshot(root: string) {
  return new SourceStore(root).register({ mode: "snapshot", roomPath: null, classification: "research", title: "Article" });
}

test("queue migration is repeatable and preserves unrelated database records", async (t) => {
  const { db, migrations } = await fixture(t);
  db.prepare("INSERT INTO sessions(id,agent_slug) VALUES ('existing','agent')").run();
  runSqlMigrations(db, migrations);
  assert.equal((db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM schema_version WHERE version=5").get() as { n: number }).n, 1);
});

test("agent-ops migration preserves attempts rows without foreign-key violations", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cabinet-migration-006-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true }));
  const onlyFive = path.join(root, "migrations-005");
  await fs.mkdir(onlyFive);
  await fs.copyFile(path.resolve("server/migrations/005_llm_wiki_queue.sql"), path.join(onlyFive, "005_llm_wiki_queue.sql"));
  const db = new Database(path.join(root, ".cabinet.db"));
  t.after(async () => { if (db.open) db.close(); });
  db.pragma("foreign_keys = ON");
  runSqlMigrations(db, onlyFive);
  db.prepare(`INSERT INTO llm_wiki_jobs(id,cabinet_id,operation,input_json,content_hash,dedup_key,generation,stream_key,status,max_attempts,available_at,created_at,updated_at)
    VALUES ('job-1','cab','create','{}','${"a".repeat(64)}','dedup-1','gen','stream','queued',3,0,'2026-01-01','2026-01-01')`).run();
  db.prepare(`INSERT INTO llm_wiki_attempts(job_id,attempt,worker,token,started_at,stage)
    VALUES ('job-1',1,'worker','token','2026-01-01','queued')`).run();
  runSqlMigrations(db, path.resolve("server/migrations"));
  assert.equal((db.prepare("SELECT count(*) AS n FROM llm_wiki_jobs").get() as { n: number }).n, 1);
  assert.equal((db.prepare("SELECT count(*) AS n FROM llm_wiki_attempts").get() as { n: number }).n, 1);
  assert.match((db.prepare("SELECT sql FROM sqlite_master WHERE name='llm_wiki_attempts'").get() as { sql: string }).sql, /REFERENCES "llm_wiki_jobs"/);
  assert.deepEqual(db.pragma("foreign_key_check"), []);
});

test("migration rechecks a stale pending list after another connection commits", async (t) => {
  const f = await fixture(t);
  f.db.exec("DROP TABLE llm_wiki_attempts; DROP TABLE llm_wiki_jobs; DELETE FROM schema_version WHERE version=5");
  const peer = f.connect();
  // Deterministically place the peer's migration between the first runner's
  // pending-list read and its write transaction, as at concurrent startup.
  const racingConnection = new Proxy(f.db, {
    get(target, key) {
      if (key === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (sql !== "SELECT version FROM schema_version ORDER BY version") return statement;
        return { all: () => {
          const stale = statement.all();
          runSqlMigrations(peer, f.migrations);
          return stale;
        } };
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  assert.doesNotThrow(() => runSqlMigrations(racingConnection, f.migrations));
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM schema_version WHERE version=5").get() as { n: number }).n, 1);
});

test("duplicate requests converge across connections and process restart", async (t) => {
  const f = await fixture(t);
  const first = await f.queue.enqueue(create());
  const peer = await IngestionQueue.open(f.connect(), f.root, f.clock);
  assert.equal((await peer.enqueue(create())).id, first.id);
  f.db.close();
  const restarted = await IngestionQueue.open(f.connect(), f.root, f.clock);
  assert.equal(restarted.get(first.id).status, "queued");
  assert.equal((await restarted.enqueue(create())).id, first.id);
  assert.equal(restarted.list().length, 1);
});

test("deduplication distinguishes inputs, content and deliberate operation generations", async (t) => {
  const { queue } = await fixture(t);
  const a = await queue.enqueue(create());
  const b = await queue.enqueue(create("other.html"));
  const c = await queue.enqueue({ ...create(), contentHash: "b".repeat(64) } as EnqueueInput);
  const d = await queue.enqueue(create("article.html", "new-operation"));
  assert.equal(new Set([a.id, b.id, c.id, d.id]).size, 4);
});

test("two connections cannot claim the same job or lease two writers in one root", async (t) => {
  const f = await fixture(t);
  await f.queue.enqueue(create());
  await f.queue.enqueue(create("other.html"));
  const peer = await IngestionQueue.open(f.connect(), f.root, f.clock);
  const claims = await Promise.all([f.queue.claim("one"), peer.claim("two")]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(f.queue.list().filter((j) => j.status === "normalizing").length, 1);
});

test("expired read-only work retries with backoff and rejects stale workers", async (t) => {
  const f = await fixture(t);
  const row = await f.queue.enqueue(create());
  const first = (await f.queue.claim("one", 1000))!;
  f.tick(1000);
  assert.equal(f.queue.recoverExpired(), 1);
  assert.equal(f.queue.get(row.id).status, "queued");
  assert.equal(await f.queue.claim("two"), null);
  assert.throws(() => f.queue.heartbeat(row.id, first.token), /lease/);
  assert.throws(() => f.queue.advance(row.id, first.token, "classifying"), /lease/);
  f.tick(1000);
  const second = (await f.queue.claim("two"))!;
  assert.notEqual(second.token, first.token);
  assert.equal(second.job.attempts, 2);
  assert.equal(f.queue.attempts(row.id).length, 2);
  assert.throws(() => f.queue.fail(row.id, first.token, "late failure"), /lease/);
});

test("heartbeat preserves a live lease across restart and recovery", async (t) => {
  const f = await fixture(t);
  await f.queue.enqueue(create());
  const lease = (await f.queue.claim("one", 1000))!;
  f.tick(500);
  f.queue.heartbeat(lease.job.id, lease.token, 5000);
  f.db.close();
  f.tick(1000);
  const restarted = await IngestionQueue.open(f.connect(), f.root, f.clock);
  assert.equal(restarted.recoverExpired(), 0);
  assert.equal(await restarted.claim("two"), null);
});

test("retries are bounded, retain attempt history, and require explicit retry after exhaustion", async (t) => {
  const f = await fixture(t);
  const row = await f.queue.enqueue({ ...create(), maxAttempts: 2 });
  let lease = (await f.queue.claim("one"))!;
  f.queue.fail(row.id, lease.token, "converter unavailable");
  f.tick(1000);
  lease = (await f.queue.claim("one"))!;
  assert.equal(f.queue.fail(row.id, lease.token, "still unavailable").status, "failed");
  assert.equal(await f.queue.claim("one"), null);
  assert.equal((await f.queue.enqueue(create())).status, "failed");
  await f.queue.retry(row.id, 1);
  assert.equal((await f.queue.claim("one"))?.job.attempts, 3);
  assert.equal(f.queue.attempts(row.id).length, 3);
});

test("interrupted promotion is parked for reconciliation, never blindly retried", async (t) => {
  const f = await fixture(t);
  const row = await f.queue.enqueue(create());
  const lease = (await f.queue.claim("one", 1000))!;
  f.queue.advance(row.id, lease.token, "classifying");
  assert.throws(() => f.queue.advance(row.id, lease.token, "promoting"), /Bind/);
  const source = await snapshot(f.root);
  await f.queue.bindSource(row.id, lease.token, source.source.id);
  f.queue.advance(row.id, lease.token, "promoting");
  f.db.close();
  f.tick(1000);
  const reopened = await IngestionQueue.open(f.connect(), f.root, f.clock);
  assert.equal(reopened.recoverExpired(), 1);
  assert.equal(reopened.get(row.id).status, "needs-review");
  assert.equal(reopened.get(row.id).sourceId, source.source.id);
  await assert.rejects(reopened.retry(row.id), /reconciliation/);
  assert.equal(await reopened.claim("two"), null);
});

test("complete follows the operation stages and records a durable completion", async (t) => {
  const f = await fixture(t);
  const source = await snapshot(f.root);
  const row = await f.queue.enqueue({ ...create(), sourceId: source.source.id });
  const lease = (await f.queue.claim("one"))!;
  assert.throws(() => f.queue.advance(row.id, lease.token, "complete"), /transition/);
  for (const stage of ["classifying", "promoting", "compiling", "linking", "complete"] as const) f.queue.advance(row.id, lease.token, stage);
  assert.equal(f.queue.get(row.id).status, "complete");
  assert.throws(() => f.queue.advance(row.id, lease.token, "complete"), /lease/);
  assert.equal((await f.queue.enqueue({ ...create(), sourceId: source.source.id })).id, row.id);
  assert.deepEqual((f.queue.attempts(row.id)[0] as { outcome: string }).outcome, "complete");
});

test("failure blocks later same-source operations but unrelated sources can proceed", async (t) => {
  const f = await fixture(t);
  const source = await snapshot(f.root);
  const first = await f.queue.enqueue({ ...create(), sourceId: source.source.id });
  const later = await f.queue.enqueue({ operation: "delete", sourceId: source.source.id, roomPath: null, generation: "delete-1" });
  const independent = await f.queue.enqueue(create("other.html"));
  const lease = (await f.queue.claim("one"))!;
  f.queue.fail(first.id, lease.token, "invalid input", false);
  assert.equal((await f.queue.claim("two"))?.job.id, independent.id);
  assert.equal(f.queue.get(later.id).status, "queued");
});

test("consolidate and lint need no Source identity and route through linking", async (t) => {
  const f = await fixture(t);
  for (const operation of ["consolidate", "lint"] as const) {
    const row = await f.queue.enqueue({ operation, sourceId: null, roomPath: null, generation: `${operation}-1` });
    assert.equal(row.sourceId, null);
    assert.equal(row.input, null);
    const lease = (await f.queue.claim("one"))!;
    assert.equal(lease.job.status, "linking");
    f.queue.advance(row.id, lease.token, "complete");
    assert.equal(f.queue.get(row.id).status, "complete");
  }
  await assert.rejects(f.queue.enqueue({ operation: "consolidate", sourceId: null, roomPath: null, generation: "x",
    input: { kind: "cabinet", path: "a.md" } } as unknown as EnqueueInput), /file input/);
  await assert.rejects(f.queue.enqueue({ operation: "consolidate", sourceId: null, roomPath: null, generation: "x",
    contentHash: "a".repeat(64) } as unknown as EnqueueInput), /file input/);
});

test("a needs-review consolidate does not block a new consolidate", async (t) => {
  const f = await fixture(t);
  const first = await f.queue.enqueue({ operation: "consolidate", sourceId: null, roomPath: null, generation: "c1" });
  await assert.rejects(f.queue.enqueue({ operation: "consolidate", sourceId: null, roomPath: null, generation: "c2" }), /already queued or running/);
  const lease = (await f.queue.claim("one"))!;
  f.queue.fail(first.id, lease.token, "agent failed");
  assert.equal(f.queue.get(first.id).status, "needs-review");
  const second = await f.queue.enqueue({ operation: "consolidate", sourceId: null, roomPath: null, generation: "c2" });
  assert.equal(second.status, "queued");
});

test("deletion needs no working file and any interrupted reconciliation needs review", async (t) => {
  const f = await fixture(t);
  const source = await snapshot(f.root);
  const row = await f.queue.enqueue({ operation: "delete", sourceId: source.source.id, roomPath: null, generation: "delete-1" });
  assert.equal(row.input, null);
  const lease = (await f.queue.claim("one"))!;
  assert.equal(lease.job.status, "reconciling");
  assert.equal(f.queue.fail(row.id, lease.token, "model failed").status, "needs-review");
  assert.equal((await new SourceStore(f.root).get(source.source.id))?.source.status, "active");
});

test("update validates registered binding; reprocess validates the selected captured version", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.root, "notes"));
  await fs.writeFile(path.join(f.root, "notes/a.md"), "original");
  const source = await new SourceStore(f.root).register({ mode: "managed", managedLocation: { kind: "cabinet", path: "notes/a.md" }, roomPath: null, title: "A", classification: "research" });
  const update: EnqueueInput = { operation: "update", sourceId: source.source.id, roomPath: null, generation: "v1", input: { kind: "cabinet", path: "notes/a.md" }, contentHash: "a".repeat(64) };
  await f.queue.enqueue(update);
  await assert.rejects(f.queue.enqueue({ ...update, input: { kind: "cabinet" as const, path: "notes/b.md" } }), /binding/);
  const versionId = randomUUID() as SourceVersionId;
  const reprocess: EnqueueInput = { operation: "reprocess", sourceId: source.source.id, sourceVersionId: versionId, roomPath: null, generation: "converter-v2" };
  await assert.rejects(f.queue.enqueue(reprocess), /SourceVersion/);
  await fs.writeFile(path.join(f.root, source.source.rawPath, "manifest.yaml"), yaml.dump({
    ...source, source: { ...source.source, currentVersionId: versionId },
    versions: [{ id: versionId, sourceId: source.source.id, cabinetId: source.source.cabinetId, version: 1,
      contentHash: "a".repeat(64), originalFormat: "md", createdAt: new Date().toISOString(),
      originalPath: `${source.source.rawPath}/v1/original.md`, markdownPath: `${source.source.rawPath}/v1/source.md` }],
  }));
  await fs.unlink(path.join(f.root, "notes/a.md"));
  assert.equal((await f.queue.enqueue(reprocess)).sourceVersionId, versionId);
});

test("feature disable blocks new work while allowing a leased worker to finish bookkeeping", async (t) => {
  const f = await fixture(t);
  const row = await f.queue.enqueue(create());
  const lease = (await f.queue.claim("one"))!;
  await setWikiEnabled(f.root, false);
  await assert.rejects(f.queue.enqueue(create("other.html")), /disabled/);
  await assert.rejects(f.queue.claim("two"), /disabled/);
  f.queue.fail(row.id, lease.token, "stopped", false);
  assert.equal(f.queue.get(row.id).status, "failed");
});

test("invalid limits, foreign sources, paths, scopes, and database roots fail before enqueue", async (t) => {
  const f = await fixture(t);
  const other = await fixture(t);
  const foreign = await snapshot(other.root);
  await assert.rejects(IngestionQueue.open(f.db, other.root), /database/);
  for (const bad of [
    { ...create(), sourceId: foreign.source.id },
    { ...create(), sourceId: "bad" as SourceId },
    { ...create(), contentHash: "bad" },
    { ...create(), maxAttempts: 0 },
    { ...create(), generation: "" },
    { ...create(), roomPath: "room" },
    { ...create(), input: { kind: "cabinet", path: "../escape" } },
    { ...create(), input: { kind: "cabinet", path: "raw/a.md" } },
  ]) await assert.rejects(f.queue.enqueue(bad as EnqueueInput));
  assert.equal(f.queue.list().length, 0);
  assert.throws(() => f.queue.get(randomUUID() as IngestionJobId), /Cabinet/);
});

test("a crash between source registration and job binding cannot automatically create a duplicate", async (t) => {
  const f = await fixture(t);
  const row = await f.queue.enqueue(create());
  const lease = (await f.queue.claim("one", 1000))!;
  f.queue.advance(row.id, lease.token, "classifying");
  const source = await snapshot(f.root);
  // Simulate process death before bindSource persists the newly registered ID.
  f.tick(1000);
  f.queue.recoverExpired();
  assert.equal(f.queue.get(row.id).status, "needs-review");
  assert.equal(f.queue.get(row.id).sourceId, null);
  assert.equal((await new SourceStore(f.root).list()).length, 1);
  assert.equal((await new SourceStore(f.root).get(source.source.id))?.source.id, source.source.id);
  await assert.rejects(f.queue.retry(row.id), /reconciliation/);
});

test("deduplication still returns the original create job after evidence has been recorded", async (t) => {
  const f = await fixture(t);
  const source = await snapshot(f.root);
  const request = { ...create(), sourceId: source.source.id };
  const row = await f.queue.enqueue(request);
  const versionId = randomUUID();
  await fs.writeFile(path.join(f.root, source.source.rawPath, "manifest.yaml"), yaml.dump({
    ...source, source: { ...source.source, currentVersionId: versionId },
    versions: [{ id: versionId, sourceId: source.source.id, cabinetId: source.source.cabinetId, version: 1,
      contentHash: "a".repeat(64), originalFormat: "html", createdAt: new Date().toISOString(),
      originalPath: `${source.source.rawPath}/v1/original.html`, markdownPath: `${source.source.rawPath}/v1/source.md` }],
  }));
  assert.equal((await f.queue.enqueue(request)).id, row.id);
  await assert.rejects(f.queue.enqueue({ ...request, generation: "another-create" }), /already has evidence/);
});

import { IngestionRecoveryService } from "./recovery";
import { RawPublicationStore } from "./raw-publication";
import { SourceNormalizationService } from "./normalizers";
import { createHash } from "node:crypto";

test("recovery distinguishes failed pre-write retries from interrupted write review and stale actions", async (t) => {
  const f = await fixture(t), recovery = new IngestionRecoveryService(f.root, f.queue);
  const job = await f.queue.enqueue({ ...create(), maxAttempts: 1 });
  const lease = (await f.queue.claim("worker"))!;
  f.queue.fail(job.id, lease.token, "Converter unavailable", false);
  const report = await recovery.inspect(job.id);
  assert.equal(report.action, "retry");
  assert.equal((await recovery.retry(job.id, report.fingerprint)).status, "queued");
  await assert.rejects(recovery.retry(job.id, report.fingerprint), /state changed/);
  const second = (await f.queue.claim("worker"))!;
  f.queue.advance(job.id, second.token, "classifying");
  f.queue.fail(job.id, second.token, "Classification interrupted", false);
  const review = await recovery.inspect(job.id);
  assert.equal(review.action, "review");
  await assert.rejects(recovery.retry(job.id, review.fingerprint), /without review/);
});

test("receipt recovery resumes staged Raw without marking the interrupted queue job complete", async (t) => {
  const f = await fixture(t), recovery = new IngestionRecoveryService(f.root, f.queue);
  const source = await snapshot(f.root), bytes = Buffer.from("# Evidence\nPreserved original.\n");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const input = await new SourceNormalizationService().normalize({ path: "article.md", bytes, contentHash: digest });
  const job = await f.queue.enqueue({ operation: "create", input: { kind: "cabinet", path: "Inbox/article.md" }, roomPath: null, generation: "initial", sourceId: source.source.id, contentHash: digest });
  const lease = (await f.queue.claim("worker"))!;
  f.queue.advance(job.id, lease.token, "classifying");
  f.queue.advance(job.id, lease.token, "promoting");
  await assert.rejects(new RawPublicationStore(f.root, async (point) => { if (point === "staged") throw new Error("Power interruption"); }).publishInitial(source.source.id, input), /Power interruption/);
  f.queue.fail(job.id, lease.token, "Power interruption");
  const report = await recovery.inspect(job.id);
  assert.equal(report.action, "review-raw");
  assert.equal(report.currentVersion, null);
  const recovered = await recovery.recoverRaw(job.id, report.fingerprint, 1);
  assert.equal(recovered.status, "raw-recovered");
  assert.equal(recovered.queueStatus, "needs-review");
  assert.equal(recovered.wikiPublication, "not-completed");
  const manifest = (await new SourceStore(f.root).get(source.source.id))!;
  assert.equal(manifest.versions.length, 1);
  assert.equal(manifest.source.lastCompiledVersionId, null);
  assert.deepEqual(await fs.readFile(path.join(f.root, manifest.versions[0].originalPath)), bytes);
  await assert.rejects(recovery.recoverRaw(job.id, report.fingerprint, 1), /state changed/);
});

test("lease recovery preserves live work and directs expired compilation to fresh planning", async (t) => {
  const f = await fixture(t), recovery = new IngestionRecoveryService(f.root, f.queue);
  const source = await snapshot(f.root);
  const job = await f.queue.enqueue(create());
  const lease = (await f.queue.claim("worker", 1000))!;
  assert.equal(await recovery.recoverExpiredLeases(), 0);
  f.queue.advance(job.id, lease.token, "classifying");
  await f.queue.bindSource(job.id, lease.token, source.source.id);
  f.queue.advance(job.id, lease.token, "promoting");
  f.queue.advance(job.id, lease.token, "compiling");
  f.tick(1001);
  assert.equal(await recovery.recoverExpiredLeases(), 1);
  assert.equal((await recovery.inspect(job.id)).job.status, "needs-review");
  assert.equal((await recovery.inspect(job.id)).action, "recompile");
  await setWikiEnabled(f.root, false);
  await assert.rejects(recovery.recoverExpiredLeases(), /disabled/);
});
