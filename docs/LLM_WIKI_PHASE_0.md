# LLM Wiki: Phase 0 repository audit and proposed mapping

Date: 2026-09-10. Repository baseline: `f51fede8` plus the existing working tree.

Scope: repository reconnaissance and architectural proposal only. No domain types, migrations, ingestion services, watchers, converters, or UI changes are implemented by this note. The supplied implementation plan is design input; its later-phase instructions are not authorization to execute those phases.

## Recommended Cabinet-specific architecture

Use one existing **root Cabinet** as the knowledge domain. Keep working files in their current locations, put immutable source versions and compiled Wiki pages inside that same root, and run ingestion in the existing Node daemon. Reuse SQLite, provider adapters, filesystem helpers, search, and history infrastructure. Add source-specific contracts and orchestration where the existing abstractions do not supply them.

Three important adaptations:

1. `.cabinet` is already a YAML **file**, not an available directory. Keep it; use a namespaced `.cabinet-state/llm-wiki/` directory inside the owning root Cabinet for new operational files.
2. Root Cabinets and rooms are different. `DATA_DIR` is the active root Cabinet; rooms are nested manifest-bearing directories. Existing API parameters called `cabinetPath` often mean a room-relative path. Do not use these values interchangeably with the proposed stable `cabinetId`.
3. Existing Markdown/HTML viewers support active content. Reuse parser libraries and viewer components selectively, but introduce an explicitly non-executable evidence reader and isolated HTML preview before displaying imported evidence through those paths.

## Existing architecture and reuse inventory

Paths below are repository-relative. Findings describe inspected code, not promises made in older PRDs.

| Area | Existing implementation and evidence | Mapping / gap |
| --- | --- | --- |
| Electron main process | `electron/main.cjs` starts the Next server and daemon as child processes, manages backend restarts, windows, packaging paths, and IPC. `electron/browser-views.cjs` handles browser surfaces. | Keep Electron responsible for desktop integration. Ingestion belongs in the daemon so browser/self-hosted deployments also work. |
| Preload / IPC | `electron/preload.cjs` exposes `CabinetDesktop` through `contextBridge`, including window, browser, read/write-file, and PDF actions. The main app window has `contextIsolation: true` and `sandbox: false`. | No new privileged ingestion bridge is necessary; use existing HTTP/daemon transport. Imported previews must not inherit this bridge. |
| Renderer | Next.js 16 App Router, React 19, Zustand stores under `src/stores/`, layout and editor components under `src/components/`. | Add source lifecycle/view state to existing UI conventions later, without moving ingestion into React. |
| Root Cabinet / workspace | `src/lib/runtime/runtime-config.ts`, `storage/path-utils.ts`, and `cabinets/cabinets.ts`: `DATA_PARENT_DIR` contains root Cabinets; `DATA_DIR` resolves the active one. Switching changes the shared `.home/home.json` pointer and requires process restart. | One imported vault should become one root Cabinet, not two rooms named Raw and Wiki. Only the active root is serviced initially. |
| Rooms / nested cabinets | `cabinets/rooms.ts`, `cabinets/server-paths.ts`, `cabinets/discovery.ts`: nested `.cabinet` manifests, relative paths, owning-cabinet lookup. | Retain room context on sources and compiler runs. Root ownership must be explicit rather than inferred from the nearest nested manifest. |
| Filesystem services | `storage/fs-operations.ts`, `path-utils.ts`, `page-io.ts`, `tree-builder.ts`, and `references.ts`. Pages may be standalone `.md`/`.mdx` or directories with `index.md`. | Reuse path resolution, tree invalidation, link support, and general I/O. Evidence promotion needs a dedicated immutable-write policy; ordinary page saving updates metadata and is not an evidence commit operation. |
| Imports | `storage/import-folder.ts` copies a chosen folder into a collision-free destination, caps at 500 MB / 5,000 files, skips dotfiles, symlinks, and executable extensions, invalidates the tree, and auto-commits. Folder and Notion API routes reuse it. Apple Notes has `lib/apple-notes/import.ts`; registry imports and CLI template imports are separate. | These are import entry points, not a normalization/versioning pipeline. Reuse useful validation, but generic folder import is not a lossless Obsidian import: it omits `.obsidian` and other hidden material and does not establish a new root Cabinet. |
| External knowledge | `knowledge-sources/store.ts` stores room-scoped folder connections in `.agents/.config/knowledge-sources.json`; records have UUIDs, provider, absolute path, policy, and browser/inline surface. | This is a folder/mount registry, not a logical document registry. Reference its mount identity/policy for managed files; do not overload it with every SourceVersion. |
| Watchers | `server/search/watcher.ts` watches visible `.md` content with a 150 ms debounce and `followSymlinks: false`. The daemon watches schedules; `server/telegram/gateway.ts` watches configuration. `storage/watchable-dirs.ts` supports diagnostics. | Chokidar 5 is already installed. Add narrow ingestion subscriptions within daemon lifecycle; do not turn the search watcher into an ingestion queue. Preserve watch-limit diagnostics. |
| SQLite | `server/db.ts` and `src/lib/db.ts` open the same `DATA_DIR/.cabinet.db`, enable WAL and foreign keys, and share SQL migrations through `lib/system/sql-migrations.ts` and `server/migrations/`. Existing tables cover sessions, messages, activity, job runs, tasks, and integrations. | Reuse this database/migration mechanism for operational ingestion tables and registry projections. Do not add another database engine or claim the entire existing DB is disposable. |
| Background work / jobs | `server/cabinet-daemon.ts` owns structured adapter runs, PTY sessions, cron schedules, HTTP/WebSocket events, and shutdown. `lib/jobs/job-manager.ts` stores job definitions under `.jobs`; conversation files live through `agents/conversation-store.ts`. | Background execution exists. No general durable, leased, multi-stage source-ingestion queue or converter worker pool was found in the inspected implementation. Add a focused queue, not a competing task scheduler. |
| Agent/provider abstraction | `agents/conversation-runner.ts`, `daemon-client.ts`, `provider-runtime.ts`, `provider-settings.ts`, and `adapters/{types,registry}.ts` provide provider/model selection, execution context, timeout, logs, run metadata, and results. | Compile through these interfaces. Existing CLI/MCP integrations are not a provider-independent evidence mutation API. Keep evidence writes in Cabinet services and validate compiler output before publishing. |
| Markdown / metadata | `markdown/to-html.ts`, `to-markdown.ts`, `frontmatter-text.ts`, `wiki-links.ts`; `gray-matter` and `js-yaml` are already dependencies. `page-io.ts` preserves arbitrary frontmatter keys on reads. | Reuse parsers and metadata conventions. Preserve original frontmatter separately from Cabinet-generated provenance to avoid collisions. |
| MDX / live JSX | `mdx/jsx.ts`, `mdx/registry.ts`, `mdx/live-code-eval.ts` and editor extensions support registered components and `jsx live` blocks. `markdownToHtml` applies these transforms and permits raw HTML; live code evaluates with `new Function`. | The current Markdown path is not the proposed untrusted reader. An injected function scope is not a security sandbox. Bypass MDX/live-code interpretation for normalized evidence. |
| Editor / viewers | `components/editor/editor.tsx` uses Tiptap; `stores/editor-store.ts` handles page state/autosave. `source-viewer.tsx` uses Monaco and HTML preview; PDF, notebook, image, LaTeX, Typst, and Office viewers already exist. | Introduce a source-detail composition around selected immutable version paths. Reuse passive viewers after checking their execution/network behavior; disable saves, notebook execution, and annotation writes for Raw. |
| Document identity | `src/types/index.ts` gives `PageData` and tree nodes a `path`; `server/search/index-builder.ts` uses virtual paths as page IDs. Mounts and some imported metadata have their own IDs. | No general stable document identity independent of path, nor Source/SourceVersion registry, was found. Add scoped opaque IDs, retaining human-readable slugs only for filenames/navigation. |
| History | `history/engine.ts` uses Git as history truth, explicit staging and actor attribution, with a per-cabinet `.cabinet-meta/file-history.jsonl` index. `history/agent-commit.ts`, `git/git-service.ts`, history APIs, and `editor/version-history.tsx` provide existing support. | Reuse audit/attribution for Wiki changes when Cabinet owns the Git repo. Git restore is not immutable Raw version storage; it may be unavailable for externally owned vaults. Source versions must work without Git. |
| Search | `server/search/index-builder.ts` uses in-memory FlexSearch over title/headings/tags/body; daemon startup rebuilds it, and the watcher updates it. `search-service.ts` and `/api/search` support room scoping and explicit cross-room search. | Full-text search already exists; it is not BM25 and needs no embeddings. Add Wiki-first filtering/ranking and explicit evidence/version lookup later. Do not index all historical normalized copies as ordinary current Wiki results. |
| Settings | Shared home config, YAML `.cabinet` manifests, room `.agents/.config` files, provider settings, and browser preferences such as `ui/editor-settings.ts`. | Persist feature/ingestion configuration on disk for daemon access; persist view preferences using browser conventions keyed by stable root/source IDs. Version selection is separate from view preference. |
| Security | `auth/request-gate.ts`, `src/proxy.ts`, daemon token/origin checks, traversal checks, and `knowledge-sources/store.ts::assertWritablePath`. Asset serving includes realpath/mount authorization checks. | Reuse authentication and mount policy. Lexical path checks alone do not stop symlink escape. New source APIs need canonical path authorization and immutable-layer checks across every mutation entry point. |
| Tests | Node test runner via `tsx`; `scripts/run-unit-tests.mjs` collects `test/` and `src/` tests into a temporary seeded data root. Playwright uses `test/support/harness.ts` for isolated app/daemon instances. | Reuse these harnesses. `npm test` is the full unit suite; `test:unit` currently runs only the update-system test. No new test framework needed. |
| Build / packaging | Next standalone output in `next.config.ts`; Electron Forge in `forge.config.cjs`; `scripts/prepare-electron-package.mjs` stages runtime content. Native SQLite/PTY handling and platform smoke scripts already exist. | A later converter must be staged explicitly for desktop, CLI, and self-hosted deployments. xberg is not in current package dependencies; runtime, licensing, binaries and platform availability remain to be validated. |

## Concrete storage mapping (proposal only)

```text
DATA_PARENT_DIR/
  .home/home.json                    existing active-root pointer
  .cabinet-state/                    existing shared install/runtime state
  <root Cabinet>/                    DATA_DIR while active
    .cabinet                        existing YAML manifest, preserve fields
    .cabinet.db                     existing SQLite database
    <existing notes and rooms>/     retained in place, human-owned
    Inbox/                          proposed configurable staging directory
    raw/<classification>/<slug-id>/
      manifest.yaml                 durable logical identity/lifecycle
      v1/
        original.<ext>              exact captured original
        source.md                   faithful non-executable Markdown
        assets/                     captured version assets
      v2/...
    wiki/
      sources/<slug-id>.md           one interpretation per logical Source
      entities/ concepts/ comparisons/ synthesis/
      index.md concept-table.md overview.md log.md
    .cabinet-state/llm-wiki/         proposed root-local namespace
      staging/<job-id>/             incomplete conversion/publication work
      cache/                        disposable derived content
```

The two `.cabinet-state` locations have different scopes. Existing `CABINET_INTERNAL_DIR` points to the shared parent location; **do not use it** for root-owned ingestion work. Derive the new location from the explicit root context. Check whether that root-local path already exists and what it contains before initialization. Do not use `.cabinet-meta` for this new subsystem: existing code already assigns it link/history responsibilities.

Suggested later manifest extension: `llmWiki` with `enabled: false` by default, schema version, stable root `cabinetId`, configured Inbox/Raw/Wiki relative paths, and `autoIngestInbox`. Merge fields atomically without replacing existing manifest metadata. Stable source and version IDs belong in durable source manifests; the database provides query projections. No original user file needs a new ID injected into its contents.

Existing `Inbox`, `raw`, or `wiki` folders must first be inventoried. Offer configuration of alternative paths if their current use conflicts. `raw/Inbox` is an explicitly configured staging alias only, with exclusion precedence designed so it remains watchable without watching the rest of Raw. Classification uses existing domain folders as suggestions, not authority to relocate notes or source histories.

Root-level Wiki introduces a real room-scoping decision: a room-scoped query must not silently expose summaries compiled from other rooms. Record originating room context and either restrict generated pages by their provenance scope or make root-wide Wiki access an explicit UI scope. MVP recommendation: root-wide compilation and retrieval only when root scope is selected; preserve existing room-scoped search behavior. Do not place `.cabinet` manifests in `raw/` or `wiki/`, which would accidentally create nested cabinets.

## Proposed module ownership and contracts

These paths are proposals, not files created in Phase 0.

| Proposed location | Responsibility | Existing dependency to reuse |
| --- | --- | --- |
| `src/lib/llm-wiki/types.ts` | Source, immutable SourceVersion, ingestion operation/status, root context, provenance and conversion result contracts | Existing TypeScript type conventions; no provider types in portable metadata |
| `src/lib/llm-wiki/config.ts` | Root identity, feature flags, path ownership and namespace collision checks | Cabinet manifest/YAML and atomic-write conventions |
| `src/lib/llm-wiki/source-store.ts` | Manifest validation, source identity, append-only version promotion, lifecycle updates, rebuildable registry projection | Filesystem/path helpers, gray-matter, js-yaml, existing DB connection |
| `src/lib/llm-wiki/normalizers/` | Format dispatch, deterministic Markdown normalization, xberg adapter contract | Existing metadata helpers; subprocess patterns, not viewer/export conversions |
| `src/lib/llm-wiki/compiler.ts` | Provider-independent compile/update/delete reconciliation contract and validation of proposed Wiki changes | Conversation runner, adapter registry, provider settings, history attribution |
| `server/ingestion/` | Queue claiming/recovery, narrow Inbox/managed watchers, converter subprocess lifecycle, publication orchestration | Existing daemon startup/shutdown, chokidar, database and event broadcast |
| `server/migrations/<next>_llm_wiki.sql` | Ingestion jobs/attempts, leases, source/version lookup projections, reconciliation state | Existing numbered SQL migrations; choose next number at implementation time |
| `src/app/api/sources/` and `src/app/api/ingestion/` | Authorized source/version reads, managed registration, enqueue/retry, lifecycle actions | Existing auth gates and daemon-client transport; daemon owns processing |
| `src/components/editor/source-detail.tsx` | Reader/Original/Markdown, selected version, concise job state | Existing viewer chrome, passive file viewers, Monaco read-only mode |
| `src/lib/markdown/evidence-to-html.ts` | Safe ordinary Markdown reader with sanitized output and controlled asset URLs | Existing remark/unified libraries, safe heading/link helpers, DOMPurify dependency |

Do not create a second global filesystem service, scheduler, provider manager, or vector database. A dedicated immutable-evidence store and ingestion queue are new domain behavior, not duplicates of page editing and cron scheduling.

## Lifecycle and durability decisions for later phases

**Identity.** Use an opaque stable Source ID and a root Cabinet ID; keep path and display slug mutable. Version identity includes source identity plus a monotonically allocated version number (and preferably its own immutable ID). Identical bytes in different registered sources do not automatically imply one logical Source. Rename correlation can use IDs, hashes, timing, and platform hints; ambiguous cases become reviewable rather than silently merged.

**Capture.** Wait for a stable write, capture bytes into job staging, hash the captured copy, and convert that same copy. Detect a file changing during capture and retry. Multi-file sources need an explicit dependency/asset capture policy; hashing only a Markdown or LaTeX entry file cannot detect changing images or includes. Never execute notebooks or source-code inputs as normalization.

**Queue.** Watchers only validate and enqueue; they never call models. Use transactional claims, bounded retries, lease expiry, and an idempotency key scoped to root/source or staging identity, operation, and captured content. Add a generation/converter-policy discriminator for deliberate reprocessing. Serialize source version allocation and Wiki publication at the appropriate scope. Existing cron definitions and conversation completion statuses are not a replacement for these states.

**Promotion.** Build a complete version on the same filesystem under staging, verify files/hashes, then publish to a previously unused `vN` directory. Update the manifest atomically after publication and update the SQL projection afterward. Filesystem and SQL are not one transaction: recovery must distinguish an incomplete staging directory, a complete orphaned version awaiting manifest attachment, a committed version with stale SQL, and a pending Wiki compilation. Validate job/source identity before adopting an orphan; never blindly choose the highest directory number.

**Current state.** Version bytes and version-local provenance stay immutable. Mutable current/superseded state belongs in the Source manifest/projection, not by rewriting old version files. Track current Raw version separately from the last successfully compiled version so failed compilation is visible. A newer valid evidence snapshot can remain committed while Wiki reconciliation is retried.

**Wiki writes.** Agents read relevant existing Wiki pages plus selected evidence; return proposed changes in staging. Cabinet validates paths, provenance, and output before publishing. Use a recoverable publication journal/plan for multi-page updates and an operation ID for log deduplication. Ordinary per-file atomic writes alone do not make an entire Wiki update atomic. Record portable claim/page support references in Wiki metadata or durable sidecars; SQL provenance lookup must be reconstructable from them.

**Deletion.** Missing managed input enqueues a lifecycle change, retains Raw versions, and triggers reconciliation. Permanent deletion is a separate explicit action, with reconciliation before physical removal. Existing generic page/folder deletion, rename, asset writes, history restore, and Electron file-write IPC must reject operations that would mutate published Raw. UI read-only controls alone are insufficient. Direct external disk edits cannot be prevented by application guards; hashes detect integrity violations and the store must report them rather than accept them silently.

**Durability.** Originals, normalized versions/assets, Source manifests, lifecycle state, Wiki pages/log, and provenance are durable. SQL source/version projections, full-text indexes, thumbnails, rendered HTML, and identity lookup caches are rebuildable. Queue intent/attempt records are operationally durable, not automatically reconstructable, especially manual reprocess/delete requests. Do not label the whole SQLite file or whole state namespace a disposable cache.

**Managed external files.** Reuse registered mount authorization and read-only policy. A read-only working source may be read and snapshotted into the owning writable Cabinet, never edited there by ingestion. Watch only explicitly authorized paths; do not recursively follow arbitrary symlinks. Root changes/restarts must release watches and recover only that root's jobs. Disabled auto-ingestion may report candidates but must not start conversion or model work until explicitly enqueued.

## Rendering and execution boundaries

The inspected HTML `source-viewer.tsx` iframe has no sandbox attribute. `website-viewer.tsx` permits scripts and same-origin behavior. These serve existing editable/application content and cannot be reused unchanged as the imported Original preview.

For imported HTML, use a separate no-bridge, no-script sandboxed preview with restrictive CSP, no same-origin privilege, intercepted navigation, and a version-scoped asset resolver. Default-deny remote scripts, CSS, images, iframes, form submissions, and tracking resources; any optional remote-resource permission must be explicit. Preserve the original bytes and apply presentation policy at render time. Serve source originals with safe response headers; a download or direct asset URL must not bypass the preview policy.

For normalized Markdown, disable JSX/MDX, live blocks, embedded applications, arbitrary HTML handlers, unsafe URL schemes, and automatic remote fetches. Sanitize generated HTML and control links/assets. Imported instructions remain document content, not agent policy: never mount imported `.agents`, `SKILL.md`, or instructions as trusted compiler configuration.

Use the existing provider abstraction, but do not mistake a provider's working directory for filesystem confinement. Prefer read-only evidence access and validated staged output; enforce provider permissions or isolated execution where supported before claiming immutability against agent tools. This remains a later implementation requirement, not a property of the current runtime.

## Obsidian compatibility

Preserve vault folder names, note paths, links, assets, and `.obsidian` configuration. Do not apply the existing generic importer's dotfile exclusion unchanged. A later vault-specific root import must distinguish preserving hidden files as inert data from enabling imported agent configuration. The current `createCabinet` scaffold and merge-style legacy migration are not a ready-made lossless vault adoption transaction.

Register selected editable notes as managed Sources without moving them. Snapshot into Raw and generate Wiki interpretation separately. Preserve existing links and introduce source-ID resolution for evidence references; a bare `[[source]]` basename is ambiguous when many versions contain `source.md`. Original and normalized asset paths must be resolved relative to the selected version, not the current page's display slug.

## Validation and next-phase entry conditions

Phase 0 used static source inspection. No app startup, live data migration, converter invocation, or runtime security testing was performed. No external xberg capabilities are assumed verified. Code tests/builds are not required to validate this documentation-only change; whitespace and referenced-file checks are appropriate here.

Later implementation should use the existing isolated unit and Playwright harnesses for: identity surviving rename, source-scoped deduplication, unchanged saves, dependency changes, immutable v1 after v2, partial writes, crash recovery across each promotion boundary, failed compilation after evidence commit, source deletion/restoration, read-only mounts, symlink escape, room/root isolation, unsafe HTML/JSX, and blocked Raw writes through all existing mutation surfaces. Reuse format viewers only after version selection and read-only behavior are tested. Packaging checks must cover the actual converter executable and assets, including offline/missing-converter behavior.

Recommended next authorization boundary is Phase 1 only: specify the contracts and manifest schema around the root/room distinction and durable identity. Subsequent queue/watchers/conversion/compiler/UI phases remain unimplemented. Before enabling any ingestion, validate configured directory ownership, the safe reader/preview boundary, provider write constraints, and converter distribution. These are concrete compatibility dependencies, not reasons to redesign the existing application wholesale.

## Documentation discrepancies found

- Root `AGENTS.md` refers to `docs/AGENTS.md`, which is absent. The related `docs/CLAUDE.md` was inspected instead.
- `docs/CLAUDE.md` says “No database”; both current processes actually open SQLite. Its older data-root description also needs to be read alongside the current root-Cabinet runtime code.
- `data-locations/server-registry.ts` describes SQLite as a cached file index, while current migrations also contain operational/integration tables. Do not infer safe whole-database deletion from that description.

These existing discrepancies are recorded here, not repaired as part of Phase 0.
