# Phase 31: Wiki knowledge graph (LLM enrichment)

Implemented 2026-09-16. Builds on Phase 30.

The deterministic graph from Phase 30 is now enriched with model-extracted entities, claims and implicit relationships, ported from Understand Anything's `article-analyzer` prompt and run through Cabinet's restricted Wiki inference adapter (no tools, temp cwd, JSON only). Enrichment is incremental (per-page content-hash cache), evidence-bound (every emitted item carries an exact quote from its page) and never authoritative: the explicit layer always wins in the merge.

## Model seam

`src/lib/llm-wiki/graph/analyze.ts` defines `GraphAnalysisModel.analyze(input, signal)`; `WikiInferenceModel` implements it on the same `infer` path as summaries and semantic extraction. `WikiWorkflow` accepts `Partial<GraphAnalysisModel>` so test fakes without `analyze` still run graph jobs (deterministic only, with the warning "No analysis model available; deterministic graph only").

## Prompt and output contract

`analyzeWikiBatch(batch, existingIds, model, modelName, signal)` sends up to 10 pages (grouped by layer, body after frontmatter capped at 6000 chars) plus a bounded `existingIds` list (batch pages, same-area pages, top-degree nodes, cached entity ids). The prompt frames all page fields as untrusted data, tells the model which explicit links already exist so they are not repeated, and asks for `entity` and `claim` nodes plus edges of type `builds_on` (0.8), `contradicts` (0.9), `exemplifies` (0.7), `authored_by` (0.6), `cites` (0.7), `related` (0.5), `similar_to` (0.5); the weight is the edge `confidence` and defaults per type. Expected counts follow the original prompt (2-8 entities, 1-4 claims, 1-5 edges per page).

Validation runs inside `validatedInference`, so an invalid response is fed back as corrective text and retried up to `WIKI_INFERENCE_ATTEMPTS`: exact field sets, at most 64 nodes / 128 edges, `pagePath` must be a batch page, `quote` (<= 300 chars) must be an exact substring of that page's body and for nodes must contain the name, edge endpoints must be new nodes of this response or `existingIds` members, no self-edges, known edge types only, weight in 0..1. Node ids are recomputed by Cabinet (`entity:<slug(name)>`, `claim:<page stem>-<slug(name)>`), so the model cannot inject ids. Every inferred edge gets `provenance: "inferred"`, `extractor: "llm:<provider>/<model>"` and `evidence: [{ pagePath, quote }]`.

## Cache

`.cabinet-state/llm-wiki/graph/analysis/<markdownHash>.json` holds one `AnalysisRecord` per page (`promptVersion`, `pagePath`, `markdownHash`, `model`, nodes and edges whose evidence lives in that page). `WikiGraphBuilder.refresh(jobId, { analyze })` loads all records, keeps those whose hash matches a current page and whose `promptVersion` equals `GRAPH_PROMPT_VERSION`, prunes the rest, analyzes only uncached pages (3 batches in flight, each under the job `AbortSignal` and `WIKI_INFERENCE_TIMEOUT_MS`), writes new records with `durableText`, and merges every valid record as the inferred layer. A failed batch becomes a warning (`Graph analysis failed for batch N (<page>): ...`) and the job continues. The result reports `analyzed`, `cached` and `failedBatches`, recorded under `graph` in `operations/<jobId>.json`.

## Queue operation `graph`

`IngestionOperation` gains `graph` (route `["linking", "complete"]`, no Source identity, duplicate-active rejection like consolidate/lint). Migration `server/migrations/007_llm_wiki_graph_op.sql` rebuilds `llm_wiki_jobs` and `llm_wiki_attempts` following the 006 pattern because SQLite CHECK constraints enumerate operations. `WikiWorkflow.graphStage` advances the job to `linking`, runs `refresh` with analysis when the provider is available, completes the job, appends an idempotent `## [date] graph | Knowledge graph` entry to `wiki/log.md` and commits it. A completed `consolidate` auto-enqueues `graph` (`graph:auto:<ts>`) unless one is active. The Settings action `graph` ("Rebuild knowledge graph") requires an available provider but no page-building agent; `jobOperations.graph` labels the job "Knowledge graph analysis" and the status line shows analyzed/cached/failed counts.

## Viewer

Search dims non-matching nodes instead of hiding them (`nodeMatches` split from `nodeVisible`); the "Show inferred" switch and confidence slider now filter real data; inferred edges are drawn thinner in a lighter color (Sigma 3 ships no dashed edge program); the detail panel shows provenance, confidence, description, `extractor` and evidence quotes for inferred edges.

## Fixed along the way

`test/support/fake-agent-cli.ts` consumed positional steps for provider probes spawned outside a cabinet cwd and executed their file writes at the repo root (stray `wiki/entities/test-entity.md`). Only match-less steps are now consumed positionally.

## Verification

`npx tsx --test src/lib/llm-wiki/graph/*.test.ts src/lib/llm-wiki/queue.test.ts src/lib/llm-wiki/workflow.test.ts test/wiki-graph.test.ts test/wiki-agent.test.ts src/components/wiki/*.test.ts`: 87 pass. `npx tsc --noEmit` clean, `npm run lint` 0 errors, `npm run build` passes, `npx playwright test e2e/wiki-workflow.spec.ts` 4 passed (now asserts `wiki/graph.json` contains `page:entities/test-entity`). Manual run on the pilot cabinet (339 pages, antigravity-cli / gemini-3.8-flash-high): job completed, 39 pages analyzed, 90 inferred edges with quote evidence, deterministic layer intact; 32 of 39 batches were rejected by the provider's request-rate limit and degraded to warnings.

## Limits

- Provider rate limits are surfaced as failed-batch warnings, not retried with backoff; rerunning "Rebuild knowledge graph" picks up only the uncached pages.
- Cross-page inferred edges live in the record of the page holding the quote; when the other endpoint's page changes and its entity is not re-emitted, the edge is dropped as dangling at merge time.
- Changing `GRAPH_PROMPT_VERSION` invalidates the whole cache.
- Deferred: GraphRAG access for agents, 1-hop neighborhoods in ingest prompts, `?node=&hops=` API, tour/learn mode, graph-driven lint hints.
