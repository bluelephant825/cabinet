/**
 * Step-1 compatibility & preservation gate for the vendored GenOffice engines
 * (src/vendor/genoffice, upstream @ f2c3d08). Proves, in this repo's runtime:
 *   a. DOCX parse + no-change save returns byte-identical bytes
 *   b. DOCX targeted paragraph edit preserves untouched XML / zip entries
 *   c. PDF content-stream text edit + save with read-back verification
 *   d. PDF image insert via the host image-codec adapter
 *   e. convertPdfToDocx on a digital-text PDF (no OCR engine)
 *   f. wasm/font asset resolution independent of cwd
 * Fixtures are generated programmatically (pdf-lib, pngjs, the vendored
 * engines themselves); generated artifacts are also written to a temp dir and
 * logged so failures can be inspected.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import JSZip from 'jszip'
import { PNG } from 'pngjs'
import { PDFDocument, StandardFonts } from 'pdf-lib'

import {
  buildBlankDocx,
  parseDocx,
  saveDocx,
  type SaveBlock,
} from '../src/vendor/genoffice/packages/docx-engine/src/index'
import {
  chainPdfium,
  loadPdfium,
  withDocument,
} from '../src/vendor/genoffice/apps/pdf/main/text-edit'
import { savePdfToPath } from '../src/vendor/genoffice/apps/pdf/main/save-pdf'
import { listPageImages } from '../src/vendor/genoffice/apps/pdf/main/image-edit'
import { convertPdfToDocx } from '../src/vendor/genoffice/packages/pdf2docx/src/index'
import type { SavePdfRequest, TextEditInput } from '../src/vendor/genoffice/apps/pdf/shared/ipc'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const artifacts = path.join(os.tmpdir(), `documents-gate-${process.pid}`)
mkdirSync(artifacts, { recursive: true })

const persist = (name: string, bytes: Uint8Array): string => {
  const p = path.join(artifacts, name)
  writeFileSync(p, bytes)
  return p
}

// ── DOCX helpers ────────────────────────────────────────────────────────────

const para = (text: string): SaveBlock => ({
  kind: 'generated',
  block: { type: 'paragraph', runs: [{ text }] },
})

/** Two-paragraph fixture produced by the vendored engine itself. */
async function makeTwoParaDocx(): Promise<Uint8Array> {
  const blank = await buildBlankDocx()
  const doc = await parseDocx(blank)
  return saveDocx(doc, [para('Alpha first line'), para('Beta second line')])
}

const visibleOriginals = (doc: Awaited<ReturnType<typeof parseDocx>>): SaveBlock[] =>
  doc.blocks
    .filter((b) => !b.hidden)
    .map((b): SaveBlock => ({ kind: 'original', docxIndex: b.docxIndex! }))

async function zipEntryMap(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const zip = await JSZip.loadAsync(bytes)
  const out = new Map<string, Uint8Array>()
  for (const [name, file] of Object.entries(zip.files)) {
    if (!file.dir) out.set(name, await file.async('uint8array'))
  }
  return out
}

// ── PDF helpers ─────────────────────────────────────────────────────────────

interface PdfFixture {
  bytes: Uint8Array
  /** user-space rect covering the first line (generous, per upstream test style) */
  rect1: [number, number, number, number]
}

async function makeTwoLinePdf(): Promise<PdfFixture> {
  const doc = await PDFDocument.create()
  const page = doc.addPage([595, 842])
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const size = 14
  page.drawText('First pdf line', { x: 50, y: 700, size, font })
  page.drawText('Second pdf line', { x: 50, y: 670, size, font })
  const w = font.widthOfTextAtSize('First pdf line', size)
  return {
    bytes: await doc.save({ useObjectStreams: false }),
    rect1: [45, 694, 50 + w + 5, 700 + size + 4],
  }
}

/** Extract a page's text through the same PDFium build the engine writes with. */
async function extractPageText(bytes: Uint8Array, pageIndex = 0): Promise<string> {
  // The vendored Pdfium interface omits a couple of FPDF exports the module has.
  const m = (await loadPdfium()) as Awaited<ReturnType<typeof loadPdfium>> & {
    _FPDFText_GetUnicode(textPage: number, index: number): number
  }
  return chainPdfium(() =>
    withDocument(m, bytes, async (doc) => {
      const page = m._FPDF_LoadPage(doc, pageIndex)
      assert.ok(page, 'page failed to load')
      const textPage = m._FPDFText_LoadPage(page)
      try {
        const n = m._FPDFText_CountChars(textPage)
        let s = ''
        for (let i = 0; i < n; i++) s += String.fromCodePoint(m._FPDFText_GetUnicode(textPage, i))
        return s
      } finally {
        m._FPDFText_ClosePage(textPage)
        m._FPDF_ClosePage(page)
      }
    }),
  )
}

/** Small solid-color PNG generated with pngjs (no binary blobs in the repo). */
function makePng(w = 16, h = 16): Buffer {
  const png = new PNG({ width: w, height: h })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 200
    png.data[i + 1] = 60
    png.data[i + 2] = 40
    png.data[i + 3] = 255
  }
  return PNG.sync.write(png)
}

const saveRequest = (partial: Partial<SavePdfRequest>): SavePdfRequest => ({
  path: '',
  markups: [],
  drawings: [],
  formValues: [],
  stamps: [],
  ...partial,
})

// ── tests ───────────────────────────────────────────────────────────────────

test('docx: no-change save is byte-identical', async () => {
  const bytes = await makeTwoParaDocx()
  persist('two-para.docx', bytes)
  const doc = await parseDocx(bytes)
  const saved = await saveDocx(doc, visibleOriginals(doc))
  // The engine guarantees the ORIGINAL file bytes back untouched when nothing changed.
  assert.deepEqual([...saved], [...bytes])
})

test('docx: targeted edit preserves untouched structures', async () => {
  const bytes = await makeTwoParaDocx()
  const doc = await parseDocx(bytes)
  const visible = doc.blocks.filter((b) => !b.hidden)
  assert.equal(visible.length >= 2, true)
  const para2Xml = visible[1]!.originalXml
  assert.ok(para2Xml, 'second paragraph has no originalXml anchor')

  const finalBlocks: SaveBlock[] = visible.map((b, i) =>
    i === 0
      ? {
          kind: 'generated',
          block: { type: 'paragraph', rawPPr: b.rawPPr, runs: [{ text: 'Alpha EDITED line' }] },
        }
      : { kind: 'original', docxIndex: b.docxIndex! },
  )
  const saved = await saveDocx(doc, finalBlocks)
  persist('two-para-edited.docx', saved)

  const reparsed = await parseDocx(saved)
  const texts = reparsed.blocks
    .filter((b) => !b.hidden)
    .map((b) => (b.runs ?? []).map((r) => r.text).join('') || b.previewText || '')
  assert.ok(texts.some((t) => t.includes('Alpha EDITED line')))
  assert.ok(texts.some((t) => t.includes('Beta second line')))

  // The untouched paragraph is copied byte-for-byte from the original XML slice.
  const newDocXml = await (await JSZip.loadAsync(saved))
    .file('word/document.xml')!
    .async('string')
  assert.ok(newDocXml.includes(para2Xml), 'untouched paragraph XML changed')

  // Every zip entry other than the edited document part is byte-identical.
  const before = await zipEntryMap(bytes)
  const after = await zipEntryMap(saved)
  const volatile = new Set(['word/document.xml', 'docProps/core.xml'])
  for (const [name, content] of before) {
    if (volatile.has(name)) continue
    assert.deepEqual([...after.get(name)!], [...content], `zip entry changed: ${name}`)
  }
})

test('pdf: content-stream text edit saves and verifies', async () => {
  const f = await makeTwoLinePdf()
  const src = persist('two-line.pdf', f.bytes)
  const dst = path.join(artifacts, 'two-line-edited.pdf')

  const edit: TextEditInput = {
    pageIndex: 0,
    rect: f.rect1,
    oldText: 'First pdf line',
    newText: 'Edited first line',
    fontSize: 14,
  }
  // savePdfToPath is the file wrapper: applySaveRequest + read-back
  // verification + atomic write (applySaveRequest alone skips verification).
  const skips = await savePdfToPath(src, dst, saveRequest({ path: src, textEdits: [edit] }))
  assert.deepEqual(skips.skippedTextEdits, [])
  assert.deepEqual(skips.skippedTextInserts, [])
  assert.deepEqual(skips.skippedImageEdits, [])
  assert.ok(existsSync(dst))

  const text = await extractPageText(new Uint8Array(await readFile(dst)))
  assert.ok(text.includes('Edited first line'), `edited line missing: ${text}`)
  assert.ok(text.includes('Second pdf line'), `untouched line missing: ${text}`)
})

test('pdf: image insert lands one image object at the expected bounds', async () => {
  const f = await makeTwoLinePdf()
  const src = persist('img-src.pdf', f.bytes)
  const dst = path.join(artifacts, 'img-dst.pdf')
  const rect: [number, number, number, number] = [300, 600, 364, 664]
  const skips = await savePdfToPath(
    src,
    dst,
    saveRequest({
      path: src,
      imageEdits: [
        {
          kind: 'insertImage',
          pageIndex: 0,
          image: makePng().toString('base64'),
          rect,
          layer: 'aboveText',
        },
      ],
    }),
  )
  assert.deepEqual(skips.skippedImageEdits, [])

  const out = new Uint8Array(await readFile(dst))
  const images = await listPageImages(out)
  assert.equal(images.length, 1)
  const [x1, y1, x2, y2] = images[0]!.rect
  for (const [got, want] of [
    [x1, rect[0]],
    [y1, rect[1]],
    [x2, rect[2]],
    [y2, rect[3]],
  ] as const) {
    assert.ok(Math.abs(got - want) < 1.5, `bounds mismatch: got ${images[0]!.rect}, want ${rect}`)
  }
})

test('pdf2docx: digital-text pdf converts without ocr', async () => {
  const f = await makeTwoLinePdf()
  const m = (await loadPdfium()) as unknown as Parameters<typeof convertPdfToDocx>[1]['pdfium']
  const result = await convertPdfToDocx(f.bytes, { pdfium: m })
  assert.equal(result.pages, 1)
  assert.equal(result.scannedDocument, false)
  assert.ok(Array.isArray(result.warnings))
  assert.ok(Array.isArray(result.pageResults))
  assert.ok(result.docx.length > 0)
  persist('converted.docx', result.docx)

  // Assert on the actual document part rather than parse-model fields.
  const docXml = await (await JSZip.loadAsync(result.docx))
    .file('word/document.xml')!
    .async('string')
  assert.ok(docXml.includes('First pdf line'), 'converted docx missing line 1')
  assert.ok(docXml.includes('Second pdf line'), 'converted docx missing line 2')
})

test('assets: wasm and font metrics resolve outside the repo cwd', () => {
  const script = path.join(repoRoot, 'test/fixtures/documents/resolve-assets.ts')
  const out = execFileSync('npx', ['tsx', script], {
    cwd: os.tmpdir(),
    encoding: 'utf8',
    timeout: 120_000,
  })
  const result = JSON.parse(out.trim().split('\n').pop()!) as {
    pdfium: string
    hbSubset: string
    pdfiumExists: boolean
    hbSubsetExists: boolean
    helveticaBytes: number
  }
  assert.ok(result.pdfiumExists, `pdfium wasm missing: ${result.pdfium}`)
  assert.ok(result.hbSubsetExists, `harfbuzz subset wasm missing: ${result.hbSubset}`)
  // font-metrics reads the host's installed fonts; on this macOS host a
  // Helvetica face must resolve to standalone sfnt bytes.
  assert.ok(result.helveticaBytes > 0, 'system font lookup returned no bytes')
})

test.after(() => {
  console.log(`documents-gate artifacts: ${artifacts}`)
})
