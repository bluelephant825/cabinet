# Phase 26 — Failure recovery

Completed 2026-09-11, using the canonical implementation sequence.

## Recovery decisions

`IngestionRecoveryService` composes the existing durable queue, authoritative
Source manifests and Raw publication receipts. Inspection is read-only and reports
job/error state, recent attempts, the current Source/Raw version, a recovery action
and an optimistic fingerprint. Queue/Cabinet and Source/room identities must agree.

- Failed pre-write work can be retried with a bounded attempt budget, provided an
  already-bound Source is still active and not pending lifecycle reconciliation.
- Interrupted classification or other uncertain writes require review.
- Interrupted Raw promotion can be resumed only from an explicitly selected,
  matching version receipt.
- Interrupted compilation/reconciliation requires a fresh plan from current evidence
  and actual completed publication before the job may be resolved.

`retry` checks the inspection fingerprint and delegates to the existing queue's
failed-only retry path. The queue now also accepts an optional expected timestamp
and attempt count checked inside its transaction, preventing a stale recovery
request from increasing the budget of a newer failure. Review-state jobs cannot be
blindly queued through this method.

`recoverExpiredLeases` uses the existing lease semantics: live workers remain
untouched; expired pre-write attempts follow bounded queue retry policy; expired
write stages become needs-review. Disabled Wiki configuration prevents recovery
mutations. No service removes stale root locks, resets arbitrary statuses or claims
that interrupted work completed.

## Receipt-based Raw resumption

`recoverRaw` requires a fresh inspection fingerprint, a promotion-stage review job,
an active Source and an explicit version number. It reads the bounded receipt through
the owned-path guard and checks its intended Source/version and original-content hash
against the failed job. It rechecks the recovery state before delegating to
RawPublicationStore.recoverVersion, which verifies staging/orphaned files, receipt
integrity, predecessor state and immutable history before resuming publication.

Complete staged output can therefore finish without rerunning conversion. Incomplete
or corrupted staging fails safely; retrying the underlying publication requires the
original captured input, as documented in the earlier Raw publication phases. No
recovery path adopts the highest version directory by guessing, overwrites previous
Raw evidence or erases working files.

A successful resumption reports `raw-recovered`, the current version and the still
reviewed queue status. It explicitly reports Wiki publication as not completed.
Raw success alone does not resolve a queue job, advance lastCompiledVersionId,
acknowledge lifecycle reconciliation or permit permanent deletion. Recovery is not
a cross-database/filesystem completion transaction; later publication integration
must establish those completion conditions.

## Optional external lookup isolation

The original plan explicitly requires Wikidata/Wikipedia failure not to fail main
ingestion. Phase 23's strict identity API remains available to callers that need
errors, but SourceSummaryPlanner now uses `resolveOptionalIdentities` for enrichment.
This wrapper provides one five-second budget for the whole selected-candidate batch,
not a full retry budget per candidate. It aborts pending enrichment on timeout and
stops further lookups after an error.

Successful identity results are retained. Failed/unattempted results are labeled
`unavailable`, distinct from unmatched, and the summary says lookup can be retried
separately. Raw provider errors and external text are not copied as UI instructions.
Network, API, rate-limit, model and validation failures in optional enrichment no
longer discard a valid grounded summary. Parent/compilation cancellation still
propagates. The change imports no external facts into provenance and starts no live
provider or background retry loop.

## Existing safeguards and open integration work

Conversion and normalization failures remain before Raw publication; classification
has explicit review outcomes; durable Raw receipts already handle staged/orphaned
moves; compiler snapshot checks reject stale or corrupted inputs; lifecycle state
and evidence remain authoritative if Wiki reconciliation fails. This phase connects
those boundaries through explicit recovery inspection/actions rather than inventing
a second journal or treating a proposed Wiki plan as published work.

There is no new recovery UI/API route or daemon queue consumer. Callers can use these
services with the existing queue and planner contracts. The persistent Wiki
publication/provenance transaction, affected-page inventory, provider/queue wiring,
completion acknowledgment and full end-to-end acceptance scenarios remain outstanding
in the canonical plan. No “Ignore” action silently completes blocked work or clears
uncertain writes.

## Verification

Five new tests cover pre-write retry and stale-action rejection, interrupted
classification review, staged Raw recovery preserving exact evidence and pending
queue state, live/expired compilation leases, disabled recovery, optional-identity
errors/deadlines/parent cancellation, and preservation of a grounded Source summary
during identity outage. Existing corruption, retry, lifecycle and compiler tests
remain in the full suite. Tests use isolated database/Raw fixtures and mocked
external failures; no live user Source was recovered or altered.

All 652 unit tests passed. TypeScript and targeted lint passed; full lint reported
zero errors and 148 existing warnings. Whitespace checks passed.

Phase 27 is integration tests and awaits user instruction.
