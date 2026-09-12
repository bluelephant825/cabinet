# Cabinet LLM Wiki: Current Implementation Plan

Updated 2026-09-12, after Phase 27 and the Raw folder-layout/file-preview corrections in My Study.

## Numbering clarification

The original document contains two numbering schemes: its main Phase 0–36
headings and a later “Updated implementation sequence” numbered 0–28. Work in
this task has followed the latter sequence. This revision uses **implementation
Phase 0–28 as the only execution numbering**. The original detailed headings below
are renamed **Design reference 0–36**, preserving their content for context.
Any remaining “Phase N” cross-references inside that preserved design material
refer to its original design numbering, not the execution checklist below.

The original **Phase 21: Reader / Original / Markdown UI** is **implementation
Phase 13**, delivered in this task. The original **Phase 17: Wiki reconciliation
on Source updates** is **implementation Phase 21**. Implementation Phase 22
(deletion reconciliation) is also delivered. Implementation Phase 23 (external
identity resolution) is also delivered. Implementation Phase 24 (Wiki navigation
and log maintenance) is also delivered. Implementation Phase 25 (Obsidian managed
notes) is also delivered. Implementation Phase 26 (explicit recovery services and
optional-lookup failure isolation) is delivered. Phase 27 now connects the usable My Study workflow and is the most recently delivered step.
Original Phase 22 (version selector) corresponds to implementation Phase 14.

## Canonical execution checklist

“Delivered” means the scope recorded in the repository's individual phase reports,
not that every end-to-end production acceptance scenario is already operational.
Phases 15–24 deliver compiler and reconciliation **proposals**. They do not publish
Wiki pages or advance compilation pointers. Inference is behind injected model
contracts. Phase 27 connects a restricted live provider, queue consumer and durable publisher for source summaries, shared-concept mentions and navigation. See its report for the boundaries of automatic reconciliation.

| Phase | Work | Status |
| --- | --- | --- |
| 0 | Repository audit | Delivered within documented scope |
| 1 | Source + SourceVersion domain model | Delivered within documented scope |
| 2 | Cabinet filesystem/source registry | Delivered within documented scope |
| 3 | Durable ingestion queue | Delivered within documented scope |
| 4 | Chokidar Inbox watcher | Delivered within documented scope |
| 5 | Managed-source watcher | Delivered within documented scope |
| 6 | SourceNormalizer abstraction | Delivered within documented scope |
| 7 | xberg adapter + worker | Delivered within documented scope |
| 8 | YAML/provenance + manifest schema | Delivered within documented scope |
| 9 | Classification | Delivered within documented scope |
| 10 | Initial Raw v1 creation | Delivered within documented scope |
| 11 | Source update → Raw vN+1 | Delivered within documented scope |
| 12 | Source deletion lifecycle | Delivered within documented scope |
| 13 | Reader / Original / Markdown UI | Delivered within documented scope |
| 14 | Version selector UI | Delivered within documented scope |
| 15 | WikiCompiler interface | Delivered within documented scope |
| 16 | Karpathy-style source summaries | Delivered within documented scope |
| 17 | Entity/concept extraction | Delivered within documented scope |
| 18 | Durability rules | Delivered within documented scope |
| 19 | Existing Wiki linking | Delivered within documented scope |
| 20 | Provenance model | Delivered within documented scope |
| 21 | Update reconciliation | Delivered within documented scope |
| 22 | Deletion reconciliation | Delivered within documented scope |
| 23 | Wikidata/Wikipedia identity resolution | Delivered within documented scope |
| 24 | Wiki index/overview/concept-table/log maintenance | Delivered within documented scope |
| 25 | Obsidian managed-source integration | Delivered within documented scope |
| 26 | Failure recovery | Delivered within documented scope |
| 27 | Usable My Study workflow + end-to-end integration tests | Delivered; two-note Codex pilot completed |
| 28 | Optional search improvements | Optional; not started |

## Remaining phases and integration requirements

28. **Optional search improvements:** improve retrieval after the core workflow
    works; embeddings remain optional and rebuildable.

### Phase 27 — Usable My Study workflow + end-to-end integration tests

**Outcome:** a user can select existing notes in My Study, generate a grounded Wiki,
open captured evidence in Reader / Original / Markdown, and see subsequent source
changes reflected in the Wiki through the application. Component tests or generated
proposals alone do not satisfy this phase.

#### Cabinet-specific mapping

The user has grouped the two imports under `Notes/`. Treat My Study as one Wiki
Cabinet with this layout:

| Path relative to My Study | Role |
| --- | --- |
| `Notes/Apple Notes/` | Editable imported Apple Notes, registered as managed sources |
| `Notes/Eureka/` | Editable imported Obsidian notes, registered as managed sources |
| `raw/` | Immutable captured source versions and their evidence metadata; excluded from Git history to avoid duplicating evidence and binary attachments |
| `wiki/` | Published summaries, concepts, links and navigation across both imports; completed publications commit the affected Markdown pages |
| `Inbox/` | Optional entry point for future imports; existing notes stay under Notes |

Verify the current layout at onboarding rather than relying on old paths. Preserve
original files and folder organization. No second Cabinet or root `.obsidian`
directory is required for these imported Markdown folders. Resolve attachments and
relative links from their existing locations within the selected source scope;
report missing or unsupported references clearly.

#### Required implementation

1. **Folder onboarding and controls.** Provide an application entry point to enable
   the Wiki for My Study, select either or both source folders, inspect note counts
   and import warnings, and choose a small initial selection or a larger batch.
   Generalize the root-only Obsidian capture integration to imported Markdown
   folders. Register stable managed-source identities without moving originals;
   repeated onboarding must not duplicate sources. Show progress, failures and
   retry actions in plain language.
2. **Agent and queue execution.** Connect the ingestion queue, normalization,
   classification, Raw capture and compilation to Cabinet's existing configured
   provider runtime. Supply the Wiki workflow's trusted instructions and restricted
   model adapters as part of the feature; users must not need to create an agent
   or install a skill for each folder. Explain any missing provider setup in the
   application. Treat note contents as evidence, not agent instructions. Support
   cancellation, bounded retries and recovery without duplicate work.
3. **Durable Wiki publication.** Publish validated Wiki pages and provenance with
   durable transaction/recovery records and fresh source/read-set checks. Persist
   or rebuild the complete provenance inventory needed to find affected pages.
   Advance compilation pointers and complete queue jobs only after successful
   publication. Include source summaries, cross-folder concept links and the Wiki
   index, overview, concept table and operation log where applicable. Commit only
   the completed publication's `wiki/` paths; keep `raw/`, runtime state and
   publication receipts out of Git history.
4. **Ongoing source changes.** Connect managed-source observation to actual update,
   deletion and restoration reconciliation. Preserve captured history and independent
   support from other notes. Acknowledge lifecycle work only after completed Wiki
   publication; permanent Raw deletion remains gated on completed reconciliation.
5. **Visible source reading.** Make captured sources discoverable from the original
   note and from Wiki evidence links. Opening a capture must expose Reader /
   Original / Markdown and its version selector; ordinary notes remain editable.
   Include clear empty, pending and failed states so users understand when a capture
   is not yet available. Verify these paths in the running application.
6. **Imported-note fidelity.** Exercise Apple Notes images/attachments and Obsidian
   wikilinks, relative attachments and embeds. Capture supported local dependencies
   within validated boundaries and track dependency-only changes where supported.
   Display explicit warnings for unresolved or unsupported cases; document the exact
   limitations rather than implying complete vault backup or rendering support.

#### Verification and completion criteria

- Start with an isolated fixture matching `My Study/Notes/Apple Notes/` and
  `My Study/Notes/Eureka/`, including duplicate filenames, shared concepts, local
  attachments, Obsidian links and missing references.
- Verify onboarding through the application produces real Raw versions and published
  Wiki pages with evidence links across both folders, without changing originals or
  requiring per-folder agent/skill setup. Repeating it creates no duplicate sources.
- Verify Reader / Original / Markdown and historical version selection through the
  user interface, including navigation from working notes and Wiki evidence.
- Verify edits, deletion, restoration and supported attachment-only changes update
  the correct published knowledge while retaining independent evidence and history.
- Exercise provider failure, cancellation, restart, partial publication, stale reads
  and retries across the connected pipeline. Jobs must never report success while
  publication or required reconciliation remains incomplete.
- Run the original end-to-end acceptance scenarios against the connected services
  and appropriate automated/UI checks. Follow with a small, explicitly selected
  My Study pilot using the configured live provider before reporting the workflow
  usable; do not silently process the entire collection.
- Record the verified user steps, test results and remaining format limitations in
  the Phase 27 report. Phase 28 remains optional and separate.

Phase 27 is implemented within the boundaries recorded in `docs/LLM_WIKI_PHASE_27.md`.
My Study is enabled with Codex and exactly two authorized notes have been captured
and published. The remaining collection has not been ingested. Ask before proceeding
to optional Phase 28.

## Verification and implementation record

The most recent implementation run passed 666 unit tests, TypeScript, a production build, the Codex workflow browser test and lint
with zero errors (148 existing lint warnings). Detailed implementation boundaries
and verification are recorded in `docs/LLM_WIKI_PHASE_0.md` through
`docs/LLM_WIKI_PHASE_27.md`; the running changelog is `PROGRESS.md`.

## Original architecture and design references

The following material preserves the supplied plan's architecture, design details,
acceptance scenarios and constraints. It is reference material; the checklist above
controls execution order and status.

# Cabinet LLM Wiki Ingestion Architecture

## Objective

Implement a local-first LLM Wiki system inside Cabinet based on the Karpathy LLM Wiki method.

Each Cabinet represents one knowledge domain. An imported Obsidian vault normally becomes one Cabinet.

The architecture must maintain a strict separation between:

1. **Human/source material**
2. **Versioned source evidence**
3. **LLM-maintained knowledge**
4. **Rebuildable indexes and operational state**

Do not turn Cabinet into a conventional RAG application. The LLM Wiki is the primary knowledge layer. Search indexes and embeddings may support retrieval, but they must remain secondary and rebuildable.

The intended high-level architecture is:

```text
Cabinet
│
├── Inbox/                      # staging area for new sources
│
├── notes/ or existing vault/   # optional human-editable material
│
├── raw/                        # versioned immutable source evidence
│   └── <classification>/
│       └── <source-id>/
│           ├── manifest.yaml
│           ├── v1/
│           │   ├── original.ext
│           │   ├── source.md
│           │   └── assets/
│           └── v2/
│               ├── original.ext
│               ├── source.md
│               └── assets/
│
├── wiki/                       # LLM-owned compiled knowledge
│   ├── sources/
│   ├── entities/
│   ├── concepts/
│   ├── comparisons/
│   ├── synthesis/
│   ├── index.md
│   ├── concept-table.md
│   ├── overview.md
│   └── log.md
│
└── .cabinet/                   # machine state; rebuildable where possible
    ├── schema/config
    ├── ingestion state
    ├── source registry
    ├── search indexes
    └── external identity cache
```

Existing Obsidian vault content must not be destructively reorganized merely to support this architecture.

---

# Fundamental design rules

## Rule 1 — One Cabinet, not separate Raw and Wiki Cabinets

`raw/` and `wiki/` are different layers of the same knowledge system.

Do not create a separate Cabinet for each.

Conceptually:

```text
Cabinet = knowledge domain

human workspace = editable material
raw/            = versioned evidence memory
wiki/           = compiled understanding
```

The Wiki must always be able to refer back to evidence within the same Cabinet.

---

## Rule 2 — Inbox is staging

`Inbox/` is where new, not-yet-managed material enters the system.

The basic lifecycle for a new source is:

```text
Inbox
  ↓
detect
  ↓
queue
  ↓
normalize
  ↓
classify
  ↓
create Source identity
  ↓
create immutable Raw version
  ↓
compile into Wiki
```

An item sitting in Inbox is not yet part of the durable evidence corpus.

If backward compatibility with an existing `raw/Inbox/` convention is required, treat it as an Inbox alias, not as immutable Raw evidence.

---

## Rule 3 — Raw versions are immutable; sources may evolve

Do NOT treat the conceptual Source itself as immutable.

Instead:

```text
Source
  ├── v1 immutable
  ├── v2 immutable
  ├── v3 immutable
  └── ...
```

This is essential for:

- Jupyter notebooks
- Word documents
- Typst documents
- LaTeX documents
- editable Markdown
- source code
- evolving research notes
- any externally managed document

The key invariant is:

> **Raw versions are immutable; sources may evolve.**

Never modify an old Raw version in place.

---

## Rule 4 — Separate Source identity from Source version

A logical source has a stable identity.

Example:

```text
source_id: coffee-analysis
```

Its content may evolve:

```text
coffee-analysis
  ├── v1
  ├── v2
  └── v3
```

Conceptually:

```ts
interface Source {
  id: string;
  mode: "snapshot" | "managed";
  status: "active" | "deleted" | "archived";
  currentVersionId: string | null;
  managedPath?: string;
}

interface SourceVersion {
  id: string;
  sourceId: string;
  version: number;
  contentHash: string;
  originalPath: string;
  markdownPath: string;
  createdAt: string;
  status: "current" | "superseded";
}
```

Wiki provenance should point to the stable Source and, where necessary, to the specific SourceVersion.

---

## Rule 5 — Distinguish snapshot sources from managed sources

Introduce two source modes.

### Snapshot source

Typical examples:

```text
downloaded PDF
web clip
archived article
scanned paper
static reference document
```

Behavior:

```text
Inbox
  ↓
Raw v1
  ↓
Wiki
```

No ongoing synchronization is assumed.

### Managed source

Typical examples:

```text
Obsidian Markdown
DOCX
ipynb
Typst
LaTeX
source code
working research documents
```

Behavior:

```text
editable working file
       ↓
change detected
       ↓
new immutable Raw version
       ↓
incremental Wiki reconciliation
```

The working file is not itself immutable evidence.

---

## Rule 6 — Always preserve the original

Never replace the original document with its Markdown conversion.

Example:

```text
raw/science/coffee-analysis/
├── manifest.yaml
├── v1/
│   ├── original.ipynb
│   ├── source.md
│   └── assets/
└── v2/
    ├── original.ipynb
    ├── source.md
    └── assets/
```

For an archival HTML source:

```text
raw/technology/european-tech-sovereignty/
├── manifest.yaml
└── v1/
    ├── original.html
    ├── source.md
    └── assets/
```

`original.ext` preserves provenance.

`source.md` is the canonical semantic representation used by agents.

---

## Rule 7 — Markdown is the canonical AI representation

Do not standardize Raw sources on HTML.

Use:

```text
Original format
      ↓
normalized Markdown
      ↓
LLM Wiki
```

HTML should be generated for presentation at render time.

Conceptually:

```text
ORIGINAL
preservation / provenance
      ↓
MARKDOWN
semantic representation
      ↓
HTML DOM
presentation
```

The normalized Markdown must remain ordinary Markdown rather than executable MDX when the source is untrusted.

---

## Rule 8 — `wiki/sources/` does NOT contain normalized sources

This distinction is critical.

```text
raw/.../vN/source.md
```

means:

> Faithful normalized representation of a specific version of the original source.

Whereas:

```text
wiki/sources/<source>.md
```

means:

> LLM-written interpretation of the evolving logical Source.

The latter may contain:

- summary
- key claims
- important evidence
- relevant entities
- concepts
- contradictions
- implications
- relationships
- links to other Wiki pages
- provenance back to Source / SourceVersion

Never have xberg write directly to `wiki/sources/`.

---

# Design reference 0: Repository reconnaissance

Before changing code, inspect Cabinet thoroughly.

Determine:

- Electron main-process structure
- preload/IPC architecture
- renderer architecture
- Cabinet/workspace/vault model
- filesystem abstraction
- current import pipeline
- existing file watchers
- Markdown renderer
- MDX renderer
- editor architecture
- database/storage layer
- search/indexing implementation
- agent/provider abstraction
- settings/preferences system
- job/task infrastructure
- current document identity model
- existing version/history support
- security boundaries
- test framework
- packaging/build setup

Do not introduce duplicate infrastructure if Cabinet already provides an equivalent abstraction.

Particularly determine whether Cabinet already has:

- SQLite
- filesystem service
- background workers
- task queue
- file registry
- document IDs independent from paths
- Markdown renderer
- source metadata parser
- front-matter utilities
- full-text search
- agent tool interfaces
- file history or snapshot infrastructure

Produce an architecture note before major implementation.

All paths and filenames in this plan are conceptual. Adapt them to Cabinet's existing conventions.

---

# Design reference 1: Core domain model

Introduce explicit domain types before implementing watchers.

Suggested conceptual interfaces:

```ts
type IngestionStatus =
  | "discovered"
  | "queued"
  | "normalizing"
  | "classifying"
  | "promoting"
  | "compiling"
  | "reconciling"
  | "complete"
  | "failed"
  | "needs-review";

interface IngestionJob {
  id: string;
  cabinetId: string;
  sourceId?: string;
  inputPath: string;
  contentHash: string;
  operation: "create" | "update" | "delete" | "reprocess";
  status: IngestionStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

interface Source {
  id: string;
  cabinetId: string;
  mode: "snapshot" | "managed";
  status: "active" | "deleted" | "archived";
  currentVersionId?: string;
  managedPath?: string;
}

interface SourceVersion {
  id: string;
  sourceId: string;
  version: number;
  contentHash: string;
  originalPath: string;
  markdownPath: string;
  assetsPath?: string;
  originalFormat: string;
  createdAt: string;
  status: "current" | "superseded";
  converter?: {
    name: string;
    version: string;
  };
}

type SourceViewMode =
  | "reader"
  | "original"
  | "markdown";
```

Do not make the operational database the source of truth for Source content or Wiki knowledge.

The filesystem should remain portable.

Database state should mainly contain:

- queue state
- source registry
- hashes
- managed paths
- version mappings
- timestamps
- caches
- search indexes
- model/index versions
- UI preferences

---

# Design reference 2: Inbox watcher and durable ingestion queue

Use `chokidar` in the Electron/Node side of Cabinet.

The Inbox watcher must NOT perform ingestion itself.

Its responsibility is only:

```text
filesystem event
      ↓
validate
      ↓
enqueue
```

Use write stabilization similar to:

```ts
awaitWriteFinish: {
  stabilityThreshold: 1500,
  pollInterval: 100
}
```

Ignore:

```text
.DS_Store
temporary files
editor swap files
partial downloads
Cabinet-generated files
wiki/**
raw/**
.cabinet/**
```

Use SHA-256 or equivalent content hashing for idempotency.

The same content must not be processed twice merely because chokidar emitted multiple events.

Persist queue state so Cabinet can recover after:

- application restart
- crash
- model failure
- xberg failure
- power interruption

On startup, jobs stranded in processing states must be reconciled safely.

Expose:

```text
Auto-ingest Inbox       ON/OFF
```

When OFF:

```text
Inbox
5 items awaiting ingestion

[Ingest all]
```

Watcher events must never directly invoke an LLM.

---

# Design reference 3: Managed-source watcher

Add a second watcher conceptually separate from Inbox ingestion.

Do NOT watch all of Raw or the Wiki.

Watch only explicitly registered managed source paths.

Example:

```text
notes/research/foo.md
external/project.docx
notebooks/experiment.ipynb
```

The semantics are:

```text
file changed
   ↓
wait until stable
   ↓
hash
   ↓
same as current version?
  ├── yes → ignore
  └── no
       ↓
enqueue update
```

File deletion should enqueue:

```text
operation: delete
```

not immediately remove Raw evidence.

The managed-source watcher must be debounced and hash-based.

---

# Design reference 4: Source normalization service

Create a normalization abstraction.

```ts
interface SourceNormalizer {
  supports(file: SourceFile): boolean;

  normalize(
    file: SourceFile
  ): Promise<NormalizedSource>;
}
```

Implement format-specific behavior behind this abstraction.

## Markdown

For `.md`:

- do not run xberg unnecessarily
- parse front matter
- normalize line endings
- normalize assets
- preserve content

## HTML

For `.html`:

```text
original.html
      ↓
xberg extraction
      ↓
source.md
```

Preserve `original.html`.

## PDF / Office / LaTeX / Typst

Use xberg to produce Markdown.

Target formats include at minimum:

```text
.pdf
.doc
.docx
.odt
.ppt
.pptx
.tex
.latex
.typ
.typst
```

## Jupyter

Initially support:

```text
.ipynb
   ↓
xberg
   ↓
source.md
```

Preserve the original notebook.

Do not attempt notebook round-trip editing as part of this feature.

Future Jupytext integration may handle notebook-aware editing independently.

---

# Design reference 5: xberg adapter

Wrap xberg behind a Cabinet-specific adapter.

```text
Cabinet
   ↓
XbergAdapter
   ↓
xberg
```

Suggested interface:

```ts
interface DocumentConversionResult {
  markdown: string;
  metadata: Record<string, unknown>;
  assets: ExtractedAsset[];
  warnings: string[];
}
```

Record converter name/version.

Run expensive extraction outside the renderer and preferably outside the Electron main event loop.

Use existing Cabinet worker infrastructure if available.

---

# Design reference 6: YAML metadata and Source manifest

Store document-level metadata in the normalized Markdown front matter.

Example:

```yaml
---
source_id: coffee-analysis
source_version: 3

title: Coffee Analysis
source_type: notebook
original_filename: coffee-analysis.ipynb
original_format: ipynb

language: en

imported_at: 2026-09-10T18:00:00+02:00
sha256: ...

conversion:
  tool: xberg
  version: ...
---
```

Also maintain a small Source-level manifest:

```yaml
source_id: coffee-analysis
mode: managed
status: active
current_version: 3
managed_path: ../../notebooks/coffee-analysis.ipynb

versions:
  - version: 1
    hash: ...
    status: superseded

  - version: 2
    hash: ...
    status: superseded

  - version: 3
    hash: ...
    status: current
```

Do not put thousands of extracted entities in YAML.

Front matter and manifests are for identity, provenance, metadata and lifecycle.

---

# Design reference 7: Source classification

Classify new Sources before final Raw placement.

Prefer existing Cabinet categories.

```text
source
   ↓
inspect taxonomy
   ↓
choose existing category
   ↓
create new category only when needed
```

Classification belongs primarily to the logical Source.

Future SourceVersions should normally stay under the same Source directory.

If the subject changes substantially, allow explicit reclassification.

Do not silently move large source histories based on a single model decision.

---

# Design reference 8: Create initial immutable Raw version

For a new Source:

```text
Inbox/foo.ext

       ↓

raw/<category>/<source-id>/
├── manifest.yaml
└── v1/
    ├── original.ext
    ├── source.md
    └── assets/
```

`v1` is immutable once committed.

Use atomic filesystem operations where practical.

---

# Design reference 9: Updating a managed Source

When a managed Source changes:

```text
working document
      ↓
hash differs
      ↓
normalize current content
      ↓
create vN+1
```

Example:

```text
raw/research/coffee-analysis/
├── manifest.yaml
├── v1/
├── v2/
└── v3/
```

Never overwrite:

```text
v2/source.md
```

with v3 content.

Then compare:

```text
vN → vN+1
```

at both deterministic and semantic levels.

Detect where practical:

- added sections
- removed sections
- modified claims
- new entities
- removed entities
- new concepts
- changed numerical results
- altered conclusions
- changed references

Pass this delta into Wiki reconciliation.

---

# Design reference 10: Source deletion semantics

Deleting a managed working file must NOT immediately destroy its Raw history.

Instead:

```text
managed file deleted
       ↓
Source.status = deleted
       ↓
Raw versions retained
       ↓
Wiki provenance reconciled
```

Record:

```yaml
status: deleted
deleted_at: ...
```

Distinguish:

### Remove from active knowledge

Source no longer participates in normal synthesis or current-source search.

Raw evidence is retained.

### Restore

A deleted Source can be reactivated if its managed source returns or the user restores it.

### Permanently delete

This is an explicit destructive operation.

Before deleting Raw evidence:

```text
find Wiki claims supported by Source
        ↓
remove provenance contribution
        ↓
check for alternative supporting Sources
        ↓
keep / mark unsupported / remove claims
        ↓
reconcile Wiki
        ↓
delete Raw history
```

Require an explicit user action for permanent deletion.

---

# Design reference 11: Optional Raw version retention policy

Do not assume every binary version should be kept forever.

Support a future/configurable retention policy.

Possible modes:

```text
Keep all versions
Keep significant versions
Keep latest + previous
```

MVP may default to:

```text
Keep all versions
```

for correctness and simplicity.

For large files, consider future content-addressable storage:

```text
.cabinet/objects/<sha256>
```

This can deduplicate identical binaries/assets across versions.

Do not make content-addressable storage mandatory for MVP.

---

# Design reference 12: Semantic analysis model

Perform one semantic analysis rather than separate entity/tag/link systems.

Produce candidate semantic nodes.

## Entity

An identifiable thing:

```text
person
organization
place
species
product
software
paper
book
institution
drug
disease
technology
event
```

## Concept

An abstract durable idea:

```text
method
theory
mechanism
policy
framework
strategy
phenomenon
principle
topic that accumulates knowledge
```

## Tag

Lightweight navigation metadata.

Do not make AI tags a competing semantic knowledge system.

## Suggested Link

Not a semantic type.

It is:

```text
semantic node
      +
matching existing Wiki page
      =
candidate link
```

---

# Design reference 13: Entity/concept durability test

Do not create Wiki pages for every detected noun.

Create or update a page when one or more are true:

- materially important to understanding a Source
- already exists in Wiki
- occurs across multiple Sources
- participates in important relationships
- useful for future synthesis/retrieval
- explicitly important to user
- central to Cabinet domain

Incidental mentions remain mentions.

---

# Design reference 14: Wiki compiler

Implement separately from normalization.

```ts
interface WikiCompiler {
  ingest(
    source: Source,
    version: SourceVersion
  ): Promise<WikiCompilationResult>;

  reconcileUpdate(
    source: Source,
    previousVersion: SourceVersion,
    currentVersion: SourceVersion
  ): Promise<WikiCompilationResult>;

  reconcileDeletion(
    source: Source
  ): Promise<WikiCompilationResult>;
}
```

Before writing, examine relevant existing Wiki pages.

A single ingestion or update may modify:

```text
wiki/sources/
wiki/entities/
wiki/concepts/
wiki/comparisons/
wiki/synthesis/
wiki/index.md
wiki/concept-table.md
wiki/overview.md
wiki/log.md
```

---

# Design reference 15: Source-summary pages represent logical Sources

Each logical Source receives one main source-summary page.

Example:

```text
wiki/sources/coffee-analysis.md
```

This page represents the current compiled understanding of the Source, not a single Raw version.

Suggested front matter:

```yaml
---
title: Coffee Analysis
type: source-summary
source_id: coffee-analysis
current_version: 3
source_status: active
---
```

Suggested body:

```markdown
# Coffee Analysis

## Summary

## Key claims

## Evidence

## Entities

## Concepts

## Relationships

## Changes from previous version

## Contradictions / qualifications

## Related Wiki pages

## Source provenance
```

Do not duplicate the entire source.

---

# Design reference 16: Provenance model

The Wiki must distinguish:

```text
Claim
Concept
Relationship
Summary statement
```

from the Sources supporting them.

Conceptually:

```text
Source A v3 ──supports──┐
                       ▼
                     Claim
                       ▲
Source B v1 ──supports──┘
```

At minimum store enough information to answer:

- which Source supports this knowledge?
- which version did it come from?
- is that Source still active?
- is the claim still supported elsewhere?

Do not require verbose provenance inline in every paragraph if that damages readability.

A machine-side provenance index is acceptable if the Wiki retains portable source references.

---

# Design reference 17: Wiki reconciliation on Source updates

When Source v3 becomes v4:

```text
v3
 ↓ semantic diff
v4
```

Determine which Wiki knowledge is affected.

For every removed or changed claim:

```text
does another active Source support it?

yes
 → retain

no
 → update / mark stale / remove
```

Avoid the naive strategy:

```text
delete everything derived from Source
rebuild everything
```

Prefer incremental reconciliation.

For an MVP, selective page regeneration is acceptable if provenance remains correct.

---

# Design reference 18: Wiki reconciliation on Source deletion

When a Source is marked deleted:

1. remove it from current-source synthesis
2. keep its Raw versions
3. mark provenance as inactive/deleted
4. determine whether knowledge remains supported elsewhere
5. update affected Wiki pages where necessary

Do not automatically erase historical claims solely because a Source was removed from active use.

For permanent deletion, provenance reconciliation must happen before physical Raw deletion.

---

# Design reference 19: Wikidata and Wikipedia identity enrichment

After semantic extraction:

```text
semantic node
     ↓
Wikidata entity resolution
     ↓
stable QID
     ↓
Wikipedia sitelink
```

Entity/concept front matter may include:

```yaml
external:
  wikidata: Q...
  wikipedia: ...
```

Validate using:

- label
- aliases
- description
- semantic type
- source context

Ambiguous results should be reviewable.

---

# Design reference 20: Strict provenance for Wikipedia-derived knowledge

Separate identity enrichment from knowledge enrichment.

## Identity enrichment

May happen automatically.

Example:

```text
Coffea arabica
Wikidata: Q...
Wikipedia: ...
```

## Knowledge enrichment

Do NOT silently insert Wikipedia facts into the Wiki.

If Wikipedia content contributes factual knowledge:

```text
Wikipedia article
       ↓
capture as Source
       ↓
raw/external/wikipedia/<source-id>/v1/
       ↓
Wiki compiler
```

This preserves:

```text
Wiki factual claim
      ↓
Source
      ↓
Raw evidence
```

---

# Design reference 21: Reader / Original / Markdown UI

Implement:

```text
View

○ Reader
○ Original
○ Markdown
```

Prefer a compact segmented control.

## Reader

Render the current SourceVersion's `source.md`.

Support attractive:

- typography
- headings
- images
- tables
- blockquotes
- code
- footnotes
- links
- safe callouts

Reader HTML is generated at runtime.

## Original

Show the original file for the currently selected SourceVersion.

Examples:

```text
PDF → PDF viewer
HTML → sandboxed original preview
image → image viewer
ipynb → notebook preview where available
```

## Markdown

Show the normalized Markdown of the selected SourceVersion.

For Raw versions this should initially be read-only.

---

# Design reference 22: Version selector in source UI

Because Sources may evolve, augment the three-view design with a lightweight version selector where multiple Raw versions exist.

Conceptually:

```text
Coffee Analysis            Version: v3 ▾

Reader | Original | Markdown
```

Possible menu:

```text
v3   Current     Sep 10
v2   Superseded  Sep 07
v1   Superseded  Sep 01
```

Selecting v2 should show:

```text
Reader   → v2/source.md
Original → v2/original.ext
Markdown → v2/source.md
```

The default remains the current version.

Do not clutter the UI for single-version snapshot Sources.

---

# Design reference 23: HTML security

Imported HTML is untrusted.

Never load arbitrary HTML with privileged Electron access.

Original HTML preview must have:

```text
no Node integration
no preload bridge
no filesystem access
no Cabinet APIs
no script execution by default
navigation intercepted
safe CSP
sandboxing
```

Remote resource policy should explicitly cover:

```text
remote images
remote CSS
remote JavaScript
iframes
event handlers
tracking resources
```

Never treat imported HTML as trusted MDX.

---

# Design reference 24: View persistence

Remember Source view preferences.

Defaults may be:

```text
HTML        → Reader
PDF         → Original or Reader
Markdown    → Reader
DOCX        → Reader
LaTeX       → Reader
Jupyter     → Reader
```

Allow immediate override.

The selected version and selected view are separate concerns.

---

# Design reference 25: Search and retrieval

Do not make embeddings a prerequisite.

The Wiki should function with:

```text
Wiki index
+
full-text/BM25
+
Wiki links
```

Preferred query flow:

```text
User question
      ↓
search wiki/
      ↓
read compiled pages
      ↓
verify against current or historical Raw versions when necessary
```

Embeddings may later support:

- semantic search
- related-page suggestions
- fuzzy entity matching
- large-corpus discovery

They remain rebuildable.

---

# Design reference 26: Imported Obsidian vaults

Treat each imported Obsidian vault as one Cabinet by default.

Do not automatically move original vault notes into Raw.

For editable existing notes:

```text
vault note
   ↓
register as managed Source
   ↓
snapshot v1 into Raw
   ↓
Wiki compiler
```

On future save:

```text
vault note changed
   ↓
managed-source watcher
   ↓
new Raw version
   ↓
Wiki reconciliation
```

This preserves:

```text
vault notes = human-owned/editable

raw/ = immutable version history

wiki/ = AI-owned compiled knowledge
```

Do not break existing Obsidian links or folder structure.

---

# Design reference 27: AI cleanup

Do not introduce uncontrolled AI rewriting into Raw.

Default normalization should be deterministic.

Examples:

```text
format conversion
Unicode normalization
line-ending normalization
asset handling
front-matter normalization
structural Markdown normalization
```

If later introducing AI-assisted repair:

1. preserve original file
2. preserve/reproduce pre-AI extraction
3. record model and transformation provenance
4. never silently alter substantive meaning
5. create a new SourceVersion if the canonical Raw representation changes materially

---

# Design reference 28: Error handling

Ingestion and updates must be recoverable.

A failure during:

```text
xberg conversion
classification
Raw version creation
LLM compilation
semantic reconciliation
Wikipedia lookup
filesystem move
```

must not lose the Source.

Possible UI:

```text
⚠ Update failed

Source: Coffee Analysis
Working file is unchanged.
Current Raw version remains v3.

[Retry]
[Details]
[Ignore]
```

A failed creation of v4 must never corrupt v3.

Wikipedia/Wikidata failure must not fail main ingestion.

---

# Design reference 29: Avoid watcher feedback loops

Mandatory.

Inbox watcher:

```text
Inbox only
```

Managed-source watcher:

```text
registered working files only
```

Never treat writes under:

```text
raw/
wiki/
.cabinet/
```

as source changes.

Moving a file from Inbox into Raw must not create another ingestion job.

Wiki compiler writes must never trigger source ingestion.

---

# Design reference 30: Operation log

Maintain append-only:

```text
wiki/log.md
```

Record operations such as:

```text
ingest
source-update
source-delete
source-restore
source-permanent-delete
wiki-reconcile
entity-create
entity-update
concept-create
concept-update
external-identity
```

Example:

```markdown
## [2026-09-10T16:40:00Z] source-update | Coffee Analysis

Source version:
v3 → v4

Changes:
- 2 claims updated
- 1 concept added
- 1 entity removed from current version
- 3 Wiki pages reconciled
```

Readable by humans and agents.

---

# Design reference 31: Test strategy

Add unit, integration and UI tests.

## Fixture A — enriched Markdown Web Clip

Verify:

```text
Markdown bypasses unnecessary conversion
metadata survives
Raw v1 created
source summary created
entities/concepts identified
incidental mentions filtered
Reader renders
Markdown view works
```

## Fixture B — styled HTML Web Clip

Verify:

```text
original.html remains preserved
source.md has semantic content without CSS noise
metadata survives
Reader works
Original is sandboxed
Markdown view works
Wiki compiler consumes source.md
```

## Fixture C — evolving Jupyter notebook

Test:

```text
experiment.ipynb
   ↓
v1 created

edit notebook
   ↓
change detected
   ↓
v2 created

verify:
v1 unchanged
v2 current
semantic delta detected
Wiki reconciled
version UI works
```

## Fixture D — evolving DOCX

Test:

```text
proposal.docx
  ↓
v1

modify
  ↓
v2
```

Verify xberg reconversion and Wiki reconciliation.

## Fixture E — deletion

Delete managed Source.

Verify:

```text
Source marked deleted
Raw history remains
Wiki provenance reconciled
source no longer active
```

Then test permanent deletion separately.

Also test:

```text
duplicate events
partial write
large Source
failed conversion
failed LLM call
restart with queued update
ambiguous Wikidata match
offline mode
restored deleted Source
same-content save
renamed managed file
moved managed file
```

---

# Design reference 32: Rename and move handling

Do not assume path equals Source identity.

A managed Source should have a stable Source ID independent of its path.

When possible distinguish:

```text
rename/move
```

from:

```text
delete + new Source
```

Use platform/file identity hints where reliable, plus hashes and timing.

If uncertain, provide reconciliation logic rather than silently duplicating a Source.

This is especially important for Obsidian vault reorganization.

---

# Design reference 33: Feature flag and migration

Implement behind a feature flag initially.

```text
llmWiki.enabled
```

Do not destructively migrate existing Cabinets.

Initialize missing infrastructure safely.

Never overwrite existing:

```text
Inbox
raw
wiki
```

without inspecting their current use.

Migration must be reversible where practical.

---

# Design reference 34: Observability

Expose meaningful Source lifecycle state.

Example:

```text
Coffee Analysis.ipynb

✓ Managed source
✓ v4 detected
✓ Converted with xberg
✓ Semantic changes analyzed
✓ Raw v4 stored
✓ 3 Wiki pages updated
✓ Current version: v4
```

For a deleted Source:

```text
Coffee Analysis.ipynb

○ Source removed from workspace
✓ Raw history retained
✓ Wiki reconciled

[Restore]
[Delete permanently…]
```

Keep user-facing UI concise while allowing detailed inspection.

---

# Design reference 35: Durable versus rebuildable data

## Durable

```text
working user files
original Raw versions
Raw normalized Markdown
Source manifests
Wiki pages
Wiki log
user metadata
source lifecycle state
provenance relationships
external source provenance
```

## Rebuildable

```text
full-text index
vector index
embeddings
Wikidata lookup cache
thumbnail cache
rendered HTML
temporary chunks
temporary semantic diffs
```

Deleting a search index must never destroy knowledge.

---

# Design reference 36: Later enhancements outside MVP

Do not let these delay the initial architecture:

```text
automatic embeddings for everything
Neo4j
full graph database
complex ontology management
Jupyter round-trip editor
automatic OCR correction
multi-Cabinet cross-linking
automatic Wikipedia corpus expansion
recursive crawling
continuous external research
automatic binary delta storage
Git-like branch/merge semantics
```

Design interfaces so they can be added later.

---

# Original execution-sequence note

The sequence from this section is now the canonical checklist at the top of this
document. Use that checklist for numbering and current implementation status.

Do not implement the next execution phase by bypassing abstractions established earlier.

After each meaningful phase:

```text
run tests
run typecheck
run lint
review security boundaries
review data-loss scenarios
document architecture
commit independently where practical
```

---

# Acceptance scenario A — New HTML source

```text
User drops article.html into Inbox.

Chokidar detects it.

Queue waits until stable.

Cabinet hashes it.

A new Source is created.

xberg generates source.md.

Cabinet classifies Source.

Cabinet creates:

raw/<category>/<source-id>/
    manifest.yaml
    v1/
        original.html
        source.md

Wiki compiler updates:

wiki/sources/
wiki/entities/
wiki/concepts/
wiki/index.md
wiki/overview.md
wiki/log.md

Source opens with:

Reader | Original | Markdown
```

The original HTML remains untouched.

---

# Acceptance scenario B — Managed Jupyter notebook

```text
User registers:

notebooks/experiment.ipynb

as a managed Source.

Cabinet creates:

raw/research/experiment/
    manifest.yaml
    v1/
        original.ipynb
        source.md

User edits and saves notebook.

Managed-source watcher detects change.

Hash differs.

Cabinet creates v2.

v1 remains unchanged.

Semantic diff identifies changed results.

Wiki reconciles only affected knowledge.

UI shows:

Version: v2

Reader | Original | Markdown
```

---

# Acceptance scenario C — Managed Word document deletion

```text
proposal.docx is a managed Source.

Current Raw version = v5.

User deletes proposal.docx.

Cabinet detects deletion.

Source.status becomes deleted.

v1–v5 remain in Raw.

Source is removed from active synthesis.

Wiki provenance is reconciled.

Claims supported by other Sources remain.

Claims supported only by proposal.docx are marked stale,
updated, or removed according to Wiki policy.

User may:

Restore source

or

Delete permanently
```

Permanent deletion explicitly reconciles provenance before removing Raw history.

---

# Instructions to the coding agent

Before implementing:

1. Inspect the actual Cabinet repository.
2. Identify existing abstractions.
3. Adapt this architecture rather than forcing filenames/classes literally.
4. Do not duplicate existing systems.
5. Preserve backwards compatibility.
6. Avoid destructive migrations.
7. Keep security boundaries explicit.
8. Prefer small testable modules.
9. Keep xberg behind an adapter.
10. Keep provider/model logic behind Cabinet's AI abstraction.
11. Keep filesystem knowledge provider-independent.
12. Treat external content as untrusted.
13. Do not make embeddings mandatory.
14. Never silently modify Raw versions.
15. Never confuse Source identity with file path.
16. Never overwrite an old SourceVersion.
17. Do not create Wiki pages for every noun.
18. Never add Wikipedia factual content without provenance.
19. Never physically delete Raw evidence as a side effect of a filesystem watcher.
20. Reconcile Wiki provenance before permanent Source deletion.

If the existing repository materially conflicts with this plan, preserve the architectural invariants and adapt the implementation.

The most important invariants are:

```text
Inbox = staging for new Sources

Working source = editable

Source = stable logical identity

SourceVersion = immutable evidence snapshot

Raw versions = immutable

Sources may evolve

source.md = canonical semantic representation of a SourceVersion

Wiki = LLM-maintained compiled knowledge

Wiki source page = current understanding of logical Source

Original ≠ Markdown ≠ Reader presentation

Entities/concepts = durable semantic knowledge

Suggested links = relationships, not ontology types

Tags = lightweight metadata

Wikipedia identity ≠ Wikipedia evidence

Wiki claims retain provenance

Deleting a working file ≠ deleting evidence

Permanent deletion requires provenance reconciliation

Indexes/embeddings = rebuildable

Filesystem knowledge remains portable across AI providers
```
