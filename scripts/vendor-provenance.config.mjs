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
    commit: 'f2c3d0879df29622d5a447935d2b4aeac033544d',
    dir: 'src/vendor/genoffice',
    upstreamPathFor: genofficeUpstreamPathFor,
    adapted: {
      'apps/pdf/shared/ipc.ts':
        'dropped @genoffice/i18n + @genoffice/ai-provider type imports and the shell-facing AI_CHANNELS/ImageSearchResponse/PdfApi tail; document-domain types unchanged',
      'apps/pdf/main/font-locate.ts':
        'workspace import @genoffice/font-metrics rewritten to a relative path',
      'apps/pdf/main/text-edit.ts':
        'color-only edits with unchanged text set the fill color in place instead of rebuilding the run (keeps the original font)',
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
        'aggregator rewritten to merge only the vendored string domains (editor + ribbon + table); the app/, ai/ and other shell domains are not vendored',
      'apps/pdf/renderer/ImageEditLayer.tsx':
        "as-CSSProperties cast on the veil style — upstream's local Box type lacks the `--*` index signature current @types/react requires",
    },
    cabinetOwned: new Set(['host/image-codec.ts', 'THIRD_PARTY_NOTICES.md', 'README.md']),
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
