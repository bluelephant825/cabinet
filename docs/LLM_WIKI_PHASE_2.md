# LLM Wiki Phase 2: filesystem and source registry

Implemented on 2026-09-10, following the supplied plan's updated implementation
sequence. The new storage services are available to future server callers;
existing app startup, imports, pages, and the daemon do not invoke them yet.

## Public operations

`src/lib/llm-wiki/config.ts` provides:

- `initializeWikiCabinet(rootPath, options)`: explicitly adds `llmWiki` metadata
  to an existing `kind: root` `.cabinet` YAML manifest. It preserves unrelated
  metadata, generates a stable UUID once, defaults the feature and auto-ingestion
  off, and supports custom relative Inbox/Raw/Wiki paths. Repeating the same
  initialization returns the existing identity. Conflicting options require a
  separate future reconfiguration workflow rather than silently moving data.
- `readWikiCabinet(rootPath)`: loads and validates the configured root without
  writing or scaffolding anything. An uninitialized root returns null; malformed
  or unsupported configuration raises an error.
- `setWikiEnabled(rootPath, enabled)`: changes only the feature gate, retaining
  other manifest/config metadata. No worker starts when this flag changes in
  Phase 2.

`src/lib/llm-wiki/source-store.ts` provides `SourceStore` with:

- `register(input)`: allocates a stable Source identity and a collision-free
  directory below Raw, writing an atomic `manifest.yaml`. Managed registration
  requires an existing authorized working file. Snapshot registration establishes
  identity only; it does not capture evidence. Both start with no versions.
- `list()` / `get(id)`: rebuild the registry directly from authoritative manifests.
  Malformed, duplicate, foreign-root, or inconsistent version records are surfaced
  as errors instead of being silently omitted.
- `findManaged(location)`: resolves an existing working-file binding without
  requiring that the working file still exists.
- `rebind(id, location)`: explicitly changes a managed file binding after a rename
  or move. It preserves Source identity, Raw location, and any version records;
  it does not move or rewrite working files. Moving between room scopes is not
  supported by this method.

Writes require the feature gate to be enabled. Reads remain available when it
is disabled. There are no new HTTP routes or renderer controls in this phase.

## On-disk authority

The initial source manifest envelope is:

```yaml
schemaVersion: 1
source:
  # Source fields from types.ts, using their existing camelCase names
  # Identity, root/room ownership, mode, lifecycle, working binding,
  # Raw location, captured/compiled version pointers, timestamps
versions: []
```

The version list can be read and structurally validated, but this phase exposes
no operation to create, overwrite, or delete SourceVersions. Normalized Markdown
frontmatter and the capture/promotion protocol remain later work. Reader
validation checks UUIDs, canonical timestamps, SHA-256 formatting, positive
distinct version numbers, source/root ownership, version directory paths, and
current/compiled pointers. It does not read evidence bytes or verify their hashes.
The current pointer must reference the latest recorded version; compilation may
lag behind it.

The registry performs a fresh manifest scan on each read. There is no second
persistent registry, no new database, and no cache that must survive restart.
This is intentionally simple and O(number of source manifests). A future SQL
lookup projection should use the existing SQLite connection/migrations and be
rebuildable from these manifests; the queue phase will need that existing SQL
infrastructure for operational durability regardless.

Original and normalized version paths are root-relative, making source metadata
portable with the root Cabinet. Managed external files instead reference the
existing room-scoped knowledge mount ID and a mount-relative file path; the
external mount configuration itself may require reconnection after relocation.

## Filesystem and compatibility boundaries

Initialization requires an existing root manifest. It does not promote a room,
scaffold a vault, modify human files, or create Inbox/Raw/Wiki/state directories.
Registration later creates only the selected Raw classification/source directory
and manifest. Existing nonempty Raw, Wiki, or proposed state directories prevent
first-time initialization; an existing Inbox is allowed as a chosen staging
location, but nothing processes it.

Content layers must be visible relative paths, disjoint, and outside hidden
Cabinet state. The legacy `raw/Inbox` alias is deliberately rejected by this
phase's non-overlap rule; safe alias-specific watcher precedence is not present
yet. Use a separate Inbox for now. Case-insensitive overlap/binding comparisons
are conservative across macOS and Windows and may reject distinct case-only
filenames on case-sensitive systems. Trailing-dot/space and Windows-special
path spellings are rejected for portability.

Root-local filesystem checks reject traversal, intermediate symlinks, dangling
symlinks, and generated-layer managed inputs. The caller's explicitly chosen
root is canonicalized first. Mounted working files use the existing
`readKnowledgeSources` service, require an enabled mount in the same room and
active root, and reject symlink escapes and mount aliases into generated layers.
Read-only mounts can supply evidence inputs because registration only reads
their metadata; all writes go into the owning Cabinet. Ordinary inline symlinks
must be represented as knowledge-mount references, not unrestricted local paths.

The small `filesystem.ts` module adds only these domain-specific ownership
checks and an advisory writer lock. Atomic metadata replacement reuses Cabinet's
existing `writeFileAtomic` helper. It does not replace the general filesystem
service. Application path checks do not defend against a hostile local process
swapping filesystem components during an operation, and atomic rename alone
does not guarantee power-loss durability.

## Concurrency and recovery

Writers use an exclusive root-local `.llm-wiki.lock` file. A concurrent writer
fails with a retryable-by-caller error instead of racing source registration or
rebinding. Readers see either the old or new atomically published manifest.
Unrelated Cabinet manifest writers do not share this new advisory lock;
configuration is an explicit setup operation, not a background metadata writer.
Initialization checks for an observed manifest change before publication, but
does not claim a filesystem-wide compare-and-swap transaction.

A crashed writer can leave the lock file. Its PID and timestamp are recorded;
the store refuses to steal it automatically. Stop/verify the prior writer and
inspect the file before manually removing a stale lock. Automatic lease/recovery
machinery belongs to the later queue phase.

A crash before initial manifest publication may leave an empty source directory
or a temporary manifest. These are not registered Sources and are never adopted
as evidence. Retrying creates a fresh identity; orphan files remain available
for inspection. Once a complete manifest exists, reopening the store finds the
same Source without relying on a previous process or index. Corrupt complete
manifests stop the scan so no subsequent write proceeds from an incomplete view.

## Verification and remaining scope

Tests use temporary roots and the existing Node test harness. Coverage includes
metadata preservation, stable identity, default-off configuration, alternate
paths, nonempty-folder refusal, traversal and case aliases, symlinks, root
isolation, duplicate bindings/IDs, missing working files, explicit rename
rebinding, malformed metadata, version ownership/pointers, interrupted
registration, lock contention, and existing read-only/disabled knowledge mounts.

No ingestion queue, watcher, conversion, evidence promotion, source deletion,
Wiki compilation, preview UI, or generic-editor Raw protection is enabled here.
In particular, Phase 2 registers sources but must not be advertised as enforcing
immutable evidence through existing page/asset/IPC routes. Those guards must be
in place before a later phase publishes real Raw versions.

Next checkpoint: Phase 3, the durable ingestion queue, only after user approval.
