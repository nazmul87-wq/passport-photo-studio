import { describe, expect, it } from 'vitest'
import {
  cellPosition,
  cutMarkEdges,
  DEFAULT_SHEET_OPTIONS,
  getPaper,
  planSheet,
  sheetFits,
} from './render'
import { getSpec, specPixelSize } from './specs'

const US = getSpec('us-2x2')
const UK = getSpec('intl-35x45')

describe('cutMarkEdges', () => {
  it('marks BOTH edges of every cell when there is a gutter', () => {
    // 4 cells of 413 with a 12 gutter starting at 56.
    expect(cutMarkEdges(56, 413, 4, 12)).toEqual([
      56, 469, // cell 0
      481, 894, // cell 1
      906, 1319, // cell 2
      1331, 1744, // cell 3
    ])
  })

  it('collapses coincident edges when there is no gutter', () => {
    // Leading edge of cell n+1 is the trailing edge of cell n.
    expect(cutMarkEdges(0, 600, 2, 0)).toEqual([0, 600, 1200])
  })

  it('produces a trailing edge exactly one cell past the last leading edge', () => {
    const edges = cutMarkEdges(10, 100, 3, 5)
    expect(edges[edges.length - 1]).toBe(10 + 2 * 105 + 100)
  })

  it('returns nothing for an empty grid', () => {
    expect(cutMarkEdges(0, 100, 0, 5)).toEqual([])
  })

  it('never places a mark inside a photo', () => {
    const [origin, cell, count, gutter] = [56, 413, 4, 12]
    const edges = cutMarkEdges(origin, cell, count, gutter)
    for (let i = 0; i < count; i++) {
      const left = origin + i * (cell + gutter)
      const right = left + cell
      for (const e of edges) {
        // A mark may sit ON an edge, never strictly between them.
        expect(e > left && e < right).toBe(false)
      }
    }
  })
})

describe('cut marks against a real layout', () => {
  it('a cut on the marks yields photos of exactly the spec width', () => {
    // The bug this guards: marking only each cell's leading edge left the
    // gutter attached, so every photo but the last came out a millimetre wide.
    const layout = planSheet(UK, getPaper('4x6'), DEFAULT_SHEET_OPTIONS)
    expect(layout.gutterPx).toBeGreaterThan(0)

    const edges = cutMarkEdges(
      layout.originX,
      layout.cellWidthPx,
      layout.cols,
      layout.gutterPx,
    )
    for (let i = 0; i < layout.cols; i++) {
      const left = layout.originX + i * (layout.cellWidthPx + layout.gutterPx)
      expect(edges).toContain(left)
      expect(edges).toContain(left + layout.cellWidthPx)
    }

    // Consecutive marks alternate photo-width, gutter-width.
    const widths = edges.slice(1).map((e, i) => e - edges[i]!)
    for (const w of widths) {
      expect([layout.cellWidthPx, layout.gutterPx]).toContain(w)
    }
  })
})

describe('layouts where the photo does not fit the paper', () => {
  const oversized = { ...US, id: 'oversized', photoW: 8, photoH: 10 }

  it('reports zero cells rather than a nonsensical grid', () => {
    const layout = planSheet(oversized, getPaper('4x6'), DEFAULT_SHEET_OPTIONS)
    expect(layout.count).toBe(0)
    expect(sheetFits(layout)).toBe(false)
  })

  it('cellPosition returns finite coordinates instead of NaN', () => {
    const layout = planSheet(oversized, getPaper('4x6'), DEFAULT_SHEET_OPTIONS)
    const pos = cellPosition(layout, 0)
    expect(Number.isFinite(pos.x)).toBe(true)
    expect(Number.isFinite(pos.y)).toBe(true)
  })

  it('still reports fits for a normal spec', () => {
    const layout = planSheet(US, getPaper('4x6'), DEFAULT_SHEET_OPTIONS)
    expect(sheetFits(layout)).toBe(true)
    expect(specPixelSize(US)).toEqual({ width: 600, height: 600 })
  })
})
