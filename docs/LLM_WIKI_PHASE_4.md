# LLM Wiki Phase 4: Inbox watcher

Implemented on 2026-09-11 using the updated implementation sequence. The daemon
now discovers Inbox material and submits durable create jobs. It does not claim
jobs, convert documents, create SourceVersions, or invoke a model.

## Runtime ownership

`server/ingestion/inbox.ts` owns a narrow Chokidar subscription to the configured
Inbox when `llmWiki.enabled` is true. Existing files are discovered on startup.
An absent Inbox is created only for an explicitly enabled configuration; an
uninitialized or disabled Cabinet does not get new content directories or jobs.

The daemon starts this service alongside its existing background services and
awaits its shutdown before closing SQLite. Settings use a separate exact-file
subscription to `.cabinet`, with 250 ms polling so atomic manifest replacements
cannot silently lose the subscription. This is not a recursive watch of the
Cabinet root. After the settings subscription is ready, configuration is read
again to close the startup race between reading and subscribing.

Inbox and config paths are canonicalized, including macOS's `/var` versus
`/private/var` aliases. Feature disable tears down the Inbox watch and pending
validation. A changed active-root pointer prevents further submissions by the
stale process. Watch errors disable the Inbox service and appear in its status;
configuration refresh/restart can retry setup. Queue work remains durable.

## Validation and enqueueing

Chokidar uses `awaitWriteFinish` with a 1500 ms stability threshold and a 100 ms
poll interval. Per-file timers also stabilize initial discovery, because initial
add events can occur without that delay. Events are coalesced per file, and
hashing is serialized to limit memory and I/O pressure.

Validation rejects hidden/internal paths, dependency/build directories, editor
swap/temporary/lock files, partial downloads, and symlinks. Only Inbox is watched;
Raw and Wiki are excluded structurally by the disjoint configured paths. The
legacy `raw/Inbox` alias remains unsupported by the existing non-overlap rule.

Each eligible file must remain a regular file with the same device, inode, size,
modification time, and change time before and after hashing. The watcher hashes
through an opened file handle in 1 MB chunks, caps files at 500 MB, and checks
that the pathname still names the inspected file. Changes during stabilization
or hashing reschedule validation. Missing files are removed from the pending
display; other errors are surfaced for inspection/retry.

The resulting SHA-256 and root-relative location are submitted to the Phase 3
queue as a snapshot create request. Inbox events use a stable
`inbox-snapshot-v1` generation; the queue deduplicates identical path/content
requests across duplicate events and restart. Changed bytes produce another
request. Existing matching jobs are shown as already submitted even when automatic
ingestion is off. No queued job is automatically retried or reset by the watcher.

Hashing is validation, not evidence capture. Originals remain in Inbox unchanged.
If a file changes or disappears after enqueue, the future worker must verify and
capture the intended input or report the mismatch. These queued originals are
not yet immutable Raw evidence. The file-size limit and serialized hashing are
initial safeguards; the current registry/queue lookups and full status listing
remain intended for modest local collections, not unlimited-volume ingestion.

## Controls and status

Storage settings show an Inbox section only for an enabled LLM Wiki Cabinet:

- **Auto-ingest Inbox** persists `autoIngestInbox` in the existing root manifest.
  It defaults off, and enabling it schedules currently awaiting items as well
  as future arrivals.
- **Awaiting ingestion** includes files being stabilized/checked or waiting for
  manual submission. When automatic mode is off, hashing/detection still works,
  but no new queue request is created without explicit action.
- **Ingest all** submits the current pending/error candidates asynchronously
  after revalidation. The button does not wait for conversion or compilation.
- **Submitted to the queue** counts current Inbox files already associated with
  a durable job; it does not imply that their processing has completed.
- File validation and service errors are displayed in the same section.

The toggle updates immediately while saving, rolls back if saving fails, and
discards stale polling responses during a mutation. Counts refresh every three
seconds while the Storage section is mounted.

`/api/ingestion/inbox` forwards bounded requests to the authenticated daemon
endpoint `/ingestion/inbox`. GET returns status; POST supports `ingest-all` and
`set-automatic` with a boolean `enabled`. Request bodies are capped at 4 KB,
malformed actions are rejected, and the Next route uses the existing API auth
gate and server-held daemon token. The API accepts no arbitrary root or input
path from the browser. Manual submission returns 202 because validation and
enqueueing continue in the daemon.

## Deletion, shutdown, and recovery boundaries

Unlink removes only the staging candidate. It never deletes a queue job, changes
Source lifecycle state, or removes evidence. Pending timers are cancelled and
in-flight validation is invalidated when the service closes or reconfigures.
Shutdown drains file work before SQLite closes. A request already committed to
SQLite remains queued even if the UI closes or the file is subsequently removed.

Pending-display state is intentionally in memory and rebuilt from Inbox after
restart. Queue intent is still SQLite-backed. Error candidates can be revalidated
with Ingest all; review-needed processing jobs retain Phase 3's reconciliation
requirements and are not reset through this interface.

## Verification and next checkpoint

Real filesystem tests cover startup/manual ingestion, automatic multi-write
stabilization, same-content saves, generated/hidden/symlink exclusions, unlink,
custom Inbox paths, restart deduplication, automatic on/off, feature disable,
shutdown, visible queue failures, completed partial downloads, and oversized
files. The browser test boots the real app and daemon against temporary data,
checks daemon authentication and request bounds, submits manually through Storage
settings, enables automatic ingestion, verifies persisted settings after reload,
and confirms original bytes remain unchanged.

Phase 5 is the managed-source watcher. No managed-file watching, source
normalization, converter, Raw promotion, or Wiki compilation is added here.
