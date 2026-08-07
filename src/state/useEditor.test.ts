import { describe, expect, it } from 'vitest'
import { createInitialState, reducer } from './useEditor'
import { getSpec } from '@/core/specs'
import type { LoadedImage } from '@/lib/loadImage'

const US = getSpec('us-2x2')
const INTL = getSpec('intl-35x45')

/** A stand-in image: the reducer only ever reads width/height. */
const image = { bitmap: null, width: 1200, height: 1600, name: 'test.png' } as unknown as LoadedImage

const withImage = () => reducer(createInitialState(), { type: 'setImage', image })

describe('setImage', () => {
  it('seeds a placement and clears history', () => {
    const state = withImage()
    expect(state.doc.placement).not.toBeNull()
    expect(state.past).toHaveLength(0)
    expect(state.future).toHaveLength(0)
  })

  it('clearing the image drops the placement but keeps the chosen spec', () => {
    let state = reducer(withImage(), { type: 'setSpec', specId: 'intl-35x45' })
    state = reducer(state, { type: 'setImage', image: null })
    expect(state.doc.placement).toBeNull()
    expect(state.image).toBeNull()
    expect(state.doc.specId).toBe('intl-35x45')
  })
})

describe('gesture coalescing', () => {
  it('records ONE undo entry for a whole drag, not one per move', () => {
    let state = withImage()
    for (let i = 0; i < 50; i++) {
      state = reducer(state, { type: 'setLandmark', key: 'chin', x: 600, y: 900 + i })
    }
    expect(state.past).toHaveLength(0) // nothing committed mid-gesture
    state = reducer(state, { type: 'commit' })
    expect(state.past).toHaveLength(1)
  })

  it('undo after a committed drag restores the pre-drag position', () => {
    const start = withImage()
    const originalChin = start.doc.placement!.landmarks.chin
    let state = reducer(start, { type: 'setLandmark', key: 'chin', x: 777, y: 888 })
    state = reducer(state, { type: 'commit' })
    state = reducer(state, { type: 'undo' })
    expect(state.doc.placement!.landmarks.chin).toEqual(originalChin)
  })

  it('undo retires an UNcommitted gesture first', () => {
    // Releasing the mouse and hitting undo must undo the drag you just made,
    // not skip past it to something older.
    const start = withImage()
    const originalChin = start.doc.placement!.landmarks.chin
    let state = reducer(start, { type: 'setLandmark', key: 'chin', x: 111, y: 222 })
    state = reducer(state, { type: 'undo' })
    expect(state.doc.placement!.landmarks.chin).toEqual(originalChin)
    expect(state.gestureBase).toBeNull()
  })

  it('committing an empty gesture does not pollute the undo stack', () => {
    let state = withImage()
    state = reducer(state, { type: 'commit' })
    state = reducer(state, { type: 'commit' })
    expect(state.past).toHaveLength(0)
  })
})

describe('undo / redo', () => {
  it('round-trips a discrete change', () => {
    let state = withImage()
    state = reducer(state, { type: 'setSpec', specId: 'intl-35x45' })
    expect(state.doc.specId).toBe('intl-35x45')
    state = reducer(state, { type: 'undo' })
    expect(state.doc.specId).toBe('us-2x2')
    state = reducer(state, { type: 'redo' })
    expect(state.doc.specId).toBe('intl-35x45')
  })

  it('a new change clears the redo branch', () => {
    let state = withImage()
    state = reducer(state, { type: 'setSpec', specId: 'intl-35x45' })
    state = reducer(state, { type: 'undo' })
    expect(state.future).toHaveLength(1)
    state = reducer(state, { type: 'setPaper', paperId: 'a4' })
    expect(state.future).toHaveLength(0)
  })

  it('undo and redo are no-ops at the ends of history', () => {
    const state = withImage()
    expect(reducer(state, { type: 'undo' })).toBe(state)
    expect(reducer(state, { type: 'redo' })).toBe(state)
  })

  it('caps history growth', () => {
    let state = withImage()
    for (let i = 0; i < 200; i++) {
      state = reducer(state, { type: 'setPaper', paperId: i % 2 ? 'a4' : '4x6' })
    }
    expect(state.past.length).toBeLessThanOrEqual(60)
  })
})

describe('setSpec', () => {
  it('resets head and eye heights to the new spec, since the unit changed', () => {
    let state = withImage()
    // 1.19 inches would be a nonsensical 1.19 mm under the metric spec.
    expect(state.doc.placement!.headHeight).toBe(US.head.default)
    state = reducer(state, { type: 'setSpec', specId: 'intl-35x45' })
    expect(state.doc.placement!.headHeight).toBe(INTL.head.default)
    expect(state.doc.placement!.eyeHeight).toBe(INTL.eye.default)
  })

  it('keeps the landmarks, which are image coordinates and unit-independent', () => {
    const start = withImage()
    const before = start.doc.placement!.landmarks
    const state = reducer(start, { type: 'setSpec', specId: 'intl-35x45' })
    expect(state.doc.placement!.landmarks).toEqual(before)
  })

  it('selecting the already-current spec is a no-op', () => {
    const state = withImage()
    expect(reducer(state, { type: 'setSpec', specId: 'us-2x2' })).toBe(state)
  })
})

describe('clamping', () => {
  it('never lets a slider push a value outside the spec range', () => {
    let state = withImage()
    state = reducer(state, { type: 'setHeadHeight', value: 99 })
    expect(state.doc.placement!.headHeight).toBe(US.head.max)
    state = reducer(state, { type: 'setEyeHeight', value: -3 })
    expect(state.doc.placement!.eyeHeight).toBe(US.eye.min)
    state = reducer(state, { type: 'setRoll', value: 180 })
    expect(state.doc.placement!.rollAdjustDeg).toBe(15)
  })
})

describe('nudgeLandmark', () => {
  it('moves the named landmark by the delta and leaves the others alone', () => {
    const start = withImage()
    const before = start.doc.placement!.landmarks
    const state = reducer(start, { type: 'nudgeLandmark', key: 'eyes', dx: 3, dy: -4 })
    expect(state.doc.placement!.landmarks.eyes).toEqual({
      x: before.eyes.x + 3,
      y: before.eyes.y - 4,
    })
    expect(state.doc.placement!.landmarks.crown).toEqual(before.crown)
    expect(state.doc.placement!.landmarks.chin).toEqual(before.chin)
  })
})

describe('actions before an image is loaded', () => {
  it('are safely ignored rather than throwing', () => {
    const empty = createInitialState()
    expect(reducer(empty, { type: 'setHeadHeight', value: 1.2 })).toBe(empty)
    expect(reducer(empty, { type: 'nudgeLandmark', key: 'chin', dx: 1, dy: 1 })).toBe(empty)
  })
})
