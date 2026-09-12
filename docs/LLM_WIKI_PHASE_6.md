# LLM Wiki Phase 6: source normalization abstraction

Implemented on 2026-09-11 according to the updated implementation sequence.
`src/lib/llm-wiki/normalizers/` provides the SourceNormalizer contract, a native
Markdown normalizer, document-format dispatch and the future converter interface.
The actual xberg adapter and worker are Phase 7, not part of this phase.

## Boundary and ownership

`SourceNormalizationService` accepts a `SourceFile` with a capture-relative path,
captured original bytes, an expected original SHA-256 and optional captured
assets. It checks the hash, validates portable relative paths and takes private
byte copies before normalization. It does not resolve live source bindings, read
files, fetch URLs, write staging/Raw, claim queue jobs or start a worker.

The caller must capture the original and any authorized dependencies before
invoking the service. Normalizing reread working files against an old queue hash
fails with a mismatch. Asset paths are relative to the same capture root as the
original, so a note at `notes/note.md` can reference a captured `images/photo.png`
through `../images/photo.png` without granting access outside that capture.

`NormalizedSource` returns the untouched original bytes/hash, filename, format,
original capture-relative path and dependencies under their original names,
plus normalized Markdown, parsed metadata, normalized assets, warnings and
converter name/version. Original data is separate from the converter's input
copies, so an adapter mutating its buffers cannot overwrite returned evidence.
The returned objects are readonly contracts, not filesystem immutability or
runtime-frozen byte buffers. Raw publication remains a later phase.

## Native Markdown

`.md` and `.markdown` are handled locally, including uppercase extensions. The
normalizer decodes strict UTF-8, removes a leading BOM from the normalized view,
and converts CRLF and CR line endings to LF. Original bytes and their hash retain
the BOM and original line endings. Prose, whitespace, code fences, titles and
front matter are otherwise preserved rather than round-tripped through a
Markdown formatter.

Leading YAML front matter is parsed with the existing js-yaml dependency's
JSON schema. Metadata must be a bounded mapping of plain values; invalid YAML,
executable/custom tags, cycles and oversized/deep structures fail explicitly.
Empty front matter produces empty metadata. The native document text retains
the original YAML spelling/comments with normalized line endings. It does not
invent Source IDs, classification or version/provenance fields; those belong
to the subsequent metadata and promotion phases. The normalizer reports its
own provenance as `cabinet-markdown`, version `1`.

This path deliberately does not reuse the editor's front-matter helper, which
can discard malformed metadata, or the renderer's MDX/live-code transforms.
Imported instructions, notebook code, raw HTML and JSX remain inert content.
The later reader must still apply its own rendering and URL policy: normalized
Markdown is evidence, not sanitized HTML or executable MDX.

## Asset normalization

Supplied asset bytes produce deterministic `assets/<sha256>.<extension>` paths.
Identical bytes with the same normalized extension deduplicate. All supplied
dependencies are retained, including those without a recognized Markdown
reference; none are discovered implicitly from the filesystem or network.
Original dependencies also retain their capture-relative names for future
original-file viewing and packaging.

The existing remark parser identifies standard inline image/link destinations
and reference definitions. Only matching captured paths are rewritten, preserving
titles and query/fragment suffixes. Relative `.` and `..` references are resolved
within the capture; percent-encoded spaces and escaped parentheses are supported.
Each candidate edit is reparsed and compared structurally to ensure it changes
only the destination. Text edits are applied together without reformatting the
rest of the document. Code examples are untouched.

Uncaptured links, malformed paths and paths escaping the capture remain unchanged
with warnings. Remote, absolute and special-scheme references are not fetched.
Raw HTML and wiki embeds are preserved with warnings because their embedded
asset syntax needs separate handling. This phase does not implement vault-aware
link resolution or dependency watching. A managed Markdown source's entry-file
hash alone still does not detect independent edits to an image/include.

## Document conversion contract

HTML/HTM, PDF, DOC/DOCX, ODT, PPT/PPTX, TEX/LATEX, TYP/TYPST and IPYNB dispatch to
`DocumentNormalizer`, which requires an injected `DocumentConverter`. It passes
captured byte copies to `convert`, then validates the result and applies the same
Markdown/asset normalization to the returned text and assets. Converter asset
paths are relative to a virtual `source.md`, not the original document's working
directory. Converter metadata is retained; explicit extracted front matter takes
precedence for overlapping document keys. Extraction warnings and converter
name/version are returned without claiming successful publication.

`supports()` describes recognized format routing, not installed converter
availability. With no adapter, converted formats fail clearly with a
converter-unavailable error. Unsupported extensions, conversion errors and
invalid output also fail rather than pretending the original is Markdown.
The tests use a deterministic injected converter; they do not establish xberg
format compatibility, extraction quality, packaging or offline availability.
No notebook execution or round-trip editing is introduced.

## Limits and verification

Initial limits are 500 MB per original, 20 MB for input/output Markdown, 1 MB for
front matter, 10,000 metadata values with maximum depth 30, 256 captured assets,
50 MB per asset and 100 MB total assets. This byte-based interface allocates
copies; the Phase 7 worker must account for memory and enforce process execution
limits. These limits do not imply that parsing/conversion should run on an
Electron renderer or main event loop.

Ten normalization tests cover original-byte/hash preservation, front matter and
line endings, UTF-8 failures, inline/reference/nested/escaped asset links,
link-like text in titles and labels, deterministic asset output, uncaptured and
unsafe references, metadata errors, path/size boundaries, every routed format,
Markdown bypass, adapter mutation isolation and explicit unavailable/error paths.
The full suite passes 532 tests; TypeScript and targeted lint pass. Full lint has
zero errors and the existing 148 warnings. No runtime/UI integration changed, so
no additional browser test or converter process was run.

Phase 7 (xberg adapter and worker) requires the next user instruction.
