# LLM Wiki Phase 5: managed-source watcher

Implemented on 2026-09-11 using the plan's updated implementation sequence.
The daemon now submits durable jobs when registered managed files change or
disappear. Source normalization remains Phase 6.

## Scope and runtime ownership

`server/ingestion/managed.ts` runs independently of Inbox ingestion. An explicitly
enabled LLM Wiki configuration permits watching registered managed sources;
`autoIngestInbox` applies only to Inbox. Snapshot and archived sources are skipped.
Uninitialized or disabled roots cause no source reads or new jobs.

The service polls registered working paths every second and requires a stable
file signature for at least 1500 ms before hashing or reporting a deletion.
Polling handles atomic file replacements and missing paths without relying on
an operating-system subscription to an old inode. It does not recursively watch
the Cabinet, Raw, Wiki, or external directories. Registry discovery reads the
existing manifests through SourceStore, stopping before version contents, so
new registrations and explicit rebindings are discovered automatically.

Configuration, source lifecycle, current version, binding and mount authorization
are refreshed during polling and revalidated before submission. A stale daemon
after an active-Cabinet switch submits nothing. Shutdown cancels future polling
and drains inspection work before SQLite closes. File errors are available from
the service's `status()` method and logged by the daemon when they change; this
phase adds no managed-source settings UI or HTTP endpoint.

## Change detection and durable deduplication

The shared `stable-file.ts` helper hashes regular files in 1 MB chunks, rejects
files larger than 500 MB, and verifies device, inode, size, modification time,
and change time before and after reading. It checks the pathname still names
the inspected file and supports shutdown cancellation. Inbox now uses the same
helper. Managed inspection remains serialized, with unchanged file signatures
cached in memory to avoid repeatedly hashing content.

With no outstanding observation, the current SourceVersion hash is the baseline.
Identical bytes are ignored, including repeated saves and atomic replacement.
Changed bytes enqueue an `update` with the existing Source ID and binding. A
new registration without evidence or a previous observation queues one `create`;
further changes queue ordered updates to that same source.

Outstanding create/update/delete jobs supply the most recently observed state.
Each new observation uses the preceding job ID and current version ID as its
generation. This retains A → B → A transitions even while processing is pending,
and prevents duplicate submissions after restart. Failed and review-needed jobs
remain barriers in the existing queue; watching never retries or resets them.
Completed jobs defer to the authoritative source/version projection. Reprocess
requests do not change the observed working-file state.

## Deletion, restoration and rebinding

A missing registered file must remain missing through stabilization before one
`delete` job is enqueued. The watcher never changes a source's lifecycle status,
rewrites a manifest, removes evidence, or modifies a working file. Reappearance
after deletion queues an `update` even when the returning bytes match the earlier
version. Applying deletion/restoration and reconciling Wiki claims are later
worker/lifecycle responsibilities.

SourceStore exposes a shared managed-path resolver that permits a missing file
while retaining existing room, root, mount and symlink checks. Disabled, removed,
inaccessible or missing mount roots are errors, not file deletions. A missing
file beneath an accessible authorized mount can be a deletion. Read-only mounts
are read without modification. As with filesystem mounts generally, an OS mount
that disappears but leaves an accessible empty directory cannot be distinguished
from missing contents through these path checks alone.

Explicit `SourceStore.rebind` preserves identity and switches observation to the
new path. Rebinding during the stability interval cancels the old pending
observation. This phase does not infer arbitrary moves or rename pairs. Already
committed jobs remain durable after a later rebind and must be validated by the
future worker rather than silently rewritten by the watcher.

## Boundaries and verification

Hashing observes content; it does not capture immutable evidence. A file can
change again before processing. The future worker must validate the queued hash
and current binding and capture the intended bytes or report a mismatch. This
phase adds no normalization, SourceVersion creation, model calls, Raw promotion,
job claims, or Wiki reconciliation.

Registry discovery and queue lookups use the existing manifest and SQLite APIs.
These initial polling/lookups target modest local collections; indexing and
event-driven registry notifications can replace them if larger libraries require
it. Filesystem validation guards ordinary application operations, not hostile
concurrent OS mutations between checks.

Tests exercise stable writes, current-version comparison, duplicate saves,
reverts, restart deduplication, deletion/restoration, Raw preservation, atomic
replacement, explicit rebinding, new registrations, snapshot exclusion,
symlink/directory rejection, disable/archive/shutdown, read-only mounts, mount
unavailability and root switching. The real app/daemon integration test registers
a managed source while running and verifies queued update/delete jobs and retained
evidence alongside the existing Inbox browser test.

Validation: 522 unit tests, production build, TypeScript checking, targeted lint,
and the two Inbox/managed integration tests. Full lint has no errors and retains
148 existing warnings. Phase 6 requires a separate user instruction.
