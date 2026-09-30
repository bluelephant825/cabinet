/**
 * 2.1 Coordinate system — EMU → px conversion + slide viewport mapping.
 *
 * OOXML uses EMU (English Metric Unit): 1 inch = 914400 EMU, 1 px@96dpi = 9525 EMU.
 * Rendering maps EMU geometry to target canvas pixels; the slide size plus the
 * target viewport size determine one uniform scale factor, keeping proportions
 * without stretching.
 *
 * Angles: OOXML rot unit = 1/60000 degree; clockwise positive (matching Canvas/CSS).
 */
import type { EmuRect, Transform, SlideSize } from '@genoffice/pptx-engine'

export const EMU_PER_INCH = 914400
export const EMU_PER_PX_96 = 9525
export const EMU_PER_PT = 12700

export function emuToPx(emu: number, scale = 1): number {
  if (!Number.isFinite(emu) || !Number.isFinite(scale)) return 0
  return (emu / EMU_PER_PX_96) * scale
}

export function ptToPx(pt: number, scale = 1): number {
  if (!Number.isFinite(pt) || !Number.isFinite(scale)) return 0
  return ((pt * 96) / 72) * scale
}

export function rotToDeg(rot: number): number {
  if (!Number.isFinite(rot)) return 0
  return rot / 60000
}

export function rotToRad(rot: number): number {
  if (!Number.isFinite(rot)) return 0
  return (rotToDeg(rot) * Math.PI) / 180
}

export interface Viewport {
  widthPx: number
  heightPx: number
  scale: number
}

export function makeViewport(size: SlideSize, fitWidthPx: number): Viewport {
  const DEFAULT_CX_EMU = 9144000
  const DEFAULT_CY_EMU = 6858000
  const isPositiveFinite = (v: number): boolean => Number.isFinite(v) && v > 0
  const safeCx = isPositiveFinite(size.cx) ? size.cx : DEFAULT_CX_EMU
  const safeCy = isPositiveFinite(size.cy) ? size.cy : DEFAULT_CY_EMU
  const safeFitWidthPx = isPositiveFinite(fitWidthPx) ? fitWidthPx : safeCx / EMU_PER_PX_96
  const baseWidthPx = safeCx / EMU_PER_PX_96
  const scale = safeFitWidthPx / baseWidthPx
  return {
    widthPx: safeFitWidthPx,
    heightPx: (safeCy / EMU_PER_PX_96) * scale,
    scale,
  }
}

export interface PxRect {
  x: number
  y: number
  w: number
  h: number
}

export function rectToPx(r: EmuRect, vp: Viewport): PxRect {
  return {
    x: emuToPx(r.x, vp.scale),
    y: emuToPx(r.y, vp.scale),
    w: emuToPx(r.cx, vp.scale),
    h: emuToPx(r.cy, vp.scale),
  }
}

export interface PlacedBox extends PxRect {
  rotationDeg: number
  flipH: boolean
  flipV: boolean
  centerX: number
  centerY: number
}

export interface ParentPlacement {
  x: number
  y: number
  scaleX?: number
  scaleY?: number
}

export function placeTransform(
  t: Transform,
  vp: Viewport,
  parent: ParentPlacement = { x: 0, y: 0 },
): PlacedBox {
  const r = rectToPx(t.offset, vp)
  const sx = parent.scaleX ?? 1
  const sy = parent.scaleY ?? 1
  const deg = ((rotToDeg(t.rot) % 180) + 180) % 180
  const quarter = sx !== sy && Math.abs(deg - 90) < 0.5
  const w = r.w * (quarter ? sy : sx)
  const h = r.h * (quarter ? sx : sy)
  const x = (r.x + r.w / 2) * sx + parent.x - w / 2
  const y = (r.y + r.h / 2) * sy + parent.y - h / 2
  return {
    x,
    y,
    w,
    h,
    rotationDeg: rotToDeg(t.rot),
    flipH: t.flipH,
    flipV: t.flipV,
    centerX: x + w / 2,
    centerY: y + h / 2,
  }
}
