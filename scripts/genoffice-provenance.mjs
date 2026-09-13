#!/usr/bin/env node
/**
 * Generate/verify src/vendor/genoffice/PROVENANCE.json.
 *
 *   node scripts/genoffice-provenance.mjs            # regenerate manifest
 *   node scripts/genoffice-provenance.mjs --check    # verify local file hashes
 *   node scripts/genoffice-provenance.mjs --check --upstream /path/to/genoffice
 *                                                    # also verify upstream hashes
 *
 * The manifest records, for every vendored file, the sha256 of the local copy
 * and (when it exists upstream) the sha256 of the upstream source file at the
 * pinned commit. A file whose local bytes differ from upstream is marked
 * `adapted` and must carry an `adaptationNote`.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENDOR = join(ROOT, 'src/vendor/genoffice')
const MANIFEST = join(VENDOR, 'PROVENANCE.json')

const UPSTREAM = 'https://github.com/bluelephant825/genoffice'
const PARENT = 'https://github.com/genspark-ai/genoffice'
const COMMIT = 'f2c3d0879df29622d5a447935d2b4aeac033544d'

/** Vendored files that are not verbatim copies, with the reason. Keyed by the
    vendored path relative to src/vendor/genoffice. */
const ADAPTED = {
  'apps/pdf/shared/ipc.ts':
    'dropped @genoffice/i18n + @genoffice/ai-provider type imports and the shell-facing AI_CHANNELS/ImageSearchResponse/PdfApi tail; document-domain types unchanged',
  'apps/pdf/main/font-locate.ts':
    'workspace import @genoffice/font-metrics rewritten to a relative path',
  'apps/pdf/main/image-edit.ts':
    "electron nativeImage import replaced with the host codec adapter '../../../host/image-codec'",
  'apps/pdf/main/wasm-path.ts':
    'process.resourcesPath fallback guarded for plain Node; CABINET_WASM_DIR env override added',
  'packages/docx-engine/src/parse.ts':
    'workspace import @genoffice/pptx-engine/custgeom rewritten to a relative path',
}

/** Vendored paths that do not exist upstream (Cabinet-owned additions). */
const CABINET_OWNED = new Set(['host/image-codec.ts', 'THIRD_PARTY_NOTICES.md', 'README.md'])

/** The manifest cannot hash itself. */
const EXCLUDED = new Set(['PROVENANCE.json'])

/** Map a vendored relative path back to its upstream repo path. */
function upstreamPathFor(rel) {
  if (rel.startsWith('apps/pdf/main/')) return `apps/pdf/src/main/${rel.slice('apps/pdf/main/'.length)}`
  if (rel.startsWith('apps/pdf/shared/'))
    return `apps/pdf/src/shared/${rel.slice('apps/pdf/shared/'.length)}`
  if (rel === 'LICENSE' || rel === 'NOTICE' || rel === 'LICENSE-UNICODE.txt') return rel
  return rel
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

function build(upstreamDir) {
  const files = []
  for (const abs of walk(VENDOR)) {
    const rel = relative(VENDOR, abs).split('\\').join('/')
    if (EXCLUDED.has(rel)) continue
    const localSha = sha256(readFileSync(abs))
    const upstreamPath = CABINET_OWNED.has(rel) ? null : upstreamPathFor(rel)
    let upstreamSha256 = null
    if (upstreamPath && upstreamDir) {
      const up = join(upstreamDir, upstreamPath)
      if (existsSync(up)) upstreamSha256 = sha256(readFileSync(up))
    }
    const entry = { path: rel, upstreamPath, sha256: localSha, adapted: false }
    if (upstreamSha256) entry.upstreamSha256 = upstreamSha256
    if (ADAPTED[rel]) {
      entry.adapted = true
      entry.adaptationNote = ADAPTED[rel]
    }
    files.push(entry)
  }
  return { upstream: UPSTREAM, parent: PARENT, commit: COMMIT, files }
}

function check(manifest, upstreamDir) {
  let failures = 0
  for (const f of manifest.files) {
    const abs = join(VENDOR, f.path)
    if (!existsSync(abs)) {
      console.error(`MISSING local file: ${f.path}`)
      failures++
      continue
    }
    const localSha = sha256(readFileSync(abs))
    if (localSha !== f.sha256) {
      console.error(`DRIFT local file modified since vendoring: ${f.path}`)
      failures++
    }
    if (upstreamDir && f.upstreamPath) {
      const up = join(upstreamDir, f.upstreamPath)
      if (!existsSync(up)) {
        console.error(`MISSING upstream file: ${f.upstreamPath}`)
        failures++
      } else if (f.upstreamSha256 && sha256(readFileSync(up)) !== f.upstreamSha256) {
        console.error(`DRIFT upstream file differs from pinned content: ${f.upstreamPath}`)
        failures++
      }
      if (!f.adapted && f.upstreamSha256 && f.upstreamSha256 !== f.sha256) {
        console.error(`UNDECLARED ADAPTATION: ${f.path} differs from upstream`)
        failures++
      }
      if (f.adapted && f.upstreamSha256 === f.sha256) {
        console.error(`STALE adapted flag (now identical to upstream): ${f.path}`)
        failures++
      }
    }
  }
  // files on disk missing from the manifest
  const listed = new Set(manifest.files.map((f) => f.path))
  for (const abs of walk(VENDOR)) {
    const rel = relative(VENDOR, abs).split('\\').join('/')
    if (EXCLUDED.has(rel)) continue
    if (!listed.has(rel)) {
      console.error(`UNLISTED vendored file: ${rel}`)
      failures++
    }
  }
  return failures
}

const args = process.argv.slice(2)
const checkMode = args.includes('--check')
const upIdx = args.indexOf('--upstream')
const upstreamDir = upIdx >= 0 ? resolve(args[upIdx + 1]) : null

if (checkMode) {
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
  if (manifest.commit !== COMMIT) {
    console.error(`manifest commit ${manifest.commit} != pinned ${COMMIT}`)
    process.exit(1)
  }
  const failures = check(manifest, upstreamDir)
  if (failures > 0) {
    console.error(`${failures} provenance failure(s)`)
    process.exit(1)
  }
  console.log(`provenance ok: ${manifest.files.length} files @ ${COMMIT.slice(0, 7)}`)
} else {
  const manifest = build(upstreamDir)
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
  console.log(`wrote ${MANIFEST} (${manifest.files.length} files)`)
}
