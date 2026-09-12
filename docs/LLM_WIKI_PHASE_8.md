# LLM Wiki Phase 8: YAML provenance and manifest schema

Implemented on 2026-09-11. `provenance.ts` defines and validates compact evidence
front matter; `manifest.ts` provides the shared Source manifest codec. This phase
prepares metadata in memory and strengthens existing registry reads/writes. It
does not publish a Raw version or start classification/queue processing.

## Evidence header

Generated `source.md` documents have one schema-versioned YAML header containing:

| Field | Meaning |
| --- | --- |
| `schema_version` | Evidence header schema, currently `1` |
| `cabinet_id`, `source_id` | Stable root and logical Source UUIDs |
| `source_version_id`, `source_version` | Immutable version UUID and positive sequence number |
| `title`, `source_type` | Captured title and format-derived document type |
| `original_filename`, `original_format` | Original basename and normalized extension |
| `language` | Optional validated language tag |
| `imported_at` | Canonical ISO timestamp from the captured version |
| `sha256` | SHA-256 of original captured bytes, not normalized Markdown |
| `conversion.tool`, `conversion.version` | The actual normalizer/converter identity |

`prepareEvidenceDocument(normalized, source, version)` accepts a caller-supplied
candidate SourceVersion. It verifies the original bytes/hash, ownership, version
paths, format and any existing captured provenance. It returns the front matter,
the assembled Markdown and a new enriched version descriptor. It allocates no
identity or version number, mutates none of its inputs, and writes no file.
The later publication stage must persist the returned version descriptor and
Markdown together through its durable promotion protocol.

Identity, sequence, hash, timestamps and conversion fields come from Cabinet's
source/version/normalizer objects, never arbitrary imported metadata. The title
comes from the logical Source at capture time (or an already captured document
title); language is the only additional extracted metadata field projected into
the header. Source type is derived from the original format. Extracted entities,
raw converter metadata, custom instructions and lifecycle state are not copied
into the header. The captured original retains its complete original metadata.

Normalization now returns a separate `body`, excluding only front matter that
was actually parsed. Evidence preparation uses that body directly, so it neither
duplicates an imported header nor strips generated Markdown rules that happen
to resemble YAML. Native normalized Markdown remains available with its original
header; xberg's `parseFrontMatter: false` behavior remains intact. Header assembly
does not reformat body whitespace, code blocks or asset references.

## Reading and consistency checks

`readEvidenceDocument` reads the canonical LF-based generated document, validates
the header and returns its body. An optional Source/SourceVersion expectation
checks ownership, sequence, original hash, timestamps, paths and captured
converter/document metadata. It does not compare against the mutable current
version pointer or current Source title, so old evidence stays valid after a
rename or a newer capture. It also does not read/hash files on disk or establish
cryptographic authenticity: later evidence verification must check stored bytes.

Unknown header fields and schema versions, duplicate YAML keys, executable tags,
invalid IDs/hashes/timestamps, path-bearing original names, mismatched extensions
and unsupported document types fail explicitly. Headers are capped at 64 KB;
document bodies retain the 20 MB normalization limit. Titles and converter labels
are bounded single-line text. The optional language field accepts a bounded
hyphenated language tag; an invalid supplied value fails rather than silently
claiming a language.

## Source manifest mapping

The existing Cabinet layout remains `schemaVersion: 1`, with a nested `source`
and `versions` array. Stable UUIDs, root-relative Raw paths and structured managed
bindings remain unchanged. No second manifest format, slug-based identity or
relative `../../` managed path is introduced.

SourceVersion adds optional immutable `document` metadata:

```yaml
document:
  title: Captured document title
  sourceType: notebook
  originalFilename: experiment.ipynb
  language: en
converter:
  name: xberg
  version: 1.1.5
```

These scalar fields describe the historical version, including its captured
title. Older version records without `document` or `converter` remain readable.
New document metadata requires converter provenance, and its filename/type must
match the version's original format. When checking older evidence, only metadata
actually present in the legacy version can be cross-validated.

Mutable source lifecycle remains in `source.status`, `deletedAt` and the existing
current/compiled version pointers. Current/superseded version status is derived;
it is still forbidden inside immutable version records. Classification stays
with the logical Source and its Raw location.

`decodeSourceManifest`, `parseSourceManifest` and `encodeSourceManifest` centralize
the prior store validation and new provenance checks. SourceStore uses this codec
for discovery, registration and rebinding while retaining its existing atomic
writes, ownership/path guards and root lock. Plain unknown extension metadata is
preserved for compatibility. Cycles, non-plain values and excessive structures
are rejected; serialized manifests are limited to 8 MB, with depth/node limits
that allow long histories without placing extracted entity graphs in document
metadata. No existing manifests are migrated merely by reading them.

## Verification and next checkpoint

Seven new tests cover identity derivation, deterministic header/body round-trips,
large extracted metadata exclusion, generated leading rules, historical titles,
foreign/tampered provenance, malformed YAML and schema fields, legacy/enriched
manifest round-trips, extension preservation and invalid/cyclic metadata.
The complete suite passes **547 tests**; TypeScript and lint pass with zero errors
and the existing 148 lint warnings. Existing registry, queue and watcher tests
exercise the shared codec integration. No new UI or converter process was needed.

Phase 9 is Source classification. Raw version publication remains Phase 10;
both require their respective next user instructions.
