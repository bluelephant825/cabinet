# Phase 12 — Source deletion semantics

Completed 2026-09-11; numbering follows the updated implementation sequence.

## Lifecycle and active knowledge

`SourceLifecycleStore.remove(sourceId, expectedRevision, reason)` marks a Source
`deleted`, sets `deletedAt`, records a deletion reason and leaves all versions,
Raw paths, working files and version/compilation pointers intact. The default
reason is explicit user removal. A `missing` reason additionally requires a
managed Source and re-resolves its authorized binding: a returned file, symlink,
unavailable mount or permission error is not accepted as deletion.

`SourceStore.listActive(roomPath = null)` provides the room-scoped active-source
projection for current-source retrieval/synthesis; null means root-owned Sources.
Deleted/archived Sources are excluded. `list()` and `get()` intentionally retain
audit/history access. Existing general file search is not replaced by a new
Source search UI in this phase.

Lifecycle metadata contains a monotonically increasing revision, action and
separate reconciliation state. Legacy manifests without it start at revision 0.
Expected revisions prevent stale delete/restore requests from undoing newer
intent. Repeating the same completed transition is idempotent. New fields are
validated by the shared manifest codec and remain outside immutable evidence.

## Restore

`restore(sourceId, expectedRevision, reason)` reactivates the same identity,
clears the deletion timestamp/reason and retains the existing Raw history.
Explicit user restoration works for both snapshot and managed Sources. Automatic
`returned` restoration requires a Source deleted for a missing working file and
checks that the authorized working file is now a regular file. Explicitly removed
Sources require explicit restoration, even if their working document still exists.

A returned file can contain changed bytes. Restoration itself does not convert
or publish them: the existing update path then compares/captures the returned
content. A same-byte restoration still needs lifecycle reconciliation even when
Raw publication is a no-op.

The managed watcher continues submitting delete/update intent for missing and
returned files. It now skips explicit user removals and pending permanent
purges. A future queue consumer calls `remove(..., "missing")` after revalidation,
or `restore(..., "returned")` before updating a returned Source. This phase does
not start that consumer or pretend an unprocessed queue job has reconciled Wiki.

## Reconciliation boundary

`reconcile(sourceId, revision, reconciler)` retries Wiki work independently of a
committed lifecycle transition. Failure remains visibly pending; success records
completion without rewriting evidence. The trusted reconciler receives an
idempotency key, a detached manifest snapshot and the lifecycle action. Its
response must identify the same Source/revision, and unexpected manifest changes
during its work fail for review.

The reconciler contract requires removal of the Source's provenance contribution,
checking alternative active support, and keeping, marking unsupported or removing
affected claims. Restoration reintroduces eligible support. This is an integration
contract for the later compiler, not a model's self-reported approval. The callback
must implement idempotence, bound its own execution, and not acquire the held
Cabinet lifecycle lock. No real Wiki reconciler or model was invoked here.

## Explicit permanent deletion

`permanentlyDelete(sourceId, revision, confirmationSourceId, reconciler)` requires
an already removed Source, an exact Source-ID confirmation and a trusted reconciler.
No watcher invokes it. Missing/failed reconciliation prevents evidence erasure.

The workflow persists a pending purge intent (blocking restoration/updates), then
reconciles while Raw remains available. Only after success does it durably record
a receipt at `.cabinet-state/llm-wiki/purges/<source-id>/receipt.json`, atomically
move the Source directory into that operation's quarantine, erase that directory,
and mark the receipt purged. The working file and any knowledge mount are never
deleted. Publication and purge audit receipts retain metadata, not original bytes;
this operation is not a promise to erase backups or all metadata traces.

The same explicit call resumes after reconciliation, quarantine or erasure without
repeating already recorded successful reconciliation. Foreign/conflicting receipts,
changed manifests, reappearing evidence or a conflicting quarantine require review.
A reconciliation interrupted before its receipt may be called again with the same
idempotency key. There is no blind highest-directory adoption or lock stealing.

Files are flushed and manifests/receipts replaced atomically; POSIX directory
entries are flushed before destructive progress. Node cannot flush Windows
directory handles, so power-loss durability there depends on the filesystem.
Actual process crashes may leave the existing root lock for operator inspection.
Generic editor/IPC Raw mutation restrictions and later UI workflows remain their
separate integration work; the new lifecycle service is the authorized deletion
path, not an OS access-control mechanism.

## Verification and next phase

Tests use disposable Cabinets to verify retained history/pointers, active-source
exclusion, missing/returned file checks, explicit versus automatic restoration,
stale revisions, pending/retried reconciliation, confirmation and identity checks,
permanent-deletion ordering and recovery, post-reconciliation conflicts, disabled
roots and watcher exclusion/restoration. No user Source or Raw file was removed.

Phase 13 is the Reader / Original / Markdown UI and awaits user instruction.
