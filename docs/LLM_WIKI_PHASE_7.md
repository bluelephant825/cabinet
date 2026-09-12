# LLM Wiki Phase 7: xberg adapter and extraction worker

Implemented on 2026-09-11. `server/ingestion/xberg.ts` supplies the Phase 6
DocumentConverter through a pinned xberg CLI. `xberg-worker.ts` owns bounded,
serialized child-process execution. `createXbergNormalization()` composes the
adapter with the existing normalization service and exposes `close()`.

## Runtime and installation

The adapter accepts the official **xberg 1.1.5** CLI. It verifies `--version`
before extraction and rejects unverified versions. Configure an absolute
`CABINET_XBERG_PATH` or put `xberg` (`xberg.exe` on Windows) on an absolute PATH
entry. An explicit missing/invalid path never silently falls back to another
executable. `.env.example` documents this optional setting.

Install the complete [official release distribution](https://github.com/xberg-io/xberg/releases/tag/v1.1.5),
including adjacent runtime libraries. The tested macOS archive contains the MIT
license and third-party notices; preserve them if redistributing that archive.
This phase does not add xberg as an npm dependency, download at application
startup or bundle native binaries into Electron/Next standalone. Operators of
source, desktop and self-hosted installations must provision the matching CLI.
Without it, native Markdown still works and converted formats fail explicitly.

The implementation follows the verified CLI's help/source and the
[official CLI reference](https://docs.xberg.io/cli/usage/). The pinned executable
supports `--no-config-discovery`, which avoids project/user config lookup even
though this flag was absent from the retrieved overview documentation.

## Captured input and process ownership

The adapter validates the format, portable path, input size and expected hash,
then stages private byte copies in a unique temporary directory. Captured
dependencies retain their paths; source/asset collisions fail before extraction.
Input files use exclusive creation and read-only permissions. All conversion
output is received as bounded JSON through stdout; the adapter does not trust
converter-provided filesystem output paths or read them from disk.

Extraction runs as a child process, outside the renderer and Electron main
event loop. There is no shell invocation. The worker serializes requests, bounds
its backlog to four requests, uses a 120-second timeout and a combined 64 MB
stdout/stderr cap by default. Xberg is limited to two internal threads. Closing
the adapter cancels work, rejects pending/new requests and awaits staging cleanup.
Failures, timeout and excessive output kill the POSIX process group; Windows uses
the system taskkill utility to terminate the process tree. Temporary input is
removed on success and failure after the process finishes.

The process receives a small OS/path environment rather than application/provider
credentials, NODE_OPTIONS or arbitrary XBERG settings. Extraction explicitly
disables configuration discovery, caching and OCR, and requests Markdown content,
JSON output and image extraction. No LLM, notebook execution, URL-input crawling
or automatic model download is requested. `HF_HUB_OFFLINE` is also set. This is
process isolation and explicit configuration, not an OS security sandbox: timeout,
thread/output limits do not impose a hard native-memory or filesystem/network
access limit on the executable. The binary must be trusted.

## Result mapping and normalization

The adapter validates the pinned CLI's `{ result: ... }` envelope, checks that
metadata identifies Markdown output, bounds content and decodes image byte arrays.
Images retain safe archive source paths when supplied, otherwise receive
`image_<array-index>.<format>` names. Repeated identical images under the same
path deduplicate; conflicting bytes at the same path fail. The Phase 6 asset
limits and portable path checks apply. Images whose references cannot be matched
remain retained assets, with warnings rather than invented placement.

Processing warnings are preserved. Stderr yields a generic diagnostic warning
instead of placing arbitrary subprocess logs in evidence metadata. Temporary
`source_uri` and `final_uri` entries are removed from the converter's metadata.
Converter name/version are returned as `xberg` / `1.1.5`.

The conversion result now optionally specifies its virtual Markdown path and
whether leading front matter should be parsed. Xberg supplies metadata separately
and sets `parseFrontMatter: false`: its generated text can start with a horizontal
rule, which must remain content. Native Markdown keeps Phase 6's strict YAML
behavior. The virtual path preserves resolution of captured parent-relative
dependencies; original bytes, paths and dependencies remain available separately.

OCR is deliberately off in this initial local profile, so scanned text may be
absent. PDF output carries this warning, and wholly empty extraction fails with
an actionable message. Text-bearing PDF, Office and markup extraction are
available; OCR configuration and installed backend validation remain separate
work. A successful extraction is not a claim of lossless conversion.

## Phase boundary

Constructing the composition starts no background activity. This phase does not
claim/advance ingestion jobs, classify sources, generate provenance YAML, publish
Raw versions, change manifests or compile Wiki pages. Those later stages must
validate queue leases and capture intent before calling normalization and publish
results only through their own durable promotion protocol. The phase's worker is
the extraction subprocess, not an unfinished end-to-end queue consumer.

## Verification

The normal suite passes **540 tests**, including eight new adapter/worker cases:
captured input, explicit CLI flags/environment, version validation, image decoding
and conflicts, parent-relative assets, missing/corrupt converters, timeout/output
limits, serialization/backlog, shutdown cancellation and cleanup. TypeScript and
targeted lint pass; full lint has zero errors and the existing 148 warnings.

`npm run test:xberg` is a separate real-binary smoke test. With
`CABINET_XBERG_PATH` pointing to the temporary official macOS ARM64 1.1.5
distribution, it passed conversions of generated HTML, PDF, DOCX, ODT, PPTX,
LaTeX, Typst and notebook fixtures, checking text, original bytes and provenance.
The notebook includes code that would throw if executed and a retained image.
Legacy DOC/PPT, OCR/scanned-document accuracy and Windows/Linux execution were
not exercised by that smoke test. No global installation or user documents were
used, and no additional UI/browser flow was introduced.

Phase 8 (YAML/provenance and manifest schema) requires the next user instruction.
