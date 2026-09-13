#!/usr/bin/env node
/**
 * Generate/verify a vendored tree's PROVENANCE.json.
 *
 *   node scripts/vendor-provenance.mjs --vendor genoffice            # regenerate
 *   node scripts/vendor-provenance.mjs --vendor genoffice --check    # verify local hashes
 *   node scripts/vendor-provenance.mjs --vendor pdfcn --check --upstream /tmp/pdfcn-src
 *                                                                      # + upstream hashes
 *
 * The manifest records, for every vendored file, the sha256 of the local copy
 * and (when it exists upstream) the sha256 of the upstream source file at the
 * pinned commit. A file whose local bytes differ from upstream is marked
 * `adapted` and must carry an `adaptationNote` in the vendor config.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VENDORS } from './vendor-provenance.config.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

function* walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

export function runVendorProvenance(argv, vendorKey) {
  const cfg = VENDORS[vendorKey]
  if (!cfg) {
    console.error(`unknown vendor "${vendorKey}" (have: ${Object.keys(VENDORS).join(', ')})`)
    process.exit(1)
  }
  const VENDOR = join(ROOT, cfg.dir)
  const MANIFEST = join(VENDOR, 'PROVENANCE.json')
  const EXCLUDED = new Set(['PROVENANCE.json', ...(cfg.excluded ?? [])])
  const upstreamPathFor = cfg.upstreamPathFor ?? ((rel) => rel)
  // Optional byte normalization applied before hashing/comparing — used for
  // mechanical import-path rewrites so only semantic changes need `adapted`.
  const normalize = cfg.localNormalize ?? ((buf) => buf)
  const localHash = (abs) => sha256(normalize(readFileSync(abs)))

  function build(upstreamDir) {
    const files = []
    for (const abs of walk(VENDOR)) {
      const rel = relative(VENDOR, abs).split('\\').join('/')
      if (EXCLUDED.has(rel)) continue
      const localSha = localHash(abs)
      const upstreamPath = cfg.cabinetOwned.has(rel) ? null : upstreamPathFor(rel)
      let upstreamSha256 = null
      if (upstreamPath && upstreamDir) {
        const up = join(upstreamDir, upstreamPath)
        if (existsSync(up)) upstreamSha256 = sha256(readFileSync(up))
      }
      const entry = { path: rel, upstreamPath, sha256: localSha, adapted: false }
      if (upstreamSha256) entry.upstreamSha256 = upstreamSha256
      if (cfg.adapted[rel]) {
        entry.adapted = true
        entry.adaptationNote = cfg.adapted[rel]
      }
      files.push(entry)
    }
    return { upstream: cfg.upstream, parent: cfg.parent ?? null, commit: cfg.commit, files }
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
      const localSha = localHash(abs)
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

  const checkMode = argv.includes('--check')
  const upIdx = argv.indexOf('--upstream')
  const upstreamDir = upIdx >= 0 ? resolve(argv[upIdx + 1]) : null

  if (checkMode) {
    const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'))
    if (manifest.commit !== cfg.commit) {
      console.error(`manifest commit ${manifest.commit} != pinned ${cfg.commit}`)
      process.exit(1)
    }
    const failures = check(manifest, upstreamDir)
    if (failures > 0) {
      console.error(`${failures} provenance failure(s)`)
      process.exit(1)
    }
    console.log(`provenance ok: ${manifest.files.length} files @ ${cfg.commit.slice(0, 7)}`)
  } else {
    const manifest = build(upstreamDir)
    writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n')
    console.log(`wrote ${MANIFEST} (${manifest.files.length} files)`)
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  const argv = process.argv.slice(2)
  const vIdx = argv.indexOf('--vendor')
  runVendorProvenance(argv.filter((_, i) => i !== vIdx && i !== vIdx + 1), vIdx >= 0 ? argv[vIdx + 1] : 'genoffice')
}
