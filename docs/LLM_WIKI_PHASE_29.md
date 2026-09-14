# Phase 29: Agent-built Wiki pages

Implemented 2026-09-14.

The Wiki is now built in two stages. Stage 1 stays deterministic: Cabinet captures raw evidence and publishes a quote-checked source summary at a readable slug (`wiki/sources/<slug>.md`). Stage 2 is a normal tool-enabled run of the selected Cabinet agent: it reads the summary and the current map, then creates and updates entity, concept, comparison and synthesis pages under `wiki/` while Cabinet enforces the boundaries.

## Using it

Choose a **Wiki agent** in Settings > Storage > LLM Wiki. On import, each source gets its checked summary, then the job advances through a `linking` stage where the agent performs the SCHEMA.md ingest protocol inside `wiki/`. When a batch drains, a `consolidate` job rebuilds `concept-table.md` and refreshes `overview.md`. Three buttons drive whole-wiki operations: **Rebuild overview and concept table** (`consolidate`), **Check Wiki health** (`lint`), and **Rebuild all Wiki pages** (`reprocess-all`, confirmed before enqueueing one reprocess job per active source version).

`wiki/SCHEMA.md` is bootstrapped once and then user-editable. `concept-table.md` and `overview.md` seed from templates only while they still carry the `<!-- cabinet-wiki:` marker. `index.md` is regenerated deterministically after every accepted pass; `log.md` is append-only, skill-format, idempotent per job.

## Safety model

- Raw evidence stays immutable: the runner snapshots `raw/` hashes (contents retained under 64 MB) and restores any agent modification, warns, and continues; when content was not retained a raw edit fails the pass.
- Writes outside `wiki/` are report-only warnings; the agent pass never reverts user files.
- Inside `wiki/` only the known areas (`sources`, `entities`, `concepts`, `comparisons`, `synthesis`) and root files are accepted; symlinks, other paths, oversized or executable Markdown (reusing the compiler's `validateWikiMarkdown`) are reverted with warnings.
- Source-summary pages keep protected frontmatter keys (`source_id`, `cabinet_id`, `current_version*`, `source_status`) and the `## Evidence` / `## Source provenance` sections; edits to them are reverted.
- Agent-written pages get frontmatter repair (title, type, created/updated, sources, tags). Inventory `markdownHash` values are refreshed for accepted pages so later Cabinet passes do not see them as foreign edits.
- Accepted changes are committed via `commitWikiPublication` under the Wiki root only. Agent stdout/stderr streams to `.cabinet-state/llm-wiki/agent-logs/<jobId>.log`; warnings and the report persist in `operations/<jobId>.json` and surface in the status payload and UI.

## Queue and workflow

`IngestionStatus` gains `linking`; `IngestionOperation` gains `consolidate` and `lint` (no Source identity, route `["linking","complete"]`, duplicate same-kind active jobs rejected). Every source route now ends `linking → complete`. Migration `006_llm_wiki_agent_ops.sql` rebuilds `llm_wiki_jobs` (create-new/copy/drop/rename) so the `llm_wiki_attempts` foreign key survives without rewriting.

Source renames are a verified `delete` + `write` pair: the planner detects an existing page with the same `source_id` at a different path and emits the delete first; the compiler accepts it and the inventory drops the old path.

## Verification

Unit: `test/wiki-agent.test.ts` (accept/repair/index/log, raw restore, out-of-scope report-only, executable content and protected-section reverts, timeout), `src/lib/llm-wiki/wiki-index.test.ts` (slugify, fallback, frontmatter, deterministic index), updated `queue.test.ts`, `compiler.test.ts` and `workflow.test.ts` (slugged paths, delete+write rename, auto-consolidate drain). E2E: the fake agent gains a stdin/argv `match` step; the tool-enabled pass writes `wiki/entities/test-entity.md` and the spec asserts it lands in `wiki/index.md` while every restricted inference call keeps its hardened flags.
