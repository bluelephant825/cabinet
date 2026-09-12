# Phase 16 — Karpathy-style source summaries

Completed 2026-09-11, following the updated implementation sequence.

`SourceSummaryPlanner` is the concrete single-source planner for the Phase 15
`PlanningWikiCompiler`. Compose them with an injected `SourceSummaryModel` to
produce a verified, grounded Markdown proposal. The model receives a title,
current captured body, explicit summarization instructions and cancellation signal.
It returns structured summary, claim and qualification statements with exact
supporting quotes. Imported content is data, never trusted instructions; no tools
or filesystem capability are supplied by this interface. The adapter must enforce
its own runtime restrictions and cancellation. No live provider is started here.

## One page per logical Source

New pages use `<scoped-wiki>/sources/source-<source UUID>.md`. The opaque Source ID
keeps the path stable through title, category and Raw-version changes. Existing
source-summary pages in the scoped sources directory are identified by their
`source_id` and retain their path, including human-chosen filenames. Multiple
matching pages, a conflicting page type, malformed front matter or an occupied
new-page path fail for review before inference. Room isolation and collision,
symlink and stale-input checks come from the verified compiler.

Cabinet renders the Markdown and owns paths, headings, front matter, evidence
references and provenance; the model cannot choose these. Front matter includes
title, source-summary type, Source/Cabinet IDs, current version number/ID and Source
status. The body contains Summary, Key claims, Evidence, Entities, Concepts,
Relationships, Changes from previous version, Contradictions / qualifications,
Related Wiki pages and Source provenance. Evidence entries use deduplicated E-number
references and relative links to the captured Raw Markdown. Provenance also links
the original and records the version ID and original content hash.

Summary generation uses only current evidence, even when called with an update
baseline. It does not carry historical claims forward as current support. Initial
summaries identify themselves as initial; later versions explicitly state that
comparison with earlier versions has not been compiled. Entity/concept/relationship
sections and related-page linking explicitly remain pending subsequent phases.
Deletion is rejected, so this planner cannot masquerade as completed lifecycle
reconciliation.

## Validation and boundaries

Strict output fields allow 1–3 summary statements, up to eight claims and five
qualifications. Each paraphrase is bounded to 500 characters and each quote to
300; quotes must occur exactly in the verified current body. Empty statements,
control characters, extra fields, fabricated quotes and direct whole-body copying
in a statement are rejected. Model/source text is escaped into literal Markdown,
so HTML, Markdown links or expressions in evidence do not become executable page
content. These checks provide traceability and size limits; they cannot prove that
a paraphrase follows logically from a quote or detect every form of excessive
copying. Semantic quality remains the model adapter's responsibility.

The result is exactly one proposed write with current Source/version support. The
compiler attaches expected hashes and revalidates its snapshots. Nothing publishes
Wiki files, advances `lastCompiledVersionId`, consumes queue jobs or acknowledges
lifecycle work. A future publisher still needs the Phase 15 transaction and
precondition safeguards. This phase adds source-summary composition, not the
Phase 21 cross-page update reconciliation or Phase 22 deletion reconciliation.

## Verification

Four additional integration tests exercise the summary planner through real
receipt-verified Raw storage and the compiler: stable one-page identity and
provenance without publication, room-scoped refresh of an existing logical page,
current-only support across versions, invalid/oversized/copied output, unsupported
deletion, identity collisions and literal rendering of unsafe-looking text.
All 608 unit tests passed. TypeScript and targeted lint passed; full lint reported
zero errors and 148 existing warnings. Tests use deterministic model fixtures,
not live inference. No UI or runtime startup behavior changed.

Phase 17 is entity/concept extraction and awaits user instruction.
