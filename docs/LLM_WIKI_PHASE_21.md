# Phase 21 — Update reconciliation

Completed 2026-09-11, following the updated implementation sequence.

## Selective planning

`createUpdateReconciliationCompiler` composes the verified compiler, a current
Source-summary planner, an injected semantic comparison model and explicit
provenance/page-hash snapshots. It accepts update operations only. The snapshots
are detached and structurally validated at construction; duplicate pages, foreign
scope, unread/stale page hashes and a target-Source edge that does not match the
supplied compiled baseline fail for review. At most 100 pages and 256 affected
knowledge nodes are considered.

The comparison model receives previous/current verified bodies and only affected
knowledge IDs, kinds and text. It must decide once per item whether the same
knowledge still has current support, providing an exact new quote or null, plus a
bounded explanation. Null covers removed, changed, contradicted or uncertain
knowledge. Unknown/duplicate/missing decisions, invented quotes and oversized output
are rejected. Bodies and knowledge are untrusted data, and the compiler deadline
and cancellation signal cover both summary generation and comparison.

The reconciliation decisions are:

- Current evidence still supports the knowledge: retain its identity and replace
  this Source's old edge with the verified current-version quote/offsets.
- Current evidence no longer supports it, but another active Source's current
  version does: retain the knowledge with that independent support.
- No current support remains: retain historical evidence and explicitly mark the
  knowledge stale, rather than deleting the page or treating old evidence as current.

Only pages with target-Source contributions receive updates. Other pages remain
untouched. The current Source summary is selectively regenerated using the existing
planner, including its new claims and provenance. Its version-comparison section
reports how many prior knowledge items were reviewed and how many lost this Source's
support. A Source summary with independent-source knowledge cannot be overwritten
through this path; it requires review.

## Existing prose and support status

Affected non-summary pages preserve their original Markdown. Reconciliation appends
a Source/version-labeled review section identifying each affected knowledge item,
its support status and the comparison explanation. Stale notices explicitly qualify
the knowledge above as historical and unsuitable as a current claim. Changed claims
are represented by stale prior knowledge on these pages and refreshed knowledge in
the Source summary; this MVP does not rewrite arbitrary human prose or splice new
claims into concept pages.

Later updates append new version-labeled reviews, keeping earlier reviews as history
and identifying the highest version as authoritative. A review for the same version
already present requires reloading published provenance. Repeating a proposal against
the same unpublished snapshots is deterministic with a deterministic model. There
is no durable apply/retry journal yet.

## Verified independent support

The compiler now accepts an explicit bounded list of supporting Source/version
references from the trusted reconciliation factory. It reads their authoritative
manifests and receipt-verifies available active evidence. Foreign Cabinet/room
references fail; deleted, archived or missing Sources cannot supply active support.
Historical versions can be inspected but do not count as current alternatives.
References are capped at 100, each document at 2 MB and aggregate supporting text
at 8 MB.

Supporting manifests, including absent/inactive results, contribute to the compiler's
source snapshot hash and operation key. Available evidence is detached into the
request and verified again after inference. Lifecycle, evidence or Wiki changes
invalidate the proposal. Page support and provenance validation now accept only
these explicitly loaded additional Sources; models cannot nominate arbitrary
unread support. Updated graph edges remain exact-quote verified and included in
the plan hash. Unaffected knowledge whose provenance cannot be validated causes
review rather than silent removal.

## Phase boundary

The provenance inventory is supplied explicitly because Phase 20 did not publish a
persistent index. A future caller must supply the complete affected-page inventory
from that index; this service cannot detect omitted records by guessing from prose.
Provenance snapshots are immutable inputs to this run, not independently reloaded
sidecars. Future publication must revalidate their persistent equivalents together
with the returned source/read hashes and write pages plus provenance transactionally.

Results remain `proposed`. No Wiki files, Raw evidence, compilation pointers, queue
jobs or lifecycle acknowledgments change. This is update planning, not completed
publication or permission for permanent deletion. Deletion reconciliation remains
Phase 22. Quote validation establishes traceability, not semantic entailment;
comparison quality remains the trusted model adapter's responsibility.

## Verification

Three additional integration tests cover selective stale marking with preserved
human prose, stable unpublished retries, current summary comparisons, independent
support retention, deleted-support exclusion, supporting-Source changes during
inference, refreshed support with stable knowledge identity, fabricated/incomplete
decisions and stale page hashes. Tests use real isolated manifests/Raw receipts and
deterministic model fixtures. All 629 unit tests passed. TypeScript and targeted
lint passed; full lint reported zero errors and 148 existing warnings. Whitespace
checks passed.

Phase 22 is deletion reconciliation and awaits user instruction.
