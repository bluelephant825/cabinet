# Phase 20 — Wiki provenance model

Completed 2026-09-11, following the updated implementation sequence.

## Knowledge and evidence

`wiki-provenance.ts` defines a versioned, portable machine record separate from
Source identity metadata and human-readable Markdown. A record identifies its
Cabinet, room and Wiki page and contains knowledge nodes of type claim, concept,
relationship, summary-statement, entity or qualification. Each node retains its
plain text and one or more supporting evidence edges. Edges identify a logical
Source, immutable version, exact quote and UTF-16 body offsets (exclusive end).
Multiple independent Sources can support the same knowledge node.

Knowledge IDs are SHA-256 hashes of Cabinet/room/page scope, kind and exact text.
They do not contain a Source version, so unchanged knowledge keeps its ID when its
support changes. Page renames and text changes produce different IDs; canonical
cross-page identity and automatic migration are not implied. Identical statements
within one generated graph combine their distinct support edges. Different kinds
remain distinct even when their text matches.

Strict schema decoding rejects unknown fields, invalid IDs, duplicate nodes/edges,
invalid offsets and unbounded content. Limits are 256 nodes, 64 edges per node,
2,048 total edges, 1,000 characters per statement and 500 per quote. JSON decoding
is bounded to 2 MB. Encode/decode helpers preserve portable records without writing
files. Decoding validates structure, not truth or evidence integrity.

`verifyWikiProvenance` checks graph scope and every quote against caller-supplied,
receipt-verified active Source evidence. It supports multiple Sources but does not
independently read their receipts. `buildWikiProvenance` creates controlled nodes
and edges from the current compiler evidence. Exact quotes establish traceability;
they do not prove that a claim follows from its supporting passage.

## Compiler integration

Wiki writes may now carry a structured `provenance` record. The compiler validates
it against the target page, current Cabinet/room and the evidence snapshots supplied
to that compilation. Every graph edge must also appear in the page-level support
set. Fabricated, foreign or undeclared edges are rejected. The validated record is
included in the final plan hash, so changing provenance changes the proposed plan.
Legacy generic planners may still omit it; SourceSummaryPlanner always includes it.

Source summaries record their summary statements, claims, qualifications and
extracted entities/concepts. Relationship nodes are supported by the schema but
relationship extraction is not introduced. Existing Markdown evidence entries and
relative Raw/original links remain portable human-readable references. Identity
links and durability explanations are not silently promoted into factual knowledge
nodes. The machine record accompanies the proposal rather than being embedded as
large YAML front matter.

## Current support queries

`inspectWikiSupport` answers which Sources and versions support a knowledge node,
their current lifecycle/version states and whether current support exists outside
an explicitly excluded Source. It reads current authoritative manifests and verifies
available evidence through Raw publication receipts and exact quote offsets.
Corrupt or mismatched evidence fails rather than being counted as support.

Source states are active, deleted, archived or missing; versions are current,
historical or missing. Only active Sources with current evidence count toward
`currentlySupported` and `supportedElsewhere`. Historical edges remain inspectable
and are not erased merely because a newer version exists. Multiple versions of the
excluded Source cannot masquerade as independent support. Statuses are query-time
snapshots, not immutable attributes copied into evidence edges or a publication
transaction across Sources.

## Phase boundary and verification

This phase adds the model, serialization, validation, summary integration and
receipt-checked support lookup. It does not persist a machine index or publish Wiki
files. A future publisher must durably store provenance with its page transaction;
a future index can be rebuilt from those records. The current single-Source compiler
cannot claim support from other Sources it has not loaded. The model and verifier
support that future extension, but no automatic knowledge merging, alternate-source
discovery, update/deletion reconciliation, queue consumer, pointer advancement or
lifecycle acknowledgment is added here.

Three new integration tests cover portable round trips, distinct knowledge types,
current-version support, multiple independent Sources, deleted and historical
support, alternate-support queries, target snapshot invalidation and rejection of
fabricated/foreign/duplicate/undeclared provenance. Tests use real isolated Source
manifests and Raw receipts, with deterministic inference fixtures. All 626 unit
tests passed. TypeScript and targeted lint passed; full lint reported zero errors
and 148 existing warnings. Whitespace checks passed.

Phase 21 is update reconciliation and awaits user instruction.
