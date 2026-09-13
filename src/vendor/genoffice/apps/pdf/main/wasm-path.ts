import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/**
 * Runtime wasm assets live in node_modules during dev/tests but the packaged app
 * ships no node_modules (everything is bundled) — electron-builder copies them
 * into Resources/wasm instead (see apps/shell/electron-builder.cjs extraResources).
 */
// Adapted for Cabinet: plain Node has no process.resourcesPath; hosts may set
// CABINET_WASM_DIR (packaged resources dir containing the wasm files).
const packagedPath = (fileName: string) => {
  const base = process.resourcesPath ?? process.env.CABINET_WASM_DIR
  if (!base) {
    throw new Error(
      `cannot resolve ${fileName}: no node_modules copy found and neither ` +
        `process.resourcesPath nor CABINET_WASM_DIR is set`,
    )
  }
  return join(base, 'wasm', fileName)
}

const req = () => createRequire(import.meta.url)

export function pdfiumWasmPath(): string {
  try {
    return req().resolve('@embedpdf/pdfium/pdfium.wasm')
  } catch {
    return packagedPath('pdfium.wasm')
  }
}

export function hbSubsetWasmPath(): string {
  const r = req()
  try {
    // harfbuzzjs ≤0.10 ships hb-subset.wasm at the package root with no exports map
    return r.resolve('harfbuzzjs/hb-subset.wasm')
  } catch {
    /* fall through */
  }
  try {
    // harfbuzzjs ≥1.x seals subpaths; the wasm sits next to the exported entry point
    const p = join(dirname(r.resolve('harfbuzzjs')), 'harfbuzz-subset.wasm')
    if (existsSync(p)) return p
  } catch {
    /* fall through */
  }
  return packagedPath('hb-subset.wasm')
}
