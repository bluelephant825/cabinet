---
name: genoffice
description: Create, inspect, check, render and edit XLSX and PPTX files with Cabinet's guarded GenOffice command. Use cabinet-documents instead for DOCX, existing PDF/PDFCN, and Markdown conversion writes; GenOffice may export XLSX/PPTX to PDF.
allowed-tools: Bash(genoffice:*), Bash(cabinet-documents:*)
metadata:
  source: genspark-ai/genoffice
  upstream-version: 2.51.0
  cabinet-adaptation: 1
---

# GenOffice in Cabinet

Use `genoffice` for spreadsheet and presentation work. Cabinet provides a guarded launcher around the pinned GenOffice CLI. It restricts every input, output, operation file and data file to the active Cabinet's writable data root.

Run this before relying on the tool:

```sh
genoffice --version --json
```

If it reports `app_not_available`, explain that the packaged GenOffice CLI is unavailable on this host. Do not install software, run `npx`, or bypass the launcher.

## Format ownership

Use `genoffice` for:

- XLSX inspection, creation, structured edits and checks.
- PPTX inspection, creation, structured edits and checks.
- Rendering DOCX, XLSX and PPTX for visual verification.
- Supported merge operations when the installed CLI advertises them.
- `docs read` and `docs check` as additional read-only validation.

Use `cabinet-documents` for:

- Every DOCX edit or save.
- Every PDF or PDFCN edit or save.
- PDF to DOCX or Markdown conversion.
- DOCX to Markdown conversion.
- Revision-safe inspection of files currently open in Cabinet.

The launcher rejects `docs apply`, DOCX/PDF creation, and conversions that write DOCX, Markdown or MDX. It allows XLSX/PPTX PDF export because that is a renderer output, not an edit of an existing PDF. Never work around the guard with another script or byte-level ZIP editing.

## General workflow

1. Read the current file before editing it.
2. Ask the CLI for the relevant guide before writing operation JSON.
3. Keep operation/spec/data files inside the active Cabinet, or pass JSON through stdin where supported.
4. Apply the smallest targeted batch.
5. Run the format check.
6. Render the result when visual verification matters.
7. Read the changed region again and report every created or changed path.

Always add `--json` when consuming output programmatically. Treat `status: "partial"` as a failure that needs inspection. Never parse human-readable error text when the JSON response supplies `error`, `suggestion` and `detail` fields.

## Spreadsheets

Inspect before editing:

```sh
genoffice sheet read workbook.xlsx --sheet Sheet1 --range A1:H40 --formats --json
genoffice sheet check workbook.xlsx --json
genoffice guide sheets --index --json
```

Apply structured edits:

```sh
genoffice sheet apply workbook.xlsx --ops operations.json --json
```

For direct cell updates, use the CLI's `--cells` form only after reading its guide. Preserve formulas and formatting outside the requested range. Re-run `sheet check` after every write.

Create a workbook from Cabinet-local CSV or JSON:

```sh
genoffice create --type xlsx --from data.csv --header --out workbook.xlsx --json
```

## Presentations

Inspect slide and element ids before editing:

```sh
genoffice slides read deck.pptx --full --json
genoffice guide slides --index --json
genoffice slides check deck.pptx --json
```

Apply operations only with ids from the latest read:

```sh
genoffice slides apply deck.pptx --ops operations.json --json
```

Create designed decks through the checked outline and per-slide specification flow exposed by `genoffice guide slides design` and `genoffice guide slides spec`. Keep all outline, style, spec and image files inside the Cabinet. Run `slides check`, render a contact sheet, inspect it, then fix any overflow or placeholder content before reporting completion.

## Read-only DOCX validation

Cabinet owns DOCX writes. These commands are allowed only for inspection and checks:

```sh
genoffice docs read report.docx --full --json
genoffice docs check report.docx --json
```

Make any required DOCX changes with `cabinet-documents`, not `genoffice docs apply`.

## Rendering

```sh
genoffice render deck.pptx --out renders --grid --json
```

Rendering and PDF export may need an installed GenOffice desktop app. If the launcher returns exit code 4 or `app_not_available`, report that visual/PDF export is unavailable on this host. Do not open Electron directly and do not invent a substitute write path.

## Safety

- Do not access paths outside the active Cabinet.
- Do not follow symlinks into connected read-only knowledge sources.
- Do not put secrets in operation files or command arguments.
- Do not use `--force` unless the user explicitly asked to replace that output.
- When an editor reports a conflict after a CLI write, stop and let the user choose whether to reload or preserve their unsaved changes.

The manual upstream installation equivalent for compatible agents is:

```sh
npx skills add genspark-ai/genoffice
```

Cabinet does not run that command automatically. Its bundled skill is attached through Cabinet's skill picker and mounted only for runs where the operator selected it.
