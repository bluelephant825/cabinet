# Phase 25 — Obsidian managed-source integration

Completed 2026-09-11, using the canonical implementation sequence.

## One vault, one Cabinet

`ObsidianManagedSourceService` integrates an already imported Obsidian vault located
at an initialized, enabled Cabinet root. A real `.obsidian` directory is required.
It does not move a user's vault, bootstrap an external directory, or create a room
for every folder. Nested Cabinets and nested vaults are excluded for separate
integration, preserving the one-vault/one-Cabinet default.

`inspect()` performs a read-only inventory of Markdown notes and reports excluded
items. It skips settings/hidden files, configured Inbox/Raw/Wiki layers, symlinks,
nested Cabinets/vaults and non-Markdown files. The inventory includes note paths,
byte sizes, content hashes and a fingerprint tied to the Cabinet/config and notes.
Limits are 5,000 filesystem entries, 500 notes, depth 16, 20 MB per note and 100 MB
of note content. Ambiguous case/Unicode-equivalent paths fail rather than create
conflicting managed bindings.

## Selected capture and immutable history

`importNotes(inventory, selectedPaths, classification)` requires an explicit selection
from a fresh inventory. The default classification is `obsidian`; folders remain
working-file locations rather than being converted into rooms or generated Raw
categories. Stale inventories and unknown/duplicate selections fail before writes.

For each selected note, the service captures stable UTF-8 bytes, normalizes them
through the existing SourceNormalizationService, registers a root-scoped managed
binding using its unchanged vault-relative path, and publishes v1 through the
existing RawPublicationStore. Source titles default to the note filename; original
front matter remains in the immutable original/normalized evidence. No source
classification model or new provider system is introduced.

Repeated unchanged imports find the existing managed binding, verify its current
Raw Markdown and original receipts, and return the existing Source/version identity.
An interrupted initial publication can be retried through the existing publication
recovery mechanism. A batch is not one transaction: successful earlier captures
remain if a later note fails. Inspect the manifests/inventory and retry; no successful
Raw version is rolled back or deleted.

`captureNote(path, expectedHash, classification, expectedVersionId)` is the explicit
capture entry point for later saves. Changed registered notes require the current
predecessor ID and publish vN+1 through the existing service. Stale hashes or
predecessors fail. Deleted, archived or pending-lifecycle Sources are not silently
restored or captured. Rename/rebind decisions remain explicit in the existing
SourceStore; this service does not guess renamed-note identity from filenames.

Stable capture uses a regular-file descriptor, no-follow where supported, bounded
reads and pre/post file/path signatures. Hidden/generated paths and nested scopes
are rechecked for direct captures as well as inventory imports. File changes after
a successful capture do not alter those captured bytes; a later save remains a
subsequent managed-source observation.

## Preservation and current limitations

Original notes remain editable at the same paths. Their bytes, Obsidian wikilinks,
folder structure, `.obsidian` settings and attachment files are never rewritten,
moved or deleted by the service. Raw holds immutable copies; Wiki generation remains
a separate compiler step. The service writes only through existing SourceStore and
RawPublicationStore boundaries, and does not advance compiled-version pointers.

This phase captures Markdown note bytes, not a self-contained backup of every
embedded dependency. Obsidian embeds/transclusions retain their original syntax;
the normalizer's unsupported-embed and unresolved-reference warnings are returned
by capture/import. Attachments remain in the vault and are listed as excluded from
note registration. Vault-aware embed rendering, attachment-only change tracking and
recursive dependency capture are not implemented here. Original Obsidian links
continue to work in their unchanged vault context; Raw previews are not claimed to
reproduce Obsidian's renderer.

## Existing watcher and integration boundary

Registered notes use ordinary managed cabinet-path bindings. The existing
ManagedSourceWatcher discovers those bindings and observes subsequent note saves,
atomic replacement, missing files and explicit rebinding. No second watcher or
Obsidian plugin is installed. The existing watcher still enqueues intent; the global
queue consumer, automatic conversion/compiler wiring, Wiki publication and lifecycle
acknowledgment remain outstanding as documented in the canonical plan. The explicit
capture service can publish Raw versions independently, but this phase does not
claim an automatic end-to-end save-to-Wiki pipeline.

No live user vault was imported while implementing this phase. No new UI, bulk-copy
workflow, external connection or daemon startup behavior is enabled.

## Verification

Four new integration tests cover read-only inventory and selective registration,
exact note/Raw preservation with wikilinks/front matter, unchanged settings and
attachments, returned embed warnings, stable retry identities, explicit later-version
capture and predecessor checks, excluded generated/hidden/nested/symlink paths,
stale inventories and refusal to silently restore deleted Sources. Tests use
isolated vault fixtures and the real registry/normalization/Raw services.

All 647 unit tests passed. TypeScript and targeted lint passed; full lint reported
zero errors and 148 existing warnings. Whitespace checks passed.

Phase 26 is failure recovery and awaits user instruction.
