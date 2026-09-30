import type { NamedAction } from '@genoffice/pptx-engine'

export interface EditRun {
  text: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  fontSize?: number
  fontFamily?: string
  color?: string
  strike?: boolean
  baseline?: number
  outline?: { color: string; widthEmu: number }
  field?: string
  srcRun?: number
  link?: LinkTargetOp | null
}

export interface EditParagraph {
  runs: EditRun[]
  align?: 'left' | 'center' | 'right' | 'justify'
  level?: number
  srcPara?: number
  bullet?: 'char' | 'number' | 'blip' | 'none'
  bulletChar?: string
  bulletFont?: string
  numType?: string
  startAt?: number
  bulletImage?: { base64: string; ext: string }
  lineSpacingPct?: number
  spaceBeforePt?: number
  spaceAfterPt?: number
  rtl?: boolean
}

export interface ScriptBoxOp {
  id: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  groupId?: string
}

export interface ScriptStylePatch {
  fontSize?: number
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  fontFamily?: string
  align?: 'left' | 'center' | 'right'
}

export type ScriptEditOp = (
  | { kind: 'text'; paragraphs: EditParagraph[] }
  | { kind: 'style'; style: ScriptStylePatch }
  | { kind: 'fill'; fill: string }
  | { kind: 'stroke'; stroke: { color: string; widthPt: number } | null }
) & { id: string; groupId?: string }

export interface ApplyEditScriptOp {
  slideIndex: number
  fitWidthPx: number
  boxes: ScriptBoxOp[]
  edits: ScriptEditOp[]
}

export type LinkTargetOp =
  | { kind: 'url'; url: string }
  | { kind: 'slide'; slideIndex: number }
  | { kind: 'action'; action: NamedAction }
