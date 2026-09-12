# Phase 24 — Wiki navigation and log maintenance

Completed 2026-09-11, using the canonical implementation sequence.

## Composition and scope

`withWikiMaintenance` decorates a Wiki planner inside `PlanningWikiCompiler`. It
projects the planner's proposed writes and deletions onto the existing scoped Wiki
snapshots, then prepares index, overview, concept-table and operation-log changes.
These writes receive the same path/content checks, expected hashes, plan hashing
and stale-input revalidation as knowledge writes. The base planner cannot write
reserved navigation/log paths or duplicate targets.

Use `withWikiMaintenance(new SourceSummaryPlanner(...))` for ingestion. The update
and deletion reconciliation factories accept a final `maintainNavigation` boolean;
passing true adds the same projection after reconciliation, including deleted
Source-summary status. Maintenance is opt-in for these composed services and does
not start a daemon worker or change existing caller defaults.

Projection stays inside the compiler's root or room namespace and recognizes the
sources, entities, concepts, comparisons and synthesis areas. It excludes navigation
files from their own counts and never lists another room. Explicit foreign page
metadata and duplicate logical Source summaries fail for review. Limits are 96 base
changes plus up to four maintenance writes, and 300 projected snapshots.

## Generated navigation

- `index.md` lists Wiki pages by family, with deleted/archived pages in a separate
  historical section. Proposed page removals disappear from the projected list.
- `overview.md` reports counts by family and historical status, with links to the
  directory, concept table and log. It describes page counts, not verified facts,
  completed ingestion or a model-generated synthesis.
- `concept-table.md` lists concept-page links, categories and declared status.
  Missing metadata is explicitly unspecified rather than assumed active.
- `log.md` holds append-only records of prepared source operations and proposed
  page writes/removals. It never claims publication or reconciliation completion.

Names and table cells are escaped literally; relative paths encode spaces, percent
signs, parentheses and Markdown-sensitive characters. Titles use front matter when
present, with the filename as a navigation fallback. Status comes from page metadata,
except that the current target Source's status overrides its matching metadata.
This phase does not load every Source registry entry or infer page support from
prose; provenance remains the authority for active knowledge support. Unrelated page
metadata can therefore lag lifecycle state until its reconciliation is proposed.

## Preserve human notes

The three generated navigation sections use narrowly formatted inert HTML comments
as boundaries, with a SHA-256 digest of their generated content. New files receive
headings and managed sections. Existing files without a managed section retain all
original text and receive an appended section. Subsequent maintenance replaces only
the verified section, preserving surrounding bytes and notes.

Duplicate/mismatched boundaries or edits inside a generated section fail for review
rather than overwrite user changes. The compiler allows only these exact maintenance
comment forms; other HTML and executable content retain the earlier rejection rules.
These delimiters do not grant model instructions or executable capabilities.

## Append-only operation log

Prepared ingest, source-update and source-delete entries record Source title/ID,
version transition or removal, and base knowledge-page actions. Their displayed time
is the stable Source snapshot's updatedAt timestamp, not a claimed publication time.
Generated navigation is a rebuildable projection, not a separate factual operation.
A navigation-only empty base plan creates a missing log heading without fabricating
an ingest event.

Entries carry a deterministic key from Cabinet/room, operation, Source, current
version and lifecycle revision, plus a digest of the base proposal. Identical retries
leave the log unchanged. A different base proposal under an already recorded operation
key fails for explicit review. New entries preserve the entire previous log prefix.
This is proposal-level deduplication, not a durable transaction journal or log rotation
policy. File/context bounds fail explicitly instead of truncating old log entries.
Future restoration, permanent deletion or other runtime operations must log their
actual completed outcomes through the publication/lifecycle integration.

## Phase boundary and verification

No Wiki file, provenance index, Raw evidence, compilation pointer or lifecycle state
is written by maintenance. Navigation/log text is structural metadata and has empty
factual support sets; it is not asserted as externally grounded knowledge. Persistent
page/provenance publication, queue/provider wiring and the full acceptance workflow
remain outstanding in the canonical implementation plan.

Five new integration tests cover all four proposals, room-scoped projected links,
unchanged retries, preservation of surrounding notes and old logs, filename/table
escaping, updated concept inventory, historical navigation after deletion, retained
pending lifecycle status, edited generated sections, reserved targets, conflicting
log payloads, page removal and empty-plan logging. Tests use isolated fixture writes
to emulate future publication where needed; the compiler itself does not publish.

All 643 unit tests passed. TypeScript and targeted lint passed; full lint reported
zero errors and 148 existing warnings. Whitespace checks passed.

Phase 25 is Obsidian managed-source integration and awaits user instruction.
