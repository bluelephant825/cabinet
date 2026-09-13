#!/usr/bin/env node
/**
 * Build the platform OCR helper binaries used by server/documents/ocr/.
 * Sources are vendored (with provenance) in
 * src/vendor/genoffice/packages/pdf2docx/ocr-helper/.
 *
 *   node scripts/build-ocr-helpers.mjs        # npm run ocr:build
 *
 * darwin : swiftc -O vision-ocr.swift -o resources/documents/ocr/darwin-<arch>/vision-ocr
 *          (builds for every SDK-installed arch it can; at minimum the host arch)
 * win32  : csc/dotnet win-ocr.cs → resources/documents/ocr/win32-x64/win-ocr.exe
 * other  : prints what's missing and exits 0 — OCR degrades to "none".
 */
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src/vendor/genoffice/packages/pdf2docx/ocr-helper')
const OUT = join(ROOT, 'resources/documents/ocr')

const have = (cmd, args = ['--version']) =>
  spawnSync(cmd, args, { stdio: 'ignore' }).status === 0

let built = 0

if (process.platform === 'darwin') {
  if (!have('xcrun', ['-f', 'swiftc'])) {
    console.log('[ocr] swiftc not found — install Xcode command line tools; skipping')
  } else {
    // Build for every arch the installed SDK supports; fall back to host arch.
    const sdks = spawnSync('xcrun', ['--show-sdk-platform-version'], { encoding: 'utf8' })
    const archs = spawnSync('xcrun', ['swiftc', '-print-target-info'], { encoding: 'utf8' })
    const wanted = new Set([process.arch === 'arm64' ? 'arm64' : 'x86_64'])
    try {
      const uname = spawnSync('uname', ['-m'], { encoding: 'utf8' }).stdout.trim()
      void uname
      // swiftc can target both arches with -target; try both, keep what works.
      for (const a of ['arm64', 'x86_64']) wanted.add(a)
    } catch { /* host arch only */ }
    void sdks; void archs
    for (const arch of wanted) {
      const triple = `${arch}-apple-macosx12.0`
      const dir = join(OUT, `darwin-${arch}`)
      mkdirSync(dir, { recursive: true })
      const out = join(dir, 'vision-ocr')
      const r = spawnSync(
        'xcrun',
        ['swiftc', '-O', '-target', triple, join(SRC, 'vision-ocr.swift'), '-o', out],
        { stdio: 'inherit' },
      )
      if (r.status === 0) {
        built++
        console.log(`[ocr] built ${out}`)
      } else {
        console.log(`[ocr] swiftc could not target ${arch} — skipped`)
      }
    }
  }
} else if (process.platform === 'win32') {
  const dir = join(OUT, 'win32-x64')
  mkdirSync(dir, { recursive: true })
  const out = join(dir, 'win-ocr.exe')
  if (have('csc')) {
    const r = spawnSync('csc', ['/nologo', '/optimize+', `/out:${out}`, join(SRC, 'win-ocr.cs')], {
      stdio: 'inherit',
    })
    if (r.status === 0) { built++; console.log(`[ocr] built ${out}`) }
    else console.log('[ocr] csc failed — skipped')
  } else {
    console.log('[ocr] csc/dotnet not found — install the .NET SDK; skipping')
  }
} else {
  console.log(`[ocr] no OCR helper for platform ${process.platform} — the 'none' provider applies`)
}

console.log(`[ocr] done (${built} helper(s) built)`)
process.exit(0)
