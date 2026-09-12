# Phase 13 — Reader / Original / Markdown UI

Completed 2026-09-11. Numbering follows the updated implementation sequence.

## Cabinet mapping and navigation

Opening a registered Raw Source or any file beneath it in Cabinet's normal page
navigation now presents `RawSourceViewer`. A loading boundary prevents the
ordinary editor/HTML/notebook viewer from mounting before Raw ownership resolves.
Raw category directories show a Source list, including retained removed Sources.
Unrelated files retain their existing viewers. Custom Raw paths are supported.

The compact, keyboard-operable segmented control offers Reader, Original and
Markdown. The header identifies the captured version and original filename,
labels evidence read-only, provides an original download, and distinguishes
Sources removed from active knowledge. The current manifest version is selected
when loading; every view/download uses that same immutable version ID. A version
selector is deliberately deferred to Phase 14.

View preference is stored per Cabinet/Source in localStorage, independently of
version identity. Reader is the default; unavailable storage simply leaves the
default in place. The UI follows Cabinet's typography, colors and responsive
layout. The rendered Reader was inspected from the production browser test.

## Reader

`raw-reader.ts` reads receipt-listed bytes through
`RawPublicationStore.readCapturedFile`, validating Source/version ownership,
manifest history, file size/hash and evidence front matter. Reading remains
available with ingestion disabled. Missing receipts, mismatched history and
corrupt Markdown fail visibly rather than opening an editable fallback.

Runtime Markdown rendering uses remark/GFM with no MDX, raw HTML, embedded apps,
live-code or notebook execution. A parse5 allowlist then restricts elements and
attributes. Headings, tables, lists, quotes, fenced code, footnotes, links and safe
callout labels render with dedicated reader typography. Footnote anchors retain
their safe generated IDs; external HTTP(S) links require a user click and open
with noopener/noreferrer. Other navigation schemes are dropped.

Only verified captured raster assets are embedded. Remote images, SVG, uncaptured
resources and oversized preview images are not loaded. Image previews are bounded
at 2 MB each and 8 MB per response; Markdown uses the existing 20 MB evidence
limit. Original bytes and normalized Markdown are never rewritten for display.

## Original and Markdown

Original HTML uses a sanitized, script-free srcdoc iframe with an empty sandbox,
no same-origin privilege, no preload bridge and a restrictive CSP. Forms,
embedded frames, event handlers, imported styles, navigation, remote resources
and non-captured image paths are excluded. Captured local raster dependencies
resolve through the original capture layout. This is a safe structural preview;
the exact original, including its original styling, remains downloadable.

PDFs use the browser's PDF preview in a sandboxed iframe with a download fallback
when that browser cannot display the file. Markdown/LaTeX/Typst originals display
as literal read-only text. Notebooks receive a static preview of captured cells
and text outputs; kernels and executable rich outputs are never activated.
Office/unsupported formats and text originals above the 2 MB preview limit offer
the original download plus Reader. Safe original previews may omit resources that
were not captured or could not be verified.

Markdown displays the complete normalized `source.md`, including provenance,
as selectable literal text. There is no save control, editor, or autosave route.
Downloads are independently verified, served as attachments with nosniff and
no-store, and cannot supply arbitrary paths outside the selected receipt.

## Read-only enforcement

Generic page/asset/upload mutations now reject configured Raw paths and folders
containing Raw, including existing symlink aliases. Git history restore, rename
undo and reference rewriting respect Raw protection. The Electron file-write
handler checks the same server guard and requires an explicit JSON allow result;
unavailable or redirected guard responses do not permit writing. These guards
remain active when ingestion is disabled.

The generic assets GET route refuses Raw content, including Drive aliases into
Raw, so imported HTML is not exposed through the old privileged viewer route.
The dedicated reader endpoint supplies safe previews and attachment downloads.
Missing ownership metadata when root-local Wiki state exists fails closed.
Uninitialized Cabinets without Wiki state keep their prior behavior.

These are application boundaries, not filesystem access control against external
editors, shell agents or arbitrary Git operations. Those can still change disk;
verified reads detect altered evidence. No general OS write restriction is claimed.

## Verification and next checkpoint

Unit tests cover ordinary Markdown features/callouts, active-HTML filtering,
static notebook output, verified raster assets, ownership, disabled ingestion,
tampering, protected ancestors and aliases. A real-app browser test covers the
three views, preference reload, keyboard navigation, unchanged original download,
script/tracker isolation, and blocked page edits, uploads, rename, history restore,
asset deletion and direct Raw HTML serving. Production build and lint are checked.

No live model, conversion process or user-data ingestion was started. Phase 14,
the version selector UI, awaits user instruction.
