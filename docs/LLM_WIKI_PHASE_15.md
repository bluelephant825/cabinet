# Phase 15 — WikiCompiler interface

Completed 2026-09-11. Numbering follows the updated implementation sequence.

## Contract and implementation boundary

`compiler.ts` exports the provider-independent `WikiCompiler` interface:

- `ingest(source, version)`
- `reconcileUpdate(source, previousVersion, currentVersion)`
- `reconcileDeletion(source)`

Every method returns a `WikiCompilationResult` explicitly marked `proposed`.
`PlanningWikiCompiler` implements evidence/context preparation, invokes an injected
`WikiCompilationPlanner`, and validates its output. It does not generate source
summaries itself, extract entities, publish files, claim jobs, advance compilation
pointers or acknowledge lifecycle reconciliation. Those remain later phases.

There is no new provider manager or live CLI/model startup. A future planner adapter
can use Cabinet's configured provider runtime with appropriate tool restrictions.
Its request contains detached data snapshots, not executable instructions or a
filesystem capability. The trusted adapter must honor cancellation and treat
imported evidence/Wiki text as data; this TypeScript boundary is not an OS sandbox
for arbitrary JavaScript supplied as an adapter.

## Inputs and scope

The service re-reads authoritative Source manifests and requires the supplied
Source/version records to match them. Ingest/update require an active Source and
target its current Raw version. Update requires a managed Source and an earlier
baseline from the same history; it can span multiple versions when compilation
has lagged capture. Deletion requires a deleted Source and may inspect its last
current captured evidence without accessing the missing working file.

Evidence comes from receipt-verified `source.md` and controlled provenance, using
the publication reader. Existing Wiki Markdown is read before inference and
returned as text/hash snapshots. No conversion or working-file writes occur.

Root-owned compilation uses the configured Wiki root. Room-owned compilation uses
`<wiki>/rooms/room-<encodeURIComponent(roomPath)>`; encoding the whole relative
room path into one component keeps nested rooms disjoint. These are proposal
namespaces only: no folders are created. Root context excludes the reserved rooms
namespace, and room context cannot read or propose root/other-room changes.

The initial bounded context reads recognized Markdown pages in sources, entities,
concepts, comparisons and synthesis, plus index.md, concept-table.md, overview.md
and log.md. Hidden directories and unrelated page families are excluded. Symlinks
fail closed. Limits are 2 MB per evidence document, 512 KB per Wiki page, 200 pages,
4 MB of Wiki context, 500 directories and bounded nesting. Oversized contexts fail
for review rather than silently truncating evidence. Later relevant-page selection
can refine this conservative initial strategy.

## Validated proposals

The injected planner returns `{ changes: [...] }`, containing writes or deletes.
Writes carry ordinary Markdown and Source/version support references; deletes
identify an existing page. Only approved `.md` paths within the request's Wiki
scope are accepted. Traversal, hidden/unknown output families, duplicate/overlapping
targets, case aliases of read pages, unread deletions, foreign evidence references,
raw HTML/live code and unsafe URL schemes are rejected. Output has per-page,
aggregate and change-count limits.

Support references in this phase may identify only supplied evidence from the
active target Source. Deleted evidence cannot be proposed as active support.
Alternative-source support discovery, claim-level grounding, durable provenance
metadata and actual deletion decisions remain later reconciliation work. Empty
support lists and no-op proposals are valid structural plans, not assurances that
their claims are true or reconciliation is complete.

Existing-page edits receive the hash of the page that was read; new-page writes
receive `expectedHash: null`. After planning, the service rechecks Source/history,
evidence, Wiki pages and target existence. Changed inputs cause review/retry rather
than returning a stale accepted plan. Caller-owned data and planner requests are
cloned so mutation does not corrupt authoritative inputs.

Results include an input-derived operation key, source snapshot hash, evidence IDs,
Wiki read set and a hash of the exact proposed plan. These are future publication
preconditions and deduplication inputs. A publisher must revalidate them immediately
before writing, journal multi-page changes and separately record successful
compilation. Per-file atomic writes alone are not a publication transaction.

A proposed result must never be adapted directly into `LifecycleReconciler` success:
that callback is allowed to authorize permanent evidence deletion and requires
actual completed Wiki work, which this phase does not perform.

## Verification and next phase

Six new tests cover verified context, stable plan identities, absence of writes,
update/deletion operations, lagging compilation baselines, current-target checks,
path/content/support rejection, read preconditions, stale Wiki/Source/evidence,
nested-room isolation, timeout cancellation, bounded outputs and planner mutation.
Tests use deterministic planner fixtures, not a live model or semantic compiler.

Phase 16 is Karpathy-style source summaries and awaits user instruction.
