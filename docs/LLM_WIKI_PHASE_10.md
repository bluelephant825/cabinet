# Phase 10 — Initial immutable Raw publication

Completed 2026-09-11. Numbering follows the updated implementation sequence in
“Cabinet LLM Wiki — Implementation Plan”; this is its initial Raw version step.

## Cabinet mapping

`RawPublicationStore.publishInitial(sourceId, normalized)` consumes an already
registered, active Source and the captured-byte normalization result from Phases
6–8. It allocates one version UUID and publishes `v1` under the Source's existing
Raw path. Snapshot and managed Sources use the same publication contract.
Working files and Inbox originals are never changed.

`SourceStore.register(input, classificationPlan)` optionally consumes Phase 9's
plan, re-reading its room-scoped taxonomy while holding the registration lock.
Review decisions, mismatching categories, foreign scope and stale fingerprints
fail before registration. Direct explicit registration remains supported.
Registration and publication are deliberately separate checkpoints: the caller
retains/binds the Source ID before attempting publication and retries that same
ID, rather than registering another Source after an interruption.

The concrete flow is classification → registration (with the plan) → retain the
Source ID → `publishInitial`. The existing queue's classification-stage binding
can retain that identity; this phase does not start a queue consumer or advance a
job through compilation. Filesystem publication and SQL are not one transaction.

## Evidence layout

```text
raw/<category>/<slug>-<source-id>/
  manifest.yaml
  v1/
    original.<format>
    source.md
    assets/
    capture.json
    capture/<original capture-relative path>
    capture/<original dependency paths>
```

Custom Raw paths and nested categories are supported. `original.<format>` is a
byte-identical convenience copy. `capture/` also preserves the original relative
folder layout, including parent-relative image references, without rewriting
original HTML or Markdown. `capture.json` identifies the original within that
layout. This intentional extra copy makes the dependency layout portable.
`source.md` contains the Phase 8 Cabinet-owned provenance header and normalized
body; its assets retain the normalizer's content-addressed paths.

The manifest gains exactly one enriched SourceVersion and its current pointer.
The compilation pointer stays unchanged. Imported metadata cannot choose version
identity, hash, paths or converter provenance. Caller buffers are cloned before
asynchronous work; publication validates the captured hash and all asset hashes.

## Publication and recovery

A root-local receipt at
`.cabinet-state/llm-wiki/publications/<source-id>/v1/receipt.json` retains the
expected prior manifest hash, intended next manifest and output file paths,
sizes and hashes. It is written before staging and is retained after success.
Staging resides beside it on the same filesystem as Raw. Files are created
exclusively and flushed, and the complete inventory and evidence header are
verified before an atomic directory rename publishes `v1`. The manifest is
flushed and atomically replaced only after the published evidence verifies.
Directory entries are also flushed on POSIX; Node cannot perform that directory
flush on Windows, where power-loss guarantees depend on the filesystem.

`recoverInitial(sourceId)` handles complete staging, a published version whose
manifest still points to no version, and a committed manifest with a stale caller
or queue checkpoint. It verifies evidence and preserves later logical metadata
changes when the same version is already committed. It never picks the highest
version directory or allocates another version.

A retry with identical normalized input can fill missing staged files. Changed
input, partial/damaged existing files, unexpected files, symlinks, foreign or
malformed receipts, an unjournaled `v1`, and conflicting manifest changes fail
closed for review. Missing staging requires the original captured input; a
partial receipt needs operator review. No automatic cleanup destroys uncertain
evidence. If an actual process crash leaves `.llm-wiki.lock`, the existing lock
policy requires inspecting it and confirming the writer is gone before removal;
recovery does not steal locks.

Immutability is enforced by this publisher: it never rewrites published files,
never repairs tampered evidence silently, and rejects later-version creation.
This is not an OS write-protection mechanism. Generic editor/API restrictions
and read-only viewers remain their own later integration work; direct disk edits
are detected by verification rather than prevented by permissions.

## Verification and boundary

Twelve publication tests cover exact original/dependency retention, provenance,
classification-plan consumption, retries without new identities, interruptions
at four write checkpoints, incomplete staging, damaged evidence, stale manifests,
post-commit metadata preservation, foreign receipts, symlinks, competing writers,
caller-buffer mutation, disabled roots and invalid input. Tests use temporary
Cabinets and deterministic normalization, without a model or user-data ingestion.

Phase 11 will create later immutable versions for managed-source updates. It is
not enabled here. Daemon queue consumption, compilation/reconciliation, deletion
lifecycle and the Raw viewer remain pending their respective implementation.
