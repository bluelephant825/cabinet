# Phase 30: Wiki knowledge graph (deterministic layer)

Implemented 2026-09-16.

Cabinet now projects the LLM Wiki into a typed knowledge graph at `wiki/graph.json` and renders it in a Cabinet-native Sigma.js viewer. The pipeline ports the design of Understand Anything's `understand-knowledge` skill (deterministic scan, alias normalization, merge, QA checklist, article/entity/topic/claim/source vocabulary) to TypeScript on top of Cabinet's existing Wiki domain. Nothing is imported from that project: its pipeline is Python scripts plus agent prompts, and its Graphology dependency lives in its dashboard only. Cabinet uses `graphology` server-side for community detection and `sigma` client-side for rendering.

## Data model

`src/lib/llm-wiki/graph/types.ts`. Nodes: `page` (with `pageKind` source-summary/entity/concept/comparison/synthesis/overview/concept-table), `source` (raw Source), `topic` (tags, entity subtype/category, concept-table clusters), `entity` and `claim`. Node ids are prefixed by type: `page:<wiki-relative stem>`, `source:<source_id>`, `topic:<slug>`, `claim:<provenance knowledge id>`. Every edge carries `provenance` (`explicit` | `inferred`), `extractor` (`wikilink`, `frontmatter`, `provenance`, `concept-table`, `source-manifest`, `llm:<model>`), `confidence` (1 for explicit edges) and optional `evidence` quotes with source/version/offsets. Explicit edge types: `links_to`, `cites`, `categorized_under`, `part_of`, `asserts`, `supported_by`. Inferred types (Phase 31): `related`, `similar_to`, `builds_on`, `contradicts`, `exemplifies`, `authored_by`. The file also carries `layers` (one per wiki area, one per cluster, Sources, Other), per-node Louvain `community`, `stats` and `warnings`.

## Pipeline

- `graph/scan.ts` (pure): page nodes from area + frontmatter, summary = first paragraph after the H1, `[[wikilinks]]` and relative Markdown links resolved by exact stem, then unique basename, then unique slug (ambiguous or missing targets become warnings), `cites` from frontmatter `sources:` and `source_id`, topics from tags and entity classification, `part_of` from the concept-table Cluster rows, claim nodes from provenance knowledge (`claim`, `relationship`, `qualification`) with `asserts` and evidence-carrying `supported_by` edges.
- `graph/merge.ts`: explicit wins over inferred, name-based remap of inferred entities onto existing pages, alias normalization (reversed aliases swap endpoints, unknown types become `related` with a warning), dangling edges dropped, layers, seeded Louvain communities, then `validateWikiGraph`. Structural issues throw, so a broken graph is never published.
- `graph/schema.ts`: alias tables and the QA checklist ported from the graph-reviewer (required fields, duplicate ids, prefix/type consistency, referential integrity, confidence range, layer coverage, self-edges, orphans, evidence-free inferred edges).
- `graph/store.ts`: `durableText` write, 64 MB read cap, `kind` marker check, cached header for status polls.
- `server/ingestion/wiki-graph.ts`: `WikiGraphBuilder.refresh(jobId)` walks the Wiki root, joins the inventory provenance and `SourceStore`, scans, merges, writes `wiki/graph.json` and commits it through `commitWikiPublication`. It never throws; failures are warnings and the previous graph stays in place.

`WikiWorkflow` refreshes the graph after every agent pass (`linkingStage`), including consolidate and lint, and records `graphWarnings` and stats in `operations/<jobId>.json`. `status()` exposes `graph` (header) and per-job `graphWarnings`.

## Protection

`wiki/graph.json` is Cabinet-maintained like `index.md` and `log.md`: the agent prompts and guardrails say so, `SCHEMA.md`'s Directory Layout lists it, and `WikiAgentRunner.enforce` restores it when the agent modifies or deletes it (warning recorded).

## Viewer

`src/components/wiki/knowledge-graph-viewer.tsx` (client-only through `next/dynamic`) with pure helpers in `knowledge-graph-model.ts`. The app shell routes any `graph.json` to it before the generic code viewer and falls back to the code editor once if `GET /api/llm-wiki/graph?path=` answers "Not a Wiki graph" (the route only serves `<wikiRoot>/graph.json` of the enabled cabinet). Features: ForceAtlas2 layout, community colors, search with Enter-to-focus, node-type and edge-type filters, show-inferred switch and min-confidence slider, layer select, hover neighborhood highlighting, detail panel with summary, tags, Open page / Open source links and edges grouped by type with provenance badges, confidence, descriptions and evidence quotes; warnings disclosure in the header; WebGL fallback list. Settings > Storage > LLM Wiki links to the graph and shows node/edge counts and graph warnings per job.

## Verification

Unit: `src/lib/llm-wiki/graph/{scan,merge,schema}.test.ts`, `src/components/wiki/knowledge-graph-model.test.ts`, `test/wiki-graph.test.ts` (builder on a temp root, rewrite, failure keeps prior file, header cache), `test/wiki-agent.test.ts` (graph.json restore). `npx tsc --noEmit`, `npm run lint` (0 errors) and `npm run build` pass. Smoke on the pilot cabinet (338 pages): 1537 nodes, 7248 edges, one graph request per page load, no console errors.

## Limits

Full rebuild on every pass (a few hundred milliseconds for a few hundred pages; the inventory fingerprint is stored for later incremental work). Layout runs synchronously in the browser (200/60/20 ForceAtlas2 iterations by graph size). Inferred edges appear only after Phase 31.
