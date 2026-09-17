# Third-Party Notices

Cabinet bundles or redistributes the following third-party software. Licenses
are reproduced in the referenced files inside the repository or the npm
packages themselves.

## Vendored sources (`src/vendor/`)

| Component | License | Source | License file |
| --- | --- | --- | --- |
| GenOffice (DOCX/PDF engines, viewers) | Apache-2.0 (includes NOTICE) | github.com/bluelephant825/genoffice (fork of genspark-ai/genoffice) | `src/vendor/genoffice/LICENSE`, `src/vendor/genoffice/NOTICE` |
| — Unicode Character Database data | Unicode license | embedded in `apps/pdf/src/shared/radicals.ts` | `src/vendor/genoffice/LICENSE-UNICODE.txt` |
| PDFCN (Takumi PDF component registry) | MIT | github.com/shadcn-labs/pdfcn @ `88ca522` | `src/vendor/pdfcn/LICENSE` |

GenOffice NOTICE text:

> GenOffice — Copyright 2026 Mainfunc, Inc. This product includes software
> developed at Mainfunc, Inc. Bundled fonts and their licenses are documented
> in `apps/docs/src/renderer/fonts/README.md`.

## Document runtime packages (shipped in packaged builds)

| Package | License | Role |
| --- | --- | --- |
| `takumi-pdf` | MIT OR Apache-2.0 | PDFCN renderer (wasm) |
| `@takumi-rs/helpers` | MIT | takumi helpers |
| `@embedpdf/pdfium` | MIT (bundles PDFium, BSD-style — see `LICENSE.pdfium` in the package) | PDF read/edit engine (wasm) |
| `harfbuzzjs` | MIT (HarfBuzz, ISC-style) | font subsetting (wasm) |
| `pdfjs-dist` (PDF.js) | Apache-2.0 | in-app PDF rendering |
| `pdf-lib` | MIT | PDF inspection in tests/tools |
| `jszip` | MIT OR GPL-3.0-or-later (MIT used) | DOCX container handling |

## Knowledge graph packages

| Package | License | Role |
| --- | --- | --- |
| `graphology` | MIT | graph data structure for the Wiki knowledge graph |
| `graphology-communities-louvain` | MIT | deterministic Louvain community detection |
| `graphology-types` | MIT | shared graphology typings |
| `graphology-layout-forceatlas2` | MIT | ForceAtlas2 layout for the Wiki graph viewer |
| `sigma` | MIT | WebGL renderer for the Wiki graph viewer |
| `@react-sigma/core` | MIT | React bindings for sigma (installed; viewer uses sigma directly) |

## Fonts

| Family | License | File |
| --- | --- | --- |
| Liberation Sans / Serif / Mono (Red Hat) | SIL Open Font License 1.1 | `resources/documents/pdf-fonts/LICENSE-OFL.txt` |
| Carlito (tyPoland) | OFL | same file |
| Noto Sans CJK (Adobe/Google) | OFL | same file |

## OCR helper

The Vision OCR helper source is vendored from GenOffice
(`src/vendor/genoffice/packages/pdf2docx/ocr-helper/`, Apache-2.0) and
compiled at packaging time by `npm run ocr:build`.
