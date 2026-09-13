/**
 * Step-4 DOCX editor model tests: the worker `docxLoad`/`docxSave` ops must
 * produce a JSON-serializable model and a lossless save boundary (a no-change
 * plan returns byte-identical bytes; a one-paragraph edit preserves every
 * other block's original XML).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  buildBlankDocx,
  parseDocx,
  saveDocx,
  type SaveBlock,
} from '../src/vendor/genoffice/packages/docx-engine/src/index'
import type { DocxDocumentModel, DocxSaveBlock } from '../src/lib/documents/types'
import { runOp } from '../server/documents/worker-ops'

const artifacts = path.join(os.tmpdir(), `documents-docx-model-${process.pid}`)
mkdirSync(artifacts, { recursive: true })

const persist = (name: string, bytes: Uint8Array): string => {
  const p = path.join(artifacts, name)
  writeFileSync(p, bytes)
  return p
}

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

test('docxLoad returns a JSON round-trippable model', async () => {
  const inputPath = persist('model.docx', await makeTwoParaDocx())
  const model = (await runOp('docxLoad', { inputPath })) as DocxDocumentModel

  // JSON.stringify drops explicit `undefined` fields — compare serialized
  // forms so the check is about JSON fidelity, not key enumeration.
  assert.equal(JSON.stringify(JSON.parse(JSON.stringify(model))), JSON.stringify(model))
  assert.equal(model.format, 'docx')
  assert.ok(Array.isArray(model.blocks) && model.blocks.length >= 2)
  assert.ok(Array.isArray(model.sections))
  assert.ok(Array.isArray(model.styles))
  assert.ok(Array.isArray(model.numbering))
  assert.equal(model.oversizedImages, 0)
  // Every serialized block is a plain object carrying a docxIndex anchor.
  for (const block of model.blocks as { docxIndex?: number }[]) {
    assert.equal(typeof block.docxIndex, 'number')
  }
})

test('docxSave with a no-change plan is byte-identical', async () => {
  const bytes = await makeTwoParaDocx()
  const inputPath = persist('identity-in.docx', bytes)
  const model = (await runOp('docxLoad', { inputPath })) as DocxDocumentModel

  const saveBlocks: DocxSaveBlock[] = (model.blocks as { hidden?: boolean; docxIndex: number }[])
    .filter((b) => !b.hidden)
    .map((b) => ({ kind: 'original', docxIndex: b.docxIndex }))

  const outputPath = path.join(artifacts, 'identity-out.docx')
  await runOp('docxSave', {
    inputPath,
    outputPath,
    plan: { saveBlocks: JSON.parse(JSON.stringify(saveBlocks)) },
  })

  const out = new Uint8Array(await import('node:fs/promises').then((fs) => fs.readFile(outputPath)))
  assert.deepEqual(out, bytes)
})

test('docxSave changing one paragraph preserves the other blocks', async () => {
  const bytes = await makeTwoParaDocx()
  const inputPath = persist('edit-in.docx', bytes)
  const model = (await runOp('docxLoad', { inputPath })) as DocxDocumentModel

  const visible = (model.blocks as { hidden?: boolean; docxIndex: number }[]).filter(
    (b) => !b.hidden,
  )
  const saveBlocks: DocxSaveBlock[] = [
    { kind: 'generated', block: { type: 'paragraph', runs: [{ text: 'Edited text' }] } },
    ...visible.slice(1).map((b) => ({ kind: 'original' as const, docxIndex: b.docxIndex })),
  ]

  const outputPath = path.join(artifacts, 'edit-out.docx')
  await runOp('docxSave', {
    inputPath,
    outputPath,
    plan: { saveBlocks },
  })

  const out = new Uint8Array(await import('node:fs/promises').then((fs) => fs.readFile(outputPath)))
  assert.notDeepEqual(out, bytes)

  const reparsed = await parseDocx(out)
  const texts = reparsed.blocks.map((b) =>
    (b.runs ?? []).map((r) => r.text ?? '').join(''),
  )
  assert.ok(texts.includes('Edited text'))
  assert.ok(texts.includes('Beta second line'))
  // The untouched paragraph still carries its original XML anchor.
  const beta = reparsed.blocks.find(
    (b) => (b.runs ?? []).map((r) => r.text ?? '').join('') === 'Beta second line',
  )
  assert.ok(beta?.originalXml, 'untouched block lost its originalXml')
})

test('docxSave rejects an empty plan', async () => {
  const inputPath = persist('empty-plan.docx', await makeTwoParaDocx())
  await assert.rejects(
    () =>
      runOp('docxSave', {
        inputPath,
        outputPath: path.join(artifacts, 'never.docx'),
        plan: { saveBlocks: [] },
      }),
    /no blocks/,
  )
})
