# Phase 11 — Managed Source updates and version comparison

Completed 2026-09-11. Numbering follows the implementation plan's updated sequence.

## Update contract

`RawPublicationStore.publishUpdate(sourceId, expectedPreviousVersionId, normalized)`
creates the next immutable version for an active managed Source. The predecessor
must belong to that Source. A fresh update requires it to be the current version;
its receipt and committed evidence are verified before proceeding. Snapshot
Sources must continue through their snapshot workflow, not this update API.

The Source ID, Raw directory, logical category, managed binding and earlier
SourceVersion records remain unchanged. A successful update appends vN+1,
advances `currentVersionId`, and retains `lastCompiledVersionId`. Old Markdown,
originals and assets are never rewritten. Each new version uses Phase 10's
original/dependency capture layout, controlled provenance, journal, exclusive
staging, integrity checks and atomic publication/manifest replacement.

Identical original-byte hashes produce a verified no-op without touching the
manifest or allocating a version. Returning to an older hash after an intervening
change creates another version. This matches the existing watcher's original-file
hash contract: dependency-only changes and converter-only changes do not create
an ordinary managed update; an explicit reprocess workflow remains separate.

## Retry and recovery

The caller must retain the expected predecessor ID when it starts the operation.
That ID determines the target version number across retries, including after a
successful update or after a subsequent update. An identical retry verifies its
original target and returns the current manifest without rolling its pointer back.
A different payload for an existing transaction fails for review.

`recoverVersion(sourceId, versionNumber)` requires an explicit positive integer
and a valid receipt. It can resume complete staging or orphaned publication, or
verify a committed historical version while retaining newer version records and
logical metadata. It never guesses which directory to adopt. `recoverInitial`
continues to work after newer versions exist. Phase 10 receipts remain readable.

An unjournaled target, stale/conflicting manifest, missing/damaged predecessor,
foreign identity or mismatching evidence fails closed. The existing operator
review requirements for partial files/receipts and stale root locks still apply.
Legacy evidence without publication receipts requires review/migration rather
than automatic adoption. Durability has the same POSIX/Windows qualifications
as Phase 10; there is no cross-filesystem/SQLite transaction.

## Comparison for reconciliation

After publication, call
`compareVersions(sourceId, fromVersionId, toVersionId, optionalModel)` for committed
adjacent versions. The service verifies both receipt inventories, manifest history
and evidence headers before extracting bodies. It returns a version-bound delta
that a later Wiki reconciler can consume. Comparison failure leaves valid Raw
publication intact and can be retried independently.

The deterministic comparison uses the Markdown syntax tree to identify added,
removed and modified sections and link/image/definition URLs. It also reports
added/removed numerical tokens. These are text observations: a heading rename
can appear as removal/addition, repeated headings are occurrence-indexed, raw
HTML references are not extracted, and numerical tokens do not establish a
changed scientific conclusion. Lists cap at 100 with an explicit truncation flag.

Optional semantic analysis uses an injected text-only model contract, without
creating a live provider or granting document text tool permissions. Its bounded
prompt treats excerpts as untrusted data and asks for changed claims, entities,
concepts and conclusions. Every finding must supply exact old/new supporting
quotes (or null for an addition/removal). Invalid schema or ungrounded quotes
fail validation. Semantic inference remains fallible; validation establishes
textual support, not the truth or completeness of a conclusion.

Model input is capped at 16,000 characters per side with truncation disclosed;
output has size/count limits and a timeout with cancellation. The injected runner
must honor its AbortSignal to terminate work. Without a model, the delta clearly
reports semantic analysis as `not-run`. No live model was used for verification.

## Verification and boundary

Twelve additional tests cover v2/v3 history preservation, content reverts,
historical retries, four interrupted-update checkpoints, no-op hashing,
unsupported/foreign inputs, orphan conflicts, compiled-pointer preservation,
semantic failure after commit, tamper detection, deterministic delta extraction,
quote validation, model cancellation and truncation.

The daemon still observes and queues changes; this phase adds the publication
and comparison services, not a consumer that prematurely completes reconciliation.
The later compiler can receive the returned delta after publication and retain
its own progress independently of the current Raw pointer. No deletion lifecycle,
Wiki writes, generic editor restrictions or later UI work was enabled.

Phase 12 is Source deletion semantics and awaits user instruction.
