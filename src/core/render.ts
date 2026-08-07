/**
 * Rasterisation: the finished photo, and the printable sheet of copies.
 *
 * `planSheet` is pure arithmetic and unit-tested. The draw functions need a
 * canvas, so they touch the DOM — but only inside function bodies, which keeps
 * this module importable from a Node test environment.
 */

import { computeTransform, toCanvasMatrix, type Placement } from './geometry'
import { specPixelSize, type PhotoSpec } from './specs'
import { toPx } from './units'

export type ImageSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas

export interface PaperSize {
  id: string
  label: string
  /** Physical size in inches, always in portrait orientation. */
  widthIn: number
  heightIn: number
}

export const PAPER_SIZES: PaperSize[] = [
  { id: '4x6', label: '4×6 in photo paper', widthIn: 4, heightIn: 6 },
  { id: '5x7', label: '5×7 in photo paper', widthIn: 5, heightIn: 7 },
  { id: 'a6', label: 'A6 (105×148 mm)', widthIn: 105 / 25.4, heightIn: 148 / 25.4 },
  { id: 'letter', label: 'US Letter (8.5×11 in)', widthIn: 8.5, heightIn: 11 },
  { id: 'a4', label: 'A4 (210×297 mm)', widthIn: 210 / 25.4, heightIn: 297 / 25.4 },
]

export const DEFAULT_PAPER_ID = '4x6'

export function getPaper(id: string): PaperSize {
  const paper = PAPER_SIZES.find((p) => p.id === id)
  if (!paper) throw new Error(`Unknown paper size: ${id}`)
  return paper
}

export interface SheetOptions {
  /** Gap between photos, in inches. A small gutter makes cutting far easier. */
  gutterIn: number
  /** Blank border around the whole grid, in inches. */
  marginIn: number
  /** Draw thin crop marks in the margins to guide the scissors. */
  cutMarks: boolean
  /** Let the sheet rotate photos 90° if that fits more of them. */
  allowRotation: boolean
}

export const DEFAULT_SHEET_OPTIONS: SheetOptions = {
  gutterIn: 0.04,
  marginIn: 0.08,
  cutMarks: true,
  allowRotation: true,
}

export interface SheetLayout {
  paperWidthPx: number
  paperHeightPx: number
  cols: number
  rows: number
  count: number
  /** Photos are placed rotated 90° to fit more per sheet. */
  rotated: boolean
  /** Footprint of one placed photo, already accounting for rotation. */
  cellWidthPx: number
  cellHeightPx: number
  gutterPx: number
  /** Top-left of the grid, centred within the paper. */
  originX: number
  originY: number
}

interface Packing {
  cols: number
  rows: number
  count: number
  rotated: boolean
  cellWidthPx: number
  cellHeightPx: number
  paperW: number
  paperH: number
}

function pack(
  photoW: number,
  photoH: number,
  paperW: number,
  paperH: number,
  rotated: boolean,
): Packing {
  const w = rotated ? photoH : photoW
  const h = rotated ? photoW : photoH
  const cols = Math.max(0, Math.floor(paperW / w))
  const rows = Math.max(0, Math.floor(paperH / h))
  return {
    cols,
    rows,
    count: cols * rows,
    rotated,
    cellWidthPx: w,
    cellHeightPx: h,
    paperW,
    paperH,
  }
}

/**
 * Work out how many copies fit on the sheet and where they go.
 *
 * The reference implementation hardcodes 2×3 and 2×4 grids. Deriving the grid
 * instead means any spec on any paper fits correctly — and it finds the same 6
 * and 8 the hardcoded version produces.
 *
 * Copy count is maximised *first*, and the requested gutter and margin are then
 * taken out of whatever slack is left over, shrinking uniformly if there is not
 * enough. This ordering matters: a US 2×2 tiles exactly 2×3 on a 4×6 with no
 * room to spare, so honouring even a 1 mm margin ahead of the count would drop
 * the sheet from six photos to two. Getting six photos is the entire point;
 * a cutting gutter is a nicety that only applies when the format leaves room.
 */
export function planSheet(
  spec: PhotoSpec,
  paper: PaperSize,
  options: SheetOptions = DEFAULT_SHEET_OPTIONS,
): SheetLayout {
  const { width: photoW, height: photoH } = specPixelSize(spec)
  const dpi = spec.dpi

  const paperWidthPx = Math.round(paper.widthIn * dpi)
  const paperHeightPx = Math.round(paper.heightIn * dpi)
  const wantGutter = Math.round(options.gutterIn * dpi)
  const wantMargin = Math.round(options.marginIn * dpi)

  // Consider the paper in both orientations as well as the photo, since a 4×6
  // held landscape often fits a different number than held portrait.
  const candidates: Packing[] = []
  for (const [pw, ph] of [
    [paperWidthPx, paperHeightPx],
    [paperHeightPx, paperWidthPx],
  ] as const) {
    for (const rotated of options.allowRotation ? [false, true] : [false]) {
      candidates.push(pack(photoW, photoH, pw, ph, rotated))
    }
  }

  // Most photos wins; ties go to the unrotated layout, which prints upright and
  // is easier for the user to check against the preview. Array#sort is stable,
  // so a further tie keeps the paper in its natural portrait orientation.
  candidates.sort((a, b) => b.count - a.count || Number(a.rotated) - Number(b.rotated))
  const winner = candidates[0]!

  // Spend the leftover space on spacing, uniformly in both axes so the grid
  // does not end up with wide gutters one way and tight ones the other.
  const slackX = winner.paperW - winner.cols * winner.cellWidthPx
  const slackY = winner.paperH - winner.rows * winner.cellHeightPx
  const wantX = Math.max(0, winner.cols - 1) * wantGutter + 2 * wantMargin
  const wantY = Math.max(0, winner.rows - 1) * wantGutter + 2 * wantMargin
  const factor = Math.min(
    wantX > 0 ? slackX / wantX : 1,
    wantY > 0 ? slackY / wantY : 1,
    1,
  )
  const gutterPx = Math.max(0, Math.floor(wantGutter * factor))

  const gridW = winner.cols * winner.cellWidthPx + Math.max(0, winner.cols - 1) * gutterPx
  const gridH = winner.rows * winner.cellHeightPx + Math.max(0, winner.rows - 1) * gutterPx

  return {
    paperWidthPx: winner.paperW,
    paperHeightPx: winner.paperH,
    cols: winner.cols,
    rows: winner.rows,
    count: winner.count,
    rotated: winner.rotated,
    cellWidthPx: winner.cellWidthPx,
    cellHeightPx: winner.cellHeightPx,
    gutterPx,
    originX: Math.max(0, Math.floor((winner.paperW - gridW) / 2)),
    originY: Math.max(0, Math.floor((winner.paperH - gridH) / 2)),
  }
}

/**
 * Top-left corner of cell `index`, in sheet pixels.
 *
 * `planSheet` legitimately returns `cols: 0` when the photo is larger than the
 * paper, and `index % 0` is NaN. Returning the origin keeps a caller that does
 * not check `count` from silently drawing at NaN coordinates.
 */
export function cellPosition(layout: SheetLayout, index: number): { x: number; y: number } {
  if (layout.cols <= 0 || layout.rows <= 0) {
    return { x: layout.originX, y: layout.originY }
  }
  const col = index % layout.cols
  const row = Math.floor(index / layout.cols)
  return {
    x: layout.originX + col * (layout.cellWidthPx + layout.gutterPx),
    y: layout.originY + row * (layout.cellHeightPx + layout.gutterPx),
  }
}

/** True when the photo simply does not fit the chosen paper. */
export function sheetFits(layout: SheetLayout): boolean {
  return layout.count > 0
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d', { alpha: false })
  if (!ctx) throw new Error('Could not acquire a 2D canvas context')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  return ctx
}

/**
 * Render the finished photo at full spec resolution.
 *
 * The entire crop — translate, rotate, scale — is one setTransform call, so the
 * browser resamples in one pass instead of us walking pixels.
 */
export function renderPhoto(
  spec: PhotoSpec,
  source: ImageSource,
  placement: Placement,
  target?: HTMLCanvasElement,
): HTMLCanvasElement {
  const { width, height } = specPixelSize(spec)
  const canvas = target ?? createCanvas(width, height)
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  const ctx = context2d(canvas)
  // Fill first: if the crop overhangs the source, the uncovered area must read
  // as background rather than black, so the preview matches what prints.
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.fillStyle = spec.background.color
  ctx.fillRect(0, 0, width, height)

  const t = computeTransform(spec, placement)
  ctx.setTransform(...toCanvasMatrix(t))
  ctx.drawImage(source as CanvasImageSource, 0, 0)
  ctx.setTransform(1, 0, 0, 1, 0, 0)

  return canvas
}

/** Tile a rendered photo across the sheet, optionally with cut marks. */
export function renderSheet(
  spec: PhotoSpec,
  photo: HTMLCanvasElement,
  paper: PaperSize,
  options: SheetOptions = DEFAULT_SHEET_OPTIONS,
): { canvas: HTMLCanvasElement; layout: SheetLayout } {
  const layout = planSheet(spec, paper, options)
  const canvas = createCanvas(layout.paperWidthPx, layout.paperHeightPx)
  const ctx = context2d(canvas)

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, layout.paperWidthPx, layout.paperHeightPx)

  for (let i = 0; i < layout.count; i++) {
    const { x, y } = cellPosition(layout, i)
    ctx.save()
    if (layout.rotated) {
      // Rotate about the cell's top-left, then shift so the photo lands inside.
      ctx.translate(x + layout.cellWidthPx, y)
      ctx.rotate(Math.PI / 2)
    } else {
      ctx.translate(x, y)
    }
    ctx.drawImage(photo, 0, 0)
    ctx.restore()
  }

  if (options.cutMarks) drawCutMarks(ctx, layout)

  return { canvas, layout }
}

/**
 * The cut lines for one axis: BOTH edges of every cell, deduplicated.
 *
 * The obvious implementation — one mark per cell plus a final trailing one —
 * marks each cell's leading edge only. With a gutter that is silently wrong:
 * cutting on those marks leaves the gutter attached, so a 35 mm photo comes off
 * the sheet 35 + gutter wide. At the default 12 px gutter that is a full
 * millimetre of overhang on every photo but the last, which is exactly what a
 * template gauge at a passport office measures.
 *
 * With a zero gutter the two edges coincide and the dedupe collapses them.
 */
export function cutMarkEdges(
  origin: number,
  cellSize: number,
  count: number,
  gutter: number,
): number[] {
  const edges = new Set<number>()
  for (let i = 0; i < count; i++) {
    const leading = origin + i * (cellSize + gutter)
    edges.add(leading)
    edges.add(leading + cellSize)
  }
  return [...edges].sort((a, b) => a - b)
}

/**
 * Crop marks sit in the margin and gutters, never on the photo itself — an
 * authority will reject a print with ink over the image area.
 */
function drawCutMarks(ctx: CanvasRenderingContext2D, layout: SheetLayout): void {
  if (!sheetFits(layout)) return
  const tick = Math.max(6, Math.round(layout.gutterPx * 1.5))
  ctx.save()
  ctx.strokeStyle = 'rgba(0,0,0,0.45)'
  ctx.lineWidth = 1

  const xEdges = cutMarkEdges(layout.originX, layout.cellWidthPx, layout.cols, layout.gutterPx)
  const yEdges = cutMarkEdges(layout.originY, layout.cellHeightPx, layout.rows, layout.gutterPx)

  const gridTop = layout.originY
  const gridBottom = yEdges[yEdges.length - 1]!
  const gridLeft = layout.originX
  const gridRight = xEdges[xEdges.length - 1]!

  for (const x of xEdges) {
    ctx.beginPath()
    ctx.moveTo(x + 0.5, Math.max(0, gridTop - tick))
    ctx.lineTo(x + 0.5, gridTop)
    ctx.moveTo(x + 0.5, gridBottom)
    ctx.lineTo(x + 0.5, Math.min(layout.paperHeightPx, gridBottom + tick))
    ctx.stroke()
  }
  for (const y of yEdges) {
    ctx.beginPath()
    ctx.moveTo(Math.max(0, gridLeft - tick), y + 0.5)
    ctx.lineTo(gridLeft, y + 0.5)
    ctx.moveTo(gridRight, y + 0.5)
    ctx.lineTo(Math.min(layout.paperWidthPx, gridRight + tick), y + 0.5)
    ctx.stroke()
  }

  ctx.restore()
}

/** Physical size of a sheet, for the "prints at" readout. */
export function sheetPhysicalSize(layout: SheetLayout, dpi: number): { widthIn: number; heightIn: number } {
  return { widthIn: layout.paperWidthPx / dpi, heightIn: layout.paperHeightPx / dpi }
}

/** Convert an inch measurement to pixels at a spec's DPI. */
export function inchesToSpecPx(inches: number, spec: PhotoSpec): number {
  return toPx(inches, 'in', spec.dpi)
}
