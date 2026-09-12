# LLM Wiki Phase 3: durable ingestion queue

Implemented on 2026-09-11, following the plan's updated implementation sequence.
This phase adds persistent queue operations, not workers or watchers.

## Storage and entry points

`server/migrations/005_llm_wiki_queue.sql` adds `llm_wiki_jobs` and
`llm_wiki_attempts` through Cabinet's existing migration runner. Jobs contain
intent, source/root/room identity, expected input hash or captured version ID,
deduplication key, operation generation, stage, retry budget, availability time,
lease, timestamps, and errors. Attempts retain worker identity, stage, start/end
times, and outcome. Neither table is a rebuildable search cache.

The migration creates empty tables when the existing application migration
runner next executes, including when the feature is disabled. It does not enqueue
work, change source manifests, or touch existing tables' data. Electron staging
already copies the complete migrations directory; no packaging change is needed.

The shared migration runner now rechecks each version within an immediate write
transaction. This handles the app and daemon both discovering the same pending
migration before either commits, without duplicate DDL or version inserts.

`src/lib/llm-wiki/queue.ts` implements `IngestionQueue`. Opening it requires the
configured root and a migrated connection to that root's existing `.cabinet.db`.
It rejects a connection belonging to a different root or an in-memory database.
Tests use real temporary SQLite files with WAL and two independent connections.

`server/ingestion/queue.ts::openActiveIngestionQueue()` is the future daemon
entry point. It reuses `server/db.ts`, respects the feature gate, opens the active
root's queue, and reconciles expired leases. It is not called by daemon startup
yet, because no ingestion worker exists. `claim()` also performs expiry recovery.

## Queue contract

- `enqueue()` validates root/room/source ownership, operation payload, configured
  Inbox location for snapshot creation, and registered managed binding for
  updates or initial managed capture. Reprocessing must reference a version in
  that Source's manifest. Deletion does not read a missing working file.
- Create/update jobs require a SHA-256 before enqueueing. Discovery and write
  stabilization remain watcher/capture responsibilities; unhashed `discovered`
  domain records are not runnable queue jobs.
- The caller supplies a stable `generation`: repeated notifications for the same
  observed revision reuse it, while a deliberate new operation uses a new one.
  For managed updates this should reflect the predecessor/source generation;
  explicit reprocessing can use a persistent request ID or converter-policy
  generation. This prevents a future A-to-B-to-A edit from being suppressed by
  an old completed operation solely because the bytes match.
- Deduplication includes root, room, logical source (or input binding before
  identity assignment), operation, content hash/version, and generation. An
  existing queued, failed, review-needed, or completed request returns the same
  job. It does not silently reset its retry budget. Different logical Sources
  with identical bytes are not merged.
- `get()`, `list()`, and `attempts()` expose durable state scoped to the opened
  root. They remain available when the feature is disabled.

Input hashes are expected hashes, not proof that files have already been safely
captured. The future worker must authorize the location again, capture the exact
input it will convert, and verify its hash. The queue does not snapshot input
bytes, follow filesystem links, or resolve external mounts. Evidence integrity,
changed/disappeared inputs, and staging cleanup remain capture responsibilities.

## Leases, ordering, and transitions

`claim(worker, leaseMs)` uses an immediate SQLite transaction and a database
constraint to allow one leased ingestion job per root. This conservative initial
limit also serializes future Wiki publication within this queue. Other Cabinet
tasks and external file writers are not constrained by it.

Each claim increments the attempt count and creates a new unguessable lease
token. `heartbeat()`, `advance()`, `fail()`, and `bindSource()` reject expired or
stale tokens. A late worker cannot complete or renew a job reassigned to another
worker. Tokens fence queue changes only; future file publication must verify
ownership and use its own recoverable commit protocol.

The supported stage sequences are:

```text
create:    normalizing -> classifying -> promoting -> compiling -> complete
update:    normalizing -> promoting -> reconciling -> complete
reprocess: normalizing -> promoting -> reconciling -> complete
delete:    reconciling -> complete
```

Invalid stage skips are rejected. Workers must persist the next stage **before**
starting its work. In create jobs, source registration belongs to `classifying`;
`bindSource()` attaches the registered identity there, before promotion. This
retains the source identity through restart and moves ordering onto its logical
source stream. Binding a source with an earlier unfinished operation is refused.

Jobs are selected in sequence order when ready. An earlier unfinished job blocks
later work for that same source/input, including during backoff or manual review.
Unrelated sources can proceed once the root's active lease is released. Failed
work is not silently bypassed to apply newer source operations out of order.

## Failure and recovery

Failures or lease expiry in `normalizing` can return to `queued` with bounded
exponential backoff: one second initially, capped at five minutes. The default
budget is three attempts. Exhaustion or an explicitly non-retryable normalization
failure yields `failed`. `retry()` explicitly grants a further bounded budget;
previous attempt records remain intact.

Failures or expired leases in `classifying`, `promoting`, `compiling`, or
`reconciling` yield `needs-review`, regardless of remaining automatic attempts.
This includes the gap between creating a Source manifest and binding its ID to
the queue: automatic replay there could duplicate source registration. Live
leases are never stolen on restart, and expired workers cannot keep updating
the queue.

There is deliberately no generic method to force a `needs-review` job back into
processing. The later capture/compiler phases must inspect manifests, versions,
and publication journals and provide a specific reconciliation path. Thus Phase
3 safely preserves ambiguous work but does not yet automatically repair it or
provide a review UI. Stage completion is a trusted worker report; the queue
itself does not verify that evidence or Wiki output exists.

Disabling the feature prevents enqueue, claim, and manual retry. An already
leased worker may finish reporting its state or failure, avoiding stranded
bookkeeping. Expiry recovery and inspection are also available while disabled.

## Verification and next checkpoint

The new tests exercise migration repeatability and preservation of existing
records; deduplication across independent connections and reopen; content and
generation distinctions; exclusive claims; expired/stale leases; heartbeat;
bounded retry and manual retry; stage validation; source binding; durable
completion; source ordering; missing-file deletion; registered update/reprocess
ownership; feature disable; wrong-root databases; and interrupted registration
and promotion. No model, conversion binary, or user data is used.

Phase 4 is the Inbox watcher. No watcher, provider call, converter, automatic
daemon worker, UI, Raw version creation, or Wiki write was implemented here.
