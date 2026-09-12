# Phase 19 — Existing Wiki linking

Completed 2026-09-11, following the updated implementation sequence.

`matchExistingWikiPages` matches extracted semantic candidates against the current
compiler Wiki snapshots. It performs no filesystem reads, inference, network access,
external identity resolution or fuzzy search. The compiler owns receipt verification,
room isolation, read-set hashing and stale-input revalidation.

## Local matching policy

Pages must be in the scoped `entities/` or `concepts/` area and have front matter
with the corresponding `type`, a `title` and, for automatic linking, a matching
`category` from semantic extraction. Optional `aliases` are an array of up to 32
labels. Labels are bounded to 160 characters. Matching normalizes Unicode NFC,
case and whitespace; filenames and body headings are not identity fallbacks.
Explicit foreign Cabinet/room metadata and non-active status are excluded.

One exact title/alias match with the same semantic kind and category is linked.
Multiple matching pages require review, including when a fully typed match competes
with a page lacking a category. A single match without a category also requires
review. Wrong-category pages do not qualify. Malformed participating front matter
or aliases fail the proposal rather than silently discarding identity information.
Each result identifies the candidate, its linked/review/unmatched status and sorted
candidate targets with their titles, paths and read hashes.

This is conservative local lexical matching, not proof of global identity. Two
homonyms of the same category can still be indistinguishable when only one is
represented locally. External disambiguation remains Phase 23. A trusted application
identity choice from the Phase 18 context can resolve a review result or identify a
legacy page without typed metadata; it must reference the correct scoped page family
and exact read hash. These overrides are not supplied by model output or imported
instructions, and their identity correctness remains the trusted caller's responsibility.

## Compiler integration

The Source-summary planner performs local matching after extraction and before
durability assessment. Linked targets become existing-page durability evidence,
without duplicate reasons when a trusted choice is present. Matching candidates
link to their existing page rather than suggesting another page. Related Wiki pages
are deduplicated by path and sorted. Ambiguous matches remain plain candidate text
with a review notice and do not count as existing-page durability support.

All links are relative to the actual Source-summary location, so renamed summaries
and nested room namespaces work. Path components encode spaces, percent signs,
parentheses and other Markdown-sensitive characters. Titles, aliases and candidate
labels are rendered literally through the existing Markdown escaping. The shared
URL encoder also protects Raw/original links with parentheses in their paths.

Target pages remain part of the compiler read set. A page edited or removed during
planning invalidates the result. The result is still exactly one proposed Source
summary write; linking does not edit target pages, create duplicate entity/concept
pages, mutate Raw, publish files, consume jobs or advance compilation pointers.
No new UI or live model/provider runtime is started. Relationship extraction and
cross-page provenance/reconciliation remain later work.

## Verification

Four new integration tests cover alias matching and room-scoped encoded links,
existing-page durability, preservation of target files, ambiguity/missing categories,
wrong types/categories and foreign metadata, trusted selections and stale hashes,
malformed aliases, and target edits during inference. Existing compiler tests retain
scope, symlink, deletion and current-evidence protections.

All 623 unit tests passed. TypeScript and targeted lint passed; full lint reported
zero errors and 148 existing warnings. Whitespace checks passed.

Phase 20 is the provenance model and awaits user instruction.
