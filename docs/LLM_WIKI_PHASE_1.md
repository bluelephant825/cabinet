# LLM Wiki Phase 1: core domain contracts

Implemented on 2026-09-10 in `src/lib/llm-wiki/types.ts`.

This phase establishes provider-independent TypeScript contracts only. It does
not activate ingestion, create data directories, change the database, write
manifests, or alter existing editor/import behavior.

## Identity and ownership

`CabinetId`, `SourceId`, `SourceVersionId`, and `IngestionJobId` are distinct
opaque string types. An existing page path, root folder name, or room path cannot
accidentally be assigned as an identity without an explicit type assertion.
Future store/API boundaries must validate persisted values before constructing
these types; a type assertion itself is not validation.

`CabinetContext` separates stable root identity from the runtime absolute root
path. Source and job records carry root identity and a root-relative `roomPath`
(null for root-owned content). This preserves the root/room distinction found
in Phase 0 without redefining existing Cabinet APIs.

`SourceLocation` identifies either a root-relative Cabinet file or a file
relative to a registered knowledge mount. Mount locations include the owning
room and existing mount ID, avoiding absolute external paths in portable source
metadata. These references confer no permission: resolving them will require
the existing mount policies and canonical filesystem authorization.

## Source and immutable version

`Source` distinguishes snapshot from managed material. Managed sources require
a working location; snapshots cannot have that binding. Logical identity remains
stable when the title, slug, raw directory, or managed working location changes.
Lifecycle state can change without deleting any evidence.

`SourceVersion` and its converter provenance are readonly. A version records
source/root ownership, a positive version number, capture hash, original format,
version file paths, timestamp, and optional converter name/version. Paths are
root-relative; normalization produces ordinary Markdown, not executable MDX.

Current/superseded status is deliberately a separate projection type, derived
from `Source.currentVersionId`. Updating a source does not require changing the
metadata inside an old immutable version. `lastCompiledVersionId` is independent
of the latest captured version so compilation failure does not undo valid Raw
evidence or falsely report that the Wiki is current.

Readonly is compile-time protection only. The future evidence store must enforce
immutability on disk, source/version ownership, monotonic version allocation,
valid paths, SHA-256 encoding, timestamps, and lifecycle consistency. The declared
content hash covers the original captured bytes; multi-file dependency and
normalized-output integrity hashes still need a capture/storage schema in the
appropriate later phase.

## Ingestion intent and viewing

`IngestionJob` includes the requested lifecycle statuses and four operations:

- Create can exist before logical source identity or content hash is assigned.
- Update requires an existing source and input location; hashing can follow
  discovery/write stabilization.
- Delete requires source identity but neither an input file nor a content hash.
  This avoids requiring reads from a file that has already disappeared.
- Reprocess references an existing immutable source version, so it does not
  depend on the continued existence of the editable working file. Explicitly
  recapturing a changed working file uses update.

These are operationally durable records, not disposable indexes. Lease, retry,
attempt, idempotency, and transition machinery remain for the queue phase.

`SourceViewSelection` separates Reader/Original/Markdown preference from a
selected version. A null selected version follows the source's current version;
an explicit ID pins a historical version. No UI is changed in this phase.

## Validation and next phase

`types.typecheck.ts` provides compile-time assertions covering distinct IDs,
mandatory managed bindings, snapshot/deletion exclusions, update/reprocess
identity requirements, and readonly version metadata. It is included by the
repository TypeScript configuration and contains no executable code. Runtime
validation belongs with the future serialization boundary rather than being
implied by these interfaces.

Phase numbering for subsequent work follows the supplied plan's **Updated
implementation sequence**: next is Cabinet filesystem/source registry, followed
by the durable ingestion queue and then watchers. This resolves the difference
between that sequence and the earlier numbered section that calls the combined
Inbox watcher/queue Phase 2. Each completed increment requires the user's go-ahead
before proceeding, as requested.
