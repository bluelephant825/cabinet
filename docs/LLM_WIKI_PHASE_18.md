# Phase 18 — Durability rules

Completed 2026-09-11, following the updated implementation sequence.

## Policy

`assessCandidateDurability` consumes current, scoped semantic candidates and returns
one decision per candidate. A candidate is `durable` when at least one supported
criterion applies; otherwise it remains a `mention`. No arbitrary score or mention
frequency threshold promotes detected nouns. Incidental candidates remain available
in the Source summary rather than being discarded.

All seven planned criteria are represented:

| Criterion | Input and validation |
| --- | --- |
| Materially important to understanding the Source | Optional model judgment with a concrete explanation and exact current-body quote containing the candidate name. |
| Already exists in Wiki | Trusted identity match to a page in the compiler's current read set, with matching path/hash and the correct entities/concepts area. |
| Occurs across multiple Sources | Trusted matching occurrences from at least two distinct active logical Sources, counting the current Source once. Other occurrences must have current evidence, the same Cabinet/room and an exact quote containing the name. |
| Participates in important relationships | Optional model judgment with explanation and current evidence. This does not create a relationship graph. |
| Useful for future synthesis/retrieval | Optional model judgment identifying concrete reuse, supported by current evidence. Generic usefulness is explicitly insufficient in the instructions. |
| Explicitly important to the user | A trusted application priority with an explanation. Imported Source instructions and model output cannot assert this criterion. |
| Central to the Cabinet domain | A trusted application domain priority with an explanation, separate from Source text and inference output. |

Each decision retains its supporting reason codes, explanations and, for semantic
judgments, quotes. Reasons have a deterministic order. A durable decision means
eligibility for subsequent page planning, not an instruction to create a file or
proof of completed reconciliation.

## Model and context contracts

`DurabilityModel` receives detached candidates, current body/title, instructions
and the compiler's cancellation signal. It must return exactly one decision for
each candidate, with zero to three distinct semantic reasons. Unknown candidates,
missing/duplicate decisions, extra fields, invented quotes, repeated reasons,
unsupported criteria and oversized text fail validation. Explanations are bounded
to 400 characters and quotes to 300. The model cannot supply user/domain priorities,
existing-page matches or cross-source facts. No live provider or tools are started.

`DurabilityContext` is a trusted application contract, not a model response or a
configuration read from imported content. It provides explicit candidate-bound
priorities, verified identity matches and current occurrence snapshots. Bounds are
128 priorities, 64 page matches and 256 occurrences. Repeated entries or repeated
mentions from the same logical Source do not inflate the distinct-source count.
Deleted, historical and cross-room occurrences fail validation. Context and model
candidate inputs are detached before inference.

This evaluator does not discover other Sources, verify their filesystem receipts,
resolve identities or determine user intent. Future context providers must verify
those inputs. Matching a name and quote alone does not establish cross-document
identity. Existing-page discovery/linking remains Phase 19; the policy only accepts
an already trusted match and checks it against the current compiler snapshot.
Before publication, future integration must also include external context in its
freshness checks and durable read set. The current compiler rechecks its own Source
and Wiki snapshots, not separately supplied cross-source occurrence snapshots.

With no model or context, no semantic importance is invented: candidates remain
mentions. This is conservative lack of positive support, not proof that a candidate
could never merit a page. Exact quotes establish traceability; they do not prove
semantic entailment or guarantee the quality of an importance judgment.

## Summary integration and phase boundary

`SourceSummaryPlanner` accepts optional durability options as its third constructor
argument. Whenever semantic extraction runs, the planner evaluates the candidates
and labels them “Eligible for a Wiki page” or “Mention only”, with explanations.
Semantic reason quotes join the existing deduplicated Evidence section. All text
uses the summary's literal Markdown rendering. Assessment failure or timeout fails
the whole proposal, preventing an incomplete summary from being returned as success.

The result remains one proposed Source-summary write. No entity/concept page is
created, no existing page is linked, and no publication, queue consumption, compiled
pointer advancement or lifecycle acknowledgment occurs. UI and runtime startup are
unchanged. Later phases will turn eligible knowledge into linked, reconciled pages.

## Verification

Six new integration tests cover conservative mention retention; each semantic
criterion independently; all four contextual criteria; accumulation of reasons;
distinct-Source counting; invented grounds and model authority claims; missing or
invalid decisions; stale candidate evidence; unread pages; deleted/historical/foreign
occurrences; cancellation/failure propagation; and absence of page publication or
compiled-pointer advancement. Fixtures use the verified compiler/Raw pipeline and
deterministic models, not live inference.

All 619 unit tests passed. TypeScript and targeted lint passed; full lint reported
zero errors and 148 existing warnings. Whitespace checks passed.

Phase 19 is existing Wiki linking and awaits user instruction.
