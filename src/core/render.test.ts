import { describe, expect, it } from 'vitest'
import {
  cellPosition,
  DEFAULT_SHEET_OPTIONS,
  getPaper,
  PAPER_SIZES,
  planSheet,
  type SheetOptions,
} from './render'
import { getSpec, specPixelSize } from './specs'

const US = getSpec('us-2x2')
const INTL = getSpec('intl-35x45')
const FOUR_BY_SIX = getPaper('4x6')

/** Zero gutter and margin — the edge-to-edge layout the reference produces. */
const TIGHT: SheetOptions = {
  gutterIn: 0,
  marginIn: 0,
  cutMarks: false,
  allowRotation: true,
}

describe('planSheet', () => {
  it('matches the reference layout for US 2×2 on 4×6 with no gutter', () => {
    const layout = planSheet(US, FOUR_BY_SIX, TIGHT)
    expect(layout.count).toBe(6)
    expect(layout.cols * layout.rows).toBe(6)
    expect(layout.cellWidthPx).toBe(600)
    expect(layout.cellHeightPx).toBe(600)
  })

  it('matches the reference layout for 35×45mm on 4×6 with no gutter', () => {
    const layout = planSheet(INTL, FOUR_BY_SIX, TIGHT)
    expect(layout.count).toBe(8)
  })

  it('still fits 6 US photos on 4×6 with the default gutter and margin', () => {
    // A 2×2 tiles a 4×6 exactly, so honouring the requested spacing ahead of
    // the copy count would drop this from six photos to two.
    const layout = planSheet(US, FOUR_BY_SIX, DEFAULT_SHEET_OPTIONS)
    expect(layout.count).toBe(6)
    expect(layout.gutterPx).toBe(0)
  })

  it('spends leftover slack on gutters when the format leaves room', () => {
    const layout = planSheet(INTL, FOUR_BY_SIX, DEFAULT_SHEET_OPTIONS)
    expect(layout.count).toBe(8)
    expect(layout.gutterPx).toBeGreaterThan(0)
  })

  it('never trades copies away for spacing on any spec/paper combination', () => {
    for (const spec of [US, INTL]) {
      for (const paper of PAPER_SIZES) {
        const spaced = planSheet(spec, paper, DEFAULT_SHEET_OPTIONS)
        const tight = planSheet(spec, paper, TIGHT)
        expect(spaced.count).toBe(tight.count)
      }
    }
  })

  it('keeps the whole grid inside the paper', () => {
    for (const spec of [US, INTL]) {
      for (const paper of PAPER_SIZES) {
        const layout = planSheet(spec, paper, DEFAULT_SHEET_OPTIONS)
        const last = cellPosition(layout, layout.count - 1)
        expect(layout.originX).toBeGreaterThanOrEqual(0)
        expect(layout.originY).toBeGreaterThanOrEqual(0)
        expect(last.x + layout.cellWidthPx).toBeLessThanOrEqual(layout.paperWidthPx + 1)
        expect(last.y + layout.cellHeightPx).toBeLessThanOrEqual(layout.paperHeightPx + 1)
      }
    }
  })

  it('never overlaps two cells', () => {
    const layout = planSheet(INTL, getPaper('a4'), DEFAULT_SHEET_OPTIONS)
    const boxes = Array.from({ length: layout.count }, (_, i) => cellPosition(layout, i))
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i]!
        const b = boxes[j]!
        const overlapX =
          a.x < b.x + layout.cellWidthPx && b.x < a.x + layout.cellWidthPx
        const overlapY =
          a.y < b.y + layout.cellHeightPx && b.y < a.y + layout.cellHeightPx
        expect(overlapX && overlapY).toBe(false)
      }
    }
  })

  it('swaps the cell footprint when it chooses a rotated layout', () => {
    const layout = planSheet(INTL, FOUR_BY_SIX, TIGHT)
    const { width, height } = specPixelSize(INTL)
    if (layout.rotated) {
      expect(layout.cellWidthPx).toBe(height)
      expect(layout.cellHeightPx).toBe(width)
    } else {
      expect(layout.cellWidthPx).toBe(width)
      expect(layout.cellHeightPx).toBe(height)
    }
  })

  it('fits many more copies on larger paper', () => {
    const small = planSheet(US, FOUR_BY_SIX, DEFAULT_SHEET_OPTIONS).count
    const large = planSheet(US, getPaper('letter'), DEFAULT_SHEET_OPTIONS).count
    expect(large).toBeGreaterThan(small)
  })

  it('honours allowRotation: false', () => {
    const layout = planSheet(INTL, FOUR_BY_SIX, { ...TIGHT, allowRotation: false })
    expect(layout.rotated).toBe(false)
  })

  it('rejects an unknown paper id', () => {
    expect(() => getPaper('nope')).toThrow(/Unknown paper size/)
  })
})

describe('cellPosition', () => {
  it('walks left-to-right then top-to-bottom', () => {
    const layout = planSheet(US, FOUR_BY_SIX, TIGHT)
    const first = cellPosition(layout, 0)
    const second = cellPosition(layout, 1)
    const nextRow = cellPosition(layout, layout.cols)
    expect(second.x).toBeGreaterThan(first.x)
    expect(second.y).toBe(first.y)
    expect(nextRow.y).toBeGreaterThan(first.y)
    expect(nextRow.x).toBe(first.x)
  })
})
