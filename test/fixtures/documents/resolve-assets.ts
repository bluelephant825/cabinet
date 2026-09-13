/**
 * Child-process probe for the documents-gate asset test: resolves the runtime
 * wasm assets and the system-font index from a cwd outside the repo (the
 * parent test spawns this with cwd=os.tmpdir()).
 */
import { existsSync } from 'node:fs'
import {
  pdfiumWasmPath,
  hbSubsetWasmPath,
} from '../../../src/vendor/genoffice/apps/pdf/main/wasm-path'
import { findSystemFont } from '../../../src/vendor/genoffice/packages/font-metrics/src/index'

const result = {
  cwd: process.cwd(),
  pdfium: pdfiumWasmPath(),
  hbSubset: hbSubsetWasmPath(),
  pdfiumExists: existsSync(pdfiumWasmPath()),
  hbSubsetExists: existsSync(hbSubsetWasmPath()),
  helveticaBytes: findSystemFont('Helvetica', 'Helvetica')?.length ?? 0,
}
console.log(JSON.stringify(result))
