# Phase 17 — Entity/concept extraction

Completed 2026-09-11, following the updated implementation sequence.

## Candidate analysis

`semantic-extraction.ts` adds one semantic analysis for both entities (identifiable
things) and concepts (abstract ideas). `SemanticExtractionModel` is an injected,
provider-independent structured-data adapter. It receives only the Source title,
current normalized body, explicit instructions and an AbortSignal. Imported text
is untrusted data. The interface grants no tools; the adapter remains responsible
for restricting its runtime and honoring cancellation. No live model is started.

Entity categories cover person, organization, place, species, product, software,
paper, book, institution, drug, disease, technology and event. Concept categories
cover method, theory, mechanism, policy, framework, strategy, phenomenon, principle
and topic. Tags and suggested links are not separate semantic node types.

Each candidate has a source-spelled name, concise description and exact supporting
quote. The validator accepts at most 64 candidates, 120 characters per name, 400
per description and 300 per quote. It rejects unknown fields/types/categories,
control characters, multiline names, missing evidence and duplicate names after
Unicode NFC, case and whitespace normalization, including conflicting entity/concept
classifications. Such ambiguity requires a retry or review, not silent merging.
The quote must occur in the current body and contain the submitted name. This
conservative initial contract does not invent aliases or canonical names.

Validated results have `status: candidates`, Cabinet/room/Source/version scope and
local SHA-256 candidate IDs derived from scope, version, kind and normalized name.
IDs are deterministic across model ordering but deliberately change with the Raw
version; they are not canonical Wiki entity IDs. Each finding includes its Source
and version IDs plus the quote and exact UTF-16 body offsets (exclusive end). When
identical quotes occur more than once, offsets identify the first occurrence.
Results are sorted by candidate ID for stable downstream processing.

The extractor consumes compiler-prepared snapshots; it does not independently
verify filesystem receipts. The `PlanningWikiCompiler` remains responsible for
receipt verification, scope isolation, deadlines and revalidation after inference.
The extractor additionally checks active/current evidence ownership and bounds its
input. Historical evidence in an update request cannot support current candidates.
Deletion is rejected before inference.

## Source-summary integration

`SourceSummaryPlanner` accepts an optional semantic model in addition to the summary
model. When configured, it calls the semantic analyzer once for both kinds and
fills the existing Entities and Concepts sections with candidate descriptions and
E-number references. Quotes share the summary's deduplicated Evidence section and
Raw-version links. Model text is rendered literally, including Markdown/HTML-looking
names, descriptions and quotes. Empty results explicitly report no candidates;
an unconfigured analyzer retains the Phase 16 “Not yet extracted” behavior.

The planner still returns exactly one Source-summary proposal with current-version
support. Semantic failure or cancellation rejects the whole proposal, rather than
returning a partially compiled summary. The typed extraction function is also
available for subsequent durability evaluation without parsing rendered Markdown.

## Phase boundary

Candidates do not create entity/concept pages. Durability decisions belong to
Phase 18; existing Wiki linking to Phase 19; the durable provenance model to Phase
20; cross-page update/deletion reconciliation to Phases 21–22; and external identity
resolution to Phase 23. Relationship extraction remains pending. The Source summary
labels candidates accordingly. No tags, links, external lookups, durability scores,
publication, queue consumption, pointer advancement or lifecycle acknowledgments
are introduced here.

Exact quotes establish traceability, not logical proof that a description or
category follows from the evidence. Semantic accuracy and completeness still depend
on the model. These tests validate contracts with deterministic fixtures, not live
model quality.

## Verification

Five new integration tests cover combined extraction, room-scoped summary rendering,
deduplicated quotes, current-only support, stable scoped identities and body offsets,
version changes, fabricated/historical evidence, duplicates, bounds, invalid fields
and semantic types, empty results, literal rendering, timeout/failure propagation,
no publication and no deletion acknowledgment. All 613 unit tests passed. TypeScript
and targeted lint passed; full lint reported zero errors and 148 existing warnings.
Whitespace checks passed. No UI or runtime startup changed.

Phase 18 is durability rules and awaits user instruction.
