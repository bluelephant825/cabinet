# Phase 14 — Version selector UI

Completed 2026-09-11. Numbering follows the plan's updated implementation sequence.

Sources with more than one captured version now show a compact native version
selector beside the download action. Entries list newest versions first and
include version number, Current/Superseded status and a localized capture date.
A Source with only one version retains the simpler Phase 13 header.

The reader service accepts an optional version UUID and validates membership in
the Source identified by the selected Raw path. Omitting it selects the current
manifest version. The response includes the Source path, current version ID and
lightweight immutable version metadata. Status is derived from the current pointer;
no historical record or evidence file is rewritten.

Each selected version passes through the existing receipt/hash/provenance checks.
Reader, original preview, literal Markdown, file format/name and original download
all use that same version UUID, including when formats differ across history.
Unknown/foreign versions and damaged historical Markdown fail rather than silently
falling back to current evidence. Current metadata remains unchanged by viewing.

Version selection is independent of the Reader/Original/Markdown preference.
Changing versions keeps the active view and its per-Source saved preference.
Opening/reloading the Source defaults to current; historical selection is not
persisted or added to the navigation URL. This follows the plan's current-default
behavior without making a saved display preference silently pin old evidence.

While a version loads, the content panel and original download are withheld.
Obsolete requests are aborted and ignored, so rapid selection cannot let an older
response replace a newer choice. A failed load restores the previous selector
value and complete preview/download state, with an explanatory error. The selector
remains available to retry or choose another version.

Verification covers three-version histories (including a format change), correct
preview/content/version metadata, newest-first status, current-default behavior,
foreign/malformed IDs, historical tampering and unchanged manifest bytes. Real-app
browser coverage checks the single-version header, historical selection across
all views/downloads, view preservation, reload-to-current, delayed-response races,
download suppression during loading and failure recovery. The rendered selector
is visually inspected from the browser screenshot.

Phase 15 is the WikiCompiler interface and remains pending user instruction.
