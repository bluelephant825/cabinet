# Third-party notices for the vendored GenOffice sources

Vendored from https://github.com/bluelephant825/genoffice @
f2c3d0879df29622d5a447935d2b4aeac033544d (Apache-2.0, Copyright 2026 Mainfunc,
Inc.). See LICENSE and NOTICE in this directory.

## Unicode Character Database

`apps/pdf/shared/radicals.ts` contains a generated mapping derived from the
Unicode Character Database 17.0.0, EquivalentUnifiedIdeograph.txt
(2025-08-01): https://www.unicode.org/Public/17.0.0/ucd/EquivalentUnifiedIdeograph.txt

Copyright © 1991-2026 Unicode, Inc. Distributed under the Unicode License v3;
the complete copyright and permission notice is reproduced in
`LICENSE-UNICODE.txt`.

## emf-converter

`packages/docx-engine/src/vendor/emf-converter/index.mjs` is a bundled
EMF/WMF → data-URL converter derived from pptx-viewer, Apache-2.0
("Copyright 2025-present pptx-viewer contributors"); its license is preserved
at `packages/docx-engine/src/vendor/emf-converter/LICENSE`.

## Runtime npm dependencies used by the vendored code

| Package | Version | License |
| --- | --- | --- |
| @embedpdf/pdfium | 2.15.0 | MIT (wasm build of PDFium; PDFium is BSD-3) |
| bidi-js | 1.0.3 | MIT |
| fast-xml-parser | 5.10.1 | MIT |
| harfbuzzjs | 0.10.3 | MIT (HarfBuzz subset wasm; HarfBuzz is Old-MIT) |
| jpeg-js | 0.4.4 | BSD-3 |
| jszip | 3.10.1 | MIT |
| pdf-lib | 1.17.1 | MIT |
| pngjs | 7.0.0 | MIT |
| utif2 | 4.1.0 | MIT |

Verify license fields with `npm view <pkg> license` when bumping versions;
upstream generates a full THIRD-PARTY-NOTICES.txt at packaging time via
`tools/gen-third-party-notices.mjs`.
