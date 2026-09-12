# Phase 27: Usable My Study workflow

Implemented 2026-09-11. Phase 28 has not started.

## Using it

In My Study, open **Settings > Storage > LLM Wiki**. The feature is enabled and its Wiki provider is **Codex**. Preview `Notes/Apple Notes` and `Notes/Eureka`, choose notes, and select **Build Wiki**. Folder previews report skipped items and capture warnings. Progress, pause/resume and explicit retry controls are in the same section. Only selected notes become managed sources; originals stay editable in their existing folders.

Choose **Open Wiki** to browse published navigation and summaries. On a registered original note, choose **Read captured source (Reader / Original / Markdown)**. The capture displays those three views and a version selector when history exists. Wiki evidence links also open the captured version, including historical versions after later updates. No separate agent or installed skill is required: the daemon supplies the trusted workflow and calls the selected existing CLI provider.

The Wiki provider selection is independent of other Cabinet agents. Codex uses existing local authentication with a read-only sandbox, tool restrictions, user configuration/rules disabled, and a temporary working directory. Note contents are passed as untrusted evidence. Claude remains supported as an alternative but was not usable with this account's organization access during the pilot.

## Connected implementation

- Folder onboarding supports imported Markdown folders without requiring a root Obsidian vault. Stable source bindings prevent duplicate registration. Selected-folder boundaries, symlink checks, size limits, and fresh previews protect capture scope.
- The daemon consumes queued source work through normalization, immutable Raw capture, grounded source summaries, semantic candidates and validated Wiki publication. Provider failures and cancellation remain visible and retryable. Retry reuses the same capture when appropriate.
- Publication maintains a durable journal and provenance inventory, checks source and Wiki inputs again before writing, and completes the source compilation pointer and queue job only after publication. Interrupted publication can roll forward; conflicting edits require review. This is recoverable multi-file publication, not atomic visibility of every file to concurrent readers.
- History follows the Cabinet-specific layer boundary: a completed Wiki publication commits only the affected `wiki/` Markdown pages, attributed to the LLM Wiki actor. Immutable `raw/` captures, attachments and Wiki runtime receipts remain outside Git history; the Raw root is maintained in `.git/info/exclude` so evidence cannot be staged accidentally.
- Generated source summaries and shared-concept mention pages reconcile source updates, deletion and restoration. Shared pages require independent current support from at least two sources. Matching labels group attributed mentions without asserting entity identity. Index, overview, concept table and operation log are published alongside content.
- Registered originals are observed for subsequent changes. Supported attachment-only changes are polled and create a new immutable capture even when note bytes remain identical. Original paths and bytes are preserved.
- Ordinary imported notes remain editable. Captured evidence is read-only, and encoded relative Wiki links resolve to the correct source rather than another file with the same basename.

## Live My Study pilot

The user authorized choosing one short note from each folder and explicitly selected Codex after Claude returned an organization access error. Exactly these two notes were processed successfully:

1. `Notes/Apple Notes/Programming/Alternative space characters.md`
2. `Notes/Eureka/Inbox/How-to-migrate-from-the-legacy-structure.md`

Both operations completed using Codex. Both sources have one captured version and current compilation pointers. The Wiki contains two source summaries and its index, overview, concept table and operation log. These unrelated notes produced no shared-concept page; cross-folder shared support is exercised in the isolated fixture. The migration note was treated as source text, and its instructions were not executed. Two unresolved-reference warnings remain visible for that capture.

All 242 original Markdown files covered by the pre-pilot checksum inventory remain unchanged. The preview found 237 eligible notes and 70 skipped entries, including non-note items and unsupported filenames; the entire collection was not ingested. Only the two selected sources are registered for ongoing observation.

## Verification

Automated coverage includes an isolated My Study layout with both folders, duplicate note names, shared concepts, unchanged originals, repeat onboarding, edit/delete/restore publication, independent support retention, provider failure and retry, cancellation, journal recovery, intervening/new Wiki edits, attachment boundaries, unsupported embeds, dependency-only updates after worker restart, and historical reader links.

The isolated browser workflow runs a real app and daemon with a controlled CLI test double. It verifies settings onboarding, Codex selection and restricted invocation, completed publication, Wiki evidence navigation, original-to-capture navigation, all three reader views, a later edit and historical version selection. Separate reader browser coverage checks captured formats. Live UI checks in My Study additionally verified successful Codex publication and the three reader views.

Final command results are recorded in the implementation plan and PROGRESS.md.

## Explicit limits

- This connected planner automatically maintains its source summaries and shared-concept pages. Custom Wiki pages with dependent provenance require explicit reconciliation/review; human edits to generated pages fail closed rather than being overwritten. Earlier proposal-level reconciliation and identity services are not a general autonomous editing agent.
- Candidate concepts in summaries are mentions unless separately supported. The summary's candidate-publication wording refers to separate concept pages, not the completed source-summary job. Relationship synthesis and arbitrary entity-page promotion are not automatically performed by this workflow.
- Supported Markdown relative attachments are preserved inside the selected folder scope. Explicit raster-image Obsidian embeds can render; wikilinks remain text with warnings, note embeds are not recursively expanded, and missing/outside-scope/unsupported references are reported. This is not a complete Obsidian vault renderer or backup.
- Local Cabinet Markdown folders are supported here. External knowledge mounts are rejected by this onboarding path. Bounds include 500 preview notes, 2 MB note input, 128 dependencies, 20 MB per dependency and 50 MB aggregate dependencies; oversized or invalid paths need user attention.
- Codex must support the installed CLI restriction flags and have usable local access. A provider error leaves the operation incomplete and retryable. External identity lookup is not needed for the pilot.

The only remaining numbered implementation phase is **Phase 28: optional search improvements**, subject to a new user instruction.

## Raw usability follow-up (2026-09-12)

Managed captures now mirror the original Notes hierarchy on disk. For example,
`Notes/Apple Notes/Programming/Alternative space characters.md` is captured in
`raw/Notes/Apple Notes/Programming/Alternative space characters/v1/`. The source
folder holds its manifest and version folders; IDs remain metadata rather than
long directory-name suffixes. Later working-file renames retain that initial capture
location and stable identity.

Each Markdown version has one exact `original.md`, a normalized `source.md`, and
`capture.json`. The redundant `capture/Notes/...` original copy is no longer written.
Supported attachments and historical versions are still retained. Formats such as
HTML may still need their original relative capture layout for dependencies.

Sidebar entries display distinct filenames, and empty assets folders are omitted.
The sidebar refreshes as capture and compilation finish. Selecting source.md opens the Reader / Original / Markdown viewer. Selecting
capture.json, manifest.yaml, original.md or a supported attachment displays that
file's read-only contents or a download, rather than the generic Sources screen.

Both existing My Study captures were migrated with original/version IDs unchanged.
Prior evidence URLs remain supported through aliases, and generated citation links
and publication receipts were updated. An internal backup of the old layout remains
under `.cabinet-state/llm-wiki/raw-layout-backups/335128d0-87ae-4c95-9342-80a88fe6e01e`.
Neither Notes original was edited; both still match their captured checksums.
The previous session's temporary inventory of all 242 notes was no longer available
for a fresh collection-wide checksum comparison.

Verification: 666 unit tests, including migration and subsequent update compatibility,
file-content previews, duplicate-original removal, and integrity refusal; browser
coverage for the mirrored path, metadata previews, source reading and version history.

## History policy follow-up (2026-09-12)

My Study's nested Git repository tracks the six generated `wiki/` Markdown pages
from the completed pilot in an attributed `llm-wiki: publish …` commit. Future
successful publications commit only their changed Wiki pages. The immutable
`raw/` tree, attachments, receipts and other Wiki runtime state are excluded from
Git history; `/raw` is recorded in the cabinet's local `.git/info/exclude` so Raw
evidence cannot be staged accidentally.
