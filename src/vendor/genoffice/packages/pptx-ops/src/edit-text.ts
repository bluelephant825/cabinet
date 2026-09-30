import { encodeRunLink, type Paragraph, type TextRun } from '@genoffice/pptx-engine'
import type { EditParagraph } from './types'

function hex6(color?: string): string | undefined {
  return color?.replace(/^#/, '').slice(0, 6).toUpperCase()
}

const FONT_ALIAS: Record<string, string> = {
  微软雅黑: 'microsoft yahei',
  苹方: 'pingfang sc',
  宋体: 'simsun',
  黑体: 'simhei',
  楷体: 'kaiti',
  仿宋: 'fangsong',
  等线: 'dengxian',
}

function fontKey(name?: string): string | undefined {
  if (!name) return undefined
  return FONT_ALIAS[name] ?? name.toLowerCase()
}

function templateParagraph(oldParas: Paragraph[], paragraph: EditParagraph, index: number): Paragraph | undefined {
  if (paragraph.srcPara != null) return oldParas[paragraph.srcPara]
  return oldParas[index] ?? oldParas[oldParas.length - 1]
}

function dominantRun(runs: TextRun[]): TextRun | undefined {
  let best: TextRun | undefined
  for (const run of runs) {
    if (run.field || run.hyperlink || run.hyperlinkRId || run.hyperlinkAction) continue
    if (!best || run.text.length > best.text.length) best = run
  }
  return best
}

export function applyEditParagraphs(oldParas: Paragraph[], edited: EditParagraph[]): Paragraph[] {
  return edited.map((paragraph, paragraphIndex) => {
    const oldParagraph = templateParagraph(oldParas, paragraph, paragraphIndex)
    const collapsed =
      paragraph.runs.length === 1 &&
      paragraph.runs[0]!.srcRun == null &&
      (oldParagraph?.runs.length ?? 0) > 1
        ? dominantRun(oldParagraph!.runs)
        : undefined
    return {
      ...oldParagraph,
      runs: paragraph.runs.map((run, runIndex) => {
        const oldRun =
          run.srcRun != null
            ? oldParagraph?.runs[run.srcRun]
            : (collapsed ?? oldParagraph?.runs[runIndex] ?? oldParagraph?.runs[0])
        const merged = {
          ...oldRun,
          text: run.text,
          bold: run.bold ?? oldRun?.bold,
          italic: run.italic ?? oldRun?.italic,
          underline: run.underline ?? oldRun?.underline,
          strike: run.strike ?? oldRun?.strike,
          fontSize: run.fontSize ?? oldRun?.fontSize,
          fontFamily: run.fontFamily ?? oldRun?.fontFamily,
          color: run.color ?? oldRun?.color,
        }
        if (run.baseline != null && Math.sign(run.baseline) !== Math.sign(oldRun?.baseline ?? 0)) {
          if (run.baseline === 0) delete merged.baseline
          else merged.baseline = run.baseline
        }
        if (merged.strike === false) delete merged.strikeStyle
        if (merged.rawXml && run.text !== oldRun?.text) delete merged.rawXml
        if (run.color != null && hex6(run.color) !== hex6(oldRun?.color)) {
          delete merged.colorFollowsTheme
          delete merged.colorInherited
          delete merged.colorNodeXml
        }
        if (run.fontFamily != null && fontKey(run.fontFamily) !== fontKey(oldRun?.fontFamily)) {
          delete merged.latinFont
          delete merged.eaFont
          delete merged.fontImplicit
        }
        if (merged.underline === false) delete merged.underlineStyle
        if (run.underline != null && run.underline !== oldRun?.underline) delete merged.underlineImplicit
        const keepsLink =
          run.link !== undefined
            ? !!run.link
            : oldRun?.hyperlink !== undefined || oldRun?.hyperlinkRId !== undefined
        if (
          run.underline != null &&
          (!oldRun?.underlineImplicit || keepsLink) &&
          run.underline !== (oldRun?.underline ?? false)
        ) {
          if (run.underline) delete merged.underlineExplicitNone
          else merged.underlineExplicitNone = true
        }
        if (run.strike != null && run.strike !== (oldRun?.strike ?? false)) {
          if (run.strike) delete merged.strikeExplicitNone
          else merged.strikeExplicitNone = true
        }
        const newLink = run.link ? encodeRunLink(run.link) : undefined
        if (
          run.link !== undefined &&
          newLink !== oldRun?.hyperlink &&
          (newLink || oldRun?.hyperlink)
        ) {
          if (newLink) {
            merged.hyperlink = newLink
            delete merged.hyperlinkRId
            delete merged.hyperlinkAction
            delete merged.hyperlinkTooltip
          } else {
            delete merged.hyperlink
            delete merged.hyperlinkRId
            delete merged.hyperlinkAction
            delete merged.hyperlinkTooltip
            if (merged.underlineImplicit) {
              merged.underline = false
              delete merged.underlineImplicit
              delete merged.underlineStyle
            }
          }
        }
        if (run.fontSize != null && run.fontSize !== oldRun?.fontSize) delete merged.fontSizeImplicit
        if (run.bold != null && run.bold !== (oldRun?.bold ?? false)) delete merged.boldImplicit
        if (run.italic != null && run.italic !== (oldRun?.italic ?? false)) delete merged.italicImplicit
        return merged
      }),
      align: paragraph.align ?? oldParagraph?.align,
      ...(paragraph.level != null && paragraph.level !== (oldParagraph?.level ?? 0)
        ? {
            level: paragraph.level || undefined,
            ...(oldParagraph?.pPrExplicit?.marL && oldParagraph.indent != null && oldParagraph.indent < 0
              ? { marL: -oldParagraph.indent * (paragraph.level + 1) }
              : {}),
          }
        : {}),
      ...(paragraph.align != null && oldParagraph && paragraph.align !== oldParagraph.align
        ? { pPrExplicit: { ...oldParagraph.pPrExplicit, align: true } }
        : {}),
    }
  })
}
