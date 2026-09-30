/**
 * Per-vendor provenance configuration for scripts/vendor-provenance.mjs.
 *
 *   upstream      upstream repo URL
 *   parent        repo the upstream forked from, when relevant
 *   commit        pinned upstream commit the files were vendored at
 *   dir           vendored tree, relative to repo root
 *   adapted       vendored rel path → reason it differs from upstream
 *   cabinetOwned  rel paths with no upstream counterpart
 *   upstreamPathFor  map a vendored rel path back to its upstream repo path
 */

const genofficeUpstreamPathFor = (rel) => {
  if (rel.startsWith('apps/pdf/main/')) return `apps/pdf/src/main/${rel.slice('apps/pdf/main/'.length)}`
  if (rel.startsWith('apps/pdf/renderer/'))
    return `apps/pdf/src/renderer/${rel.slice('apps/pdf/renderer/'.length)}`
  if (rel.startsWith('apps/pdf/shared/'))
    return `apps/pdf/src/shared/${rel.slice('apps/pdf/shared/'.length)}`
  return rel
}

export const VENDORS = {
  genoffice: {
    upstream: 'https://github.com/bluelephant825/genoffice',
    parent: 'https://github.com/genspark-ai/genoffice',
    commit: '476e5023c9a4bc459ca6de7b1d697ab25d94850e',
    dir: 'src/vendor/genoffice',
    upstreamPathFor: genofficeUpstreamPathFor,
    adapted: {
      'apps/pdf/shared/ipc.ts':
        'dropped @genoffice/i18n + @genoffice/ai-provider type imports and the shell-facing AI_CHANNELS/ImageSearchResponse/PdfApi tail; document-domain types unchanged',
      'apps/pdf/main/font-locate.ts':
        'workspace import @genoffice/font-metrics rewritten to a relative path',
      'apps/pdf/main/text-edit.ts':
        'color-only edits with unchanged text set the fill color in place instead of rebuilding the run (keeps the original font; applied inside applyPageEdits); edit font ids may be installed family names resolved through the font index, and the newFont branch wraps subsets in identityCffCharset',
      'apps/pdf/main/image-edit.ts':
        "electron nativeImage import replaced with the host codec adapter '../../../host/image-codec'",
      'apps/pdf/main/wasm-path.ts':
        'process.resourcesPath fallback guarded for plain Node; CABINET_WASM_DIR env override added',
      'packages/docx-engine/src/parse.ts':
        'workspace import @genoffice/pptx-engine/custgeom rewritten to a relative path',
      'apps/docs/src/renderer/env.d.ts':
        'upstream declares the full Electron DesktopApi; Cabinet declares only the minimal optional shape the vendored editor touches (copyImageToClipboard, onLanguageChanged)',
      'apps/pdf/renderer/view-config.ts':
        'ASSET_BASE rewritten to the absolute same-origin path /document-editor/pdfjs/ (assets copied by scripts/postinstall.mjs)',
      'apps/docs/src/renderer/i18n/strings.ts':
        'aggregator rewritten to merge only the vendored string domains (ribbon + table + editor + zotero, upstream precedence); the app/ and ai/ shell domains are not vendored',
      'apps/docs/src/shared/ipc.ts':
        "upstream's docs IPC contract (DesktopApi, AI channels, agent-core/ai-provider/electron-utils types) is shell-facing and not vendored; trimmed to the AgentToolDef shape the vendored renderer ai/style-ops.ts needs",
      'packages/ui/src/index.ts':
        'upstream barrel re-exports the whole shared UI kit (AiComposer, Dropdown, Markdown, find panel, ribbon collapse, dialogs…); the vendored editors only need the WordArt presets, the shape-clip helper and the find-text helpers (foldCase for PDF search; findInText/FindOptions also used by the Cabinet DOCX find panel), so the barrel exports just those',
      'apps/pdf/renderer/ImageEditLayer.tsx':
        "as-CSSProperties cast on the veil style — upstream's local Box type lacks the `--*` index signature current @types/react requires",
      'packages/pptx-ops/package.json':
        'trimmed to the Apache text-edit subset used by Cabinet; scripts, dev dependencies and unrelated op-layer exports are omitted',
      'packages/pptx-ops/src/index.ts':
        'trimmed to applyEditParagraphs and its public text-edit payload types; deck-generation and structural op exports remain deferred to the skill path',
      'packages/pptx-ops/src/types.ts':
        'trimmed to text-edit payload types and their script/link dependencies; comments and unrelated app IPC payloads are omitted',
      'packages/pptx-ops/src/edit-text.ts':
        'trimmed to applyEditParagraphs; paragraph-format collection and level-change helpers are not needed by the Phase 4 text/notes surface',
      'packages/pptx-render/src/coords.ts':
        'trimmed comments only; EMU/viewport/placement behavior is unchanged and used by the Cabinet worker model',
    },
    cabinetOwned: new Set(['host/image-codec.ts', 'THIRD_PARTY_NOTICES.md', 'README.md']),
    excludedPrefixes: ['apps/sheets/native/xlsx-engine/target/'],
  },

  pdfcn: {
    upstream: 'https://github.com/shadcn-labs/pdfcn',
    commit: '88ca522c13dff7cd13d05c208fa47f970d32fd8c',
    dir: 'src/vendor/pdfcn',
    // Vendored tree mirrors upstream's registry/ layout; imports were
    // rewritten '@/' → '@/vendor/pdfcn/' at copy time.
    upstreamPathFor: (rel) => rel,
    // Every vendored .ts/.tsx file had its '@/…' imports rewritten to
    // '@/vendor/pdfcn/…' — mechanical, normalized away before hashing so only
    // semantic changes need an `adapted` entry.
    localNormalize: (buf) =>
      Buffer.from(buf.toString('utf8').replaceAll('@/vendor/pdfcn/registry/', '@/registry/'), 'utf8'),
    adapted: {
      'registry/bases/takumi/components/theme-provider.tsx':
        "serializedTheme module-global replaced with AsyncLocalStorage request-local state (runWithPdfcnTheme) — concurrent renders with different themes raced upstream",
      'registry/bases/takumi/components/page-number/page-number.tsx':
        'flatten() result cast to CSSProperties at the two primitive style props — upstream relied on a looser Style type',
      'registry/bases/takumi/blocks/report-financial/report-layout.tsx':
        'DataTable column render callback param annotated `unknown` — implicit any under strict',
      'registry/bases/takumi/lib/pdf-primitives.tsx':
        "dropped the upstream `eslint(nextjs/no-img-element)` disable comments — that rule name doesn't exist in Cabinet's flat config and lint rejected it",
    },
    cabinetOwned: new Set([]),
    excluded: [],
  },
}
