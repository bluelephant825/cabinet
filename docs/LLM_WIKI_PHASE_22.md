# Phase 22 — Deletion reconciliation

Completed 2026-09-11, using the canonical implementation sequence.

## Deactivation without erasure

`createDeletionReconciliationCompiler` accepts a deleted Source and explicit
provenance/page-hash snapshots, returning verified Wiki write proposals. It requires
no model: the existing provenance records and current Source/version states determine
which contributions survive. Active Source operations are rejected.

For every affected knowledge node, the planner removes the deleted Source from
active `supports`. Independent support remains active only when its Source is active
and the referenced version is current. All other contributions move to optional
`inactiveSupports`, retaining their exact Source/version IDs, quotes and offsets.
Knowledge IDs and text remain intact. Nodes without active support are historical
only and excluded from current synthesis by the provenance model.

The schema adds `inactiveSupports` as an optional field to the existing version-1
record. Earlier records continue to decode. A node must have at least one active or
inactive edge, and combined edges share the existing limits and duplicate checks.
Inactive edges undergo the same scope, identity, receipt and quote validation; they
are never silently accepted as unverified historical references. Support lookups
return an explicit inactive flag and cannot count an inactive edge as current or
alternate support, even if a Source is later restored. Reactivation requires separate
reconciliation, not just a lifecycle flag change.

## Wiki page proposals

Affected pages preserve their original body and receive a prominent review before
that body, following any front matter. It identifies the deleted Source and lifecycle
revision, supersedes older notices for that Source and lists retained versus
historical-only knowledge. Existing Source-summary metadata changes to
`source_status: deleted`; other front-matter fields are preserved through YAML
serialization. Historical text and Raw references remain visible rather than being
automatically erased.

This is conservative deactivation: current support is removed from the machine
provenance, with an explicit historical qualification in Markdown. It does not
attempt to remove arbitrary human prose or regenerate synthesis paragraphs. Consumers
of the provenance must use active/current edges for current-source synthesis, rather
than treating historical prose as current knowledge.

Unrelated pages are not proposed for modification. The planner does not propose
file deletions. Same-input unpublished retries are stable. A page already carrying
the same revision notice is a no-op only if its supplied provenance and Source-summary
status agree with the newly computed result; disagreement requires review.

## Verified inputs and safeguards

Snapshots are cloned and parsed at construction, with at most 100 pages and unique
page paths. Every supplied graph must match the current Cabinet/room, a read Wiki
page and its hash. A known Source-summary missing from the supplied inventory fails
explicitly. Other affected-page discovery still depends on the caller providing a
complete inventory from the future persistent provenance index; text scanning is
not treated as a substitute.

The compiler now loads referenced historical versions of the deleted target Source,
not merely its latest version. A deletion-specific option also loads inactive
independent Sources when required to verify historical edges. Active write support
can refer only to loaded active independent Sources; the deleted target can appear
only as inactive provenance. Foreign scope, missing evidence, corrupted receipts,
invented quotes and inconsistent graphs fail for review. Missing/purged historical
evidence is not replaced with fabricated support.

All loaded manifests and verified evidence remain part of snapshot/hash revalidation.
Changes to the target, independent Sources or Wiki pages invalidate the plan. The
normal compiler still disallows inactive provenance on ingest/update proposals;
a subsequent restore/update of pages with such records needs explicit reconciliation
handling rather than silently reactivating them. Deletion output remains included
in the final plan hash, with expected page hashes and current-source preconditions.

## Publication and lifecycle boundary

No Wiki page or provenance index is published, Raw version erased, working file
modified, compilation pointer advanced or lifecycle reconciliation acknowledged.
The Source remains pending reconciliation. This factory is not a
`LifecycleReconciler` completion callback and must never be adapted directly into
one: its results are explicitly `proposed`, including a no-op result.

Permanent deletion still requires actual, durably published Wiki/provenance
reconciliation and the existing explicit Source-confirmation lifecycle operation
before physical Raw erasure. The publication/index/queue integration gaps identified
in the current implementation plan remain open; this phase does not claim to close
them by generating a proposal.

## Verification

Four new integration tests cover historical-version deactivation, stable knowledge
identity and portable inactive provenance, independent current support, another
Source becoming deleted, prominent history notices, logical Source-summary status,
room scope, missing summary inventory, same-revision no-op behavior, wrong operations,
stale page hashes and forged historical evidence. Tests verify Raw and Wiki files
remain unchanged by the compiler and lifecycle reconciliation stays pending.

All 633 unit tests passed. TypeScript and targeted lint passed; full lint reported
zero errors and 148 existing warnings. Whitespace checks passed.

Phase 23 is Wikidata/Wikipedia identity resolution and awaits user instruction.
