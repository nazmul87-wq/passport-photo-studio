/**
 * Tests for the pure half of detect.ts.
 *
 * MediaPipe cannot run under vitest, so `detectFace` itself is not exercised
 * here. Everything it *decides* — how mesh indices map to the three landmarks
 * the crop needs, how roll is measured, and above all how the crown is found by
 * walking the segmentation mask — is a pure function over plain arrays, and
 * that is what is tested.
 */

import { describe, expect, it } from 'vitest'
import {
  CROWN_EXTRAPOLATION,
  FACE_LANDMARK,
  REFINED_LANDMARK_COUNT,
  crownFromMask,
  extrapolateCrown,
  mapFaceAnchors,
  rollDegFromEyes,
  scoreDetection,
  toLandmarks,
  type FaceAnchors,
} from './detect'
import type { Point } from './geometry'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A mesh of the requested length, with the interesting indices filled in. */
function mesh(
  length: number,
  overrides: Record<number, { x: number; y: number }>,
): Array<{ x: number; y: number }> {
  const points = Array.from({ length }, () => ({ x: 0.5, y: 0.5 }))
  for (const [index, point] of Object.entries(overrides)) {
    points[Number(index)] = point
  }
  return points
}

/**
 * A mask containing one upright rectangular "head".
 * Coordinates are inclusive of `left`/`top`, exclusive of `right`/`bottom`.
 */
function rectMask(
  width: number,
  height: number,
  left: number,
  top: number,
  right: number,
  bottom: number,
): Float32Array {
  const mask = new Float32Array(width * height)
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) mask[y * width + x] = 1
  }
  return mask
}

/** Rotate a point about `about` by `deg`, clockwise in screen coordinates. */
function rotateAbout(p: Point, about: Point, deg: number): Point {
  const a = (deg * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dx = p.x - about.x
  const dy = p.y - about.y
  return { x: about.x + dx * c - dy * s, y: about.y + dx * s + dy * c }
}

// ---------------------------------------------------------------------------

describe('mapFaceAnchors', () => {
  const points = mesh(REFINED_LANDMARK_COUNT, {
    [FACE_LANDMARK.chin]: { x: 0.5, y: 0.8 },
    [FACE_LANDMARK.foreheadTop]: { x: 0.5, y: 0.3 },
    [FACE_LANDMARK.irisA]: { x: 0.6, y: 0.5 },
    [FACE_LANDMARK.irisB]: { x: 0.4, y: 0.5 },
  })

  it('converts normalised coordinates into source-image pixels', () => {
    const anchors = mapFaceAnchors(points, 1000, 2000)!
    expect(anchors.chin).toEqual({ x: 500, y: 1600 })
    expect(anchors.foreheadTop).toEqual({ x: 500, y: 600 })
  })

  it('puts the eyes at the midpoint of the two iris centres', () => {
    const anchors = mapFaceAnchors(points, 1000, 1000)!
    expect(anchors.eyes.x).toBeCloseTo(500, 6)
    expect(anchors.eyes.y).toBeCloseTo(500, 6)
    expect(anchors.irisRefined).toBe(true)
  })

  it('orders the eyes left-to-right in image space, whatever the mesh order', () => {
    const anchors = mapFaceAnchors(points, 1000, 1000)!
    expect(anchors.eyeLeft.x).toBeLessThan(anchors.eyeRight.x)
    expect(anchors.eyeLeft.x).toBeCloseTo(400, 6)
    expect(anchors.eyeRight.x).toBeCloseTo(600, 6)
  })

  it('falls back to eye corners on an unrefined 468-point mesh', () => {
    const unrefined = mesh(468, {
      [FACE_LANDMARK.chin]: { x: 0.5, y: 0.8 },
      [FACE_LANDMARK.foreheadTop]: { x: 0.5, y: 0.3 },
      [FACE_LANDMARK.eyeOuterA]: { x: 0.35, y: 0.52 },
      [FACE_LANDMARK.eyeOuterB]: { x: 0.65, y: 0.48 },
    })
    const anchors = mapFaceAnchors(unrefined, 1000, 1000)!
    expect(anchors.irisRefined).toBe(false)
    expect(anchors.eyeLeft.x).toBeCloseTo(350, 6)
    expect(anchors.eyes.y).toBeCloseTo(500, 6)
  })

  it('returns null for a mesh too short to contain the anchors', () => {
    expect(mapFaceAnchors([{ x: 0.5, y: 0.5 }], 100, 100)).toBeNull()
    expect(mapFaceAnchors([], 100, 100)).toBeNull()
  })

  it('returns null when a landmark is not finite', () => {
    const broken = mesh(REFINED_LANDMARK_COUNT, {
      [FACE_LANDMARK.chin]: { x: Number.NaN, y: 0.8 },
    })
    expect(mapFaceAnchors(broken, 100, 100)).toBeNull()
  })
})

describe('rollDegFromEyes', () => {
  it('is zero for a level eye line', () => {
    expect(rollDegFromEyes({ x: 100, y: 200 }, { x: 300, y: 200 })).toBeCloseTo(0, 9)
  })

  it('is positive when the head is tilted clockwise on screen', () => {
    expect(rollDegFromEyes({ x: 100, y: 100 }, { x: 200, y: 200 })).toBeCloseTo(45, 9)
    expect(rollDegFromEyes({ x: 100, y: 200 }, { x: 200, y: 100 })).toBeCloseTo(-45, 9)
  })

  it('does not depend on the order the eyes are passed in', () => {
    const a = { x: 120, y: 340 }
    const b = { x: 260, y: 300 }
    expect(rollDegFromEyes(a, b)).toBeCloseTo(rollDegFromEyes(b, a), 9)
  })

  it('recovers the angle a head was rotated by', () => {
    const centre = { x: 500, y: 500 }
    for (const deg of [-12, -3, 0, 7, 20]) {
      const left = rotateAbout({ x: 450, y: 500 }, centre, deg)
      const right = rotateAbout({ x: 550, y: 500 }, centre, deg)
      expect(rollDegFromEyes(left, right)).toBeCloseTo(deg, 6)
    }
  })
})

describe('extrapolateCrown', () => {
  it('extends the chin-to-forehead vector by the anthropometric ratio', () => {
    const crown = extrapolateCrown({ x: 0, y: 100 }, { x: 0, y: 40 })
    expect(crown.x).toBeCloseTo(0, 9)
    expect(crown.y).toBeCloseTo(100 - 60 * CROWN_EXTRAPOLATION, 9)
  })

  it('follows a tilted head axis rather than pointing straight up', () => {
    const crown = extrapolateCrown({ x: 100, y: 100 }, { x: 130, y: 60 }, 2)
    expect(crown).toEqual({ x: 160, y: 20 })
  })
})

describe('crownFromMask', () => {
  const W = 100
  const H = 100

  it('finds the top of the subject above the forehead landmark', () => {
    // Head occupies x 35..64, y 10..89. Landmark 10 sits at y = 30.
    const mask = rectMask(W, H, 35, 10, 65, 90)
    const walk = crownFromMask(mask, W, H, { x: 50, y: 85 }, { x: 50, y: 30 })!
    expect(walk.crown.x).toBeCloseTo(50, 6)
    expect(walk.crown.y).toBeCloseTo(10, 0)
    expect(walk.clipped).toBe(false)
    expect(walk.travelPx).toBeCloseTo(20, 0)
  })

  it('beats a fixed ratio when the subject has hair volume', () => {
    // Same face, but the hair reaches much higher than a 1.2x extrapolation.
    const mask = rectMask(W, H, 35, 2, 65, 90)
    const chin = { x: 50, y: 85 }
    const forehead = { x: 50, y: 30 }
    const walk = crownFromMask(mask, W, H, chin, forehead)!
    const guess = extrapolateCrown(chin, forehead)
    expect(walk.crown.y).toBeLessThan(guess.y)
    expect(walk.crown.y).toBeCloseTo(2, 0)
  })

  it('reports clipped when the head runs off the top of the frame', () => {
    const mask = rectMask(W, H, 35, 0, 65, 90)
    const walk = crownFromMask(mask, W, H, { x: 50, y: 85 }, { x: 50, y: 30 })!
    expect(walk.crown.y).toBeCloseTo(0, 0)
    expect(walk.clipped).toBe(true)
  })

  it('reports clipped when the search range runs out first', () => {
    // Everything is subject, so the walk can only stop at maxTravel.
    const mask = rectMask(W, H, 0, 0, W, H)
    const chin = { x: 50, y: 95 }
    const forehead = { x: 50, y: 60 }
    const walk = crownFromMask(mask, W, H, chin, forehead)!
    expect(walk.clipped).toBe(true)
    // maxTravelRatio 0.9 of a 35 px face.
    expect(walk.travelPx).toBeCloseTo(31, 0)
  })

  it('follows the head axis on a tilted head', () => {
    const centre = { x: 50, y: 50 }
    const deg = 20
    const mask = new Float32Array(W * H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        // Inverse-rotate into head-local space and test the upright rectangle.
        const local = rotateAbout({ x, y }, centre, -deg)
        if (local.x >= 35 && local.x < 65 && local.y >= 10 && local.y < 90) {
          mask[y * W + x] = 1
        }
      }
    }
    const chin = rotateAbout({ x: 50, y: 85 }, centre, deg)
    const forehead = rotateAbout({ x: 50, y: 30 }, centre, deg)
    const expected = rotateAbout({ x: 50, y: 10 }, centre, deg)

    const walk = crownFromMask(mask, W, H, chin, forehead)!
    expect(walk.crown.x).toBeCloseTo(expected.x, 0)
    expect(walk.crown.y).toBeCloseTo(expected.y, 0)
    expect(walk.clipped).toBe(false)
  })

  it('tolerates a small hole punched through thin hair', () => {
    const mask = rectMask(W, H, 35, 10, 65, 90)
    // Two blank rows partway up: exactly the artefact a segmenter leaves in
    // wispy hair, and a naive first-miss-wins walk would stop here.
    for (let x = 0; x < W; x++) {
      mask[18 * W + x] = 0
      mask[19 * W + x] = 0
    }
    const walk = crownFromMask(mask, W, H, { x: 50, y: 85 }, { x: 50, y: 30 })!
    expect(walk.crown.y).toBeCloseTo(10, 0)
  })

  it('returns null when the mask does not cover the face at all', () => {
    const empty = new Float32Array(W * H)
    expect(crownFromMask(empty, W, H, { x: 50, y: 85 }, { x: 50, y: 30 })).toBeNull()
  })

  it('returns null when the mask stops at the forehead, rather than trusting it', () => {
    // Subject ends 1 px above landmark 10 — physically impossible for a head,
    // so this is a bad mask and the caller should fall back to extrapolation.
    const mask = rectMask(W, H, 35, 29, 65, 90)
    expect(crownFromMask(mask, W, H, { x: 50, y: 85 }, { x: 50, y: 30 })).toBeNull()
  })

  it('returns null for a degenerate face axis', () => {
    const mask = rectMask(W, H, 35, 10, 65, 90)
    expect(crownFromMask(mask, W, H, { x: 50, y: 30 }, { x: 50, y: 30 })).toBeNull()
  })

  it('honours a caller-supplied threshold on a soft mask', () => {
    // Confidence tapers off above y = 20 instead of ending abruptly.
    const mask = new Float32Array(W * H)
    for (let y = 10; y < 90; y++) {
      for (let x = 35; x < 65; x++) mask[y * W + x] = y < 20 ? 0.3 : 1
    }
    const strict = crownFromMask(mask, W, H, { x: 50, y: 85 }, { x: 50, y: 30 })!
    const loose = crownFromMask(mask, W, H, { x: 50, y: 85 }, { x: 50, y: 30 }, { threshold: 0.2 })!
    expect(strict.crown.y).toBeCloseTo(20, 0)
    expect(loose.crown.y).toBeCloseTo(10, 0)
  })
})

describe('scoreDetection', () => {
  function anchors(over: Partial<FaceAnchors> = {}): FaceAnchors {
    const eyeLeft = { x: 433, y: 500 }
    const eyeRight = { x: 568, y: 500 }
    return {
      chin: { x: 500, y: 650 },
      foreheadTop: { x: 500, y: 350 },
      eyeLeft,
      eyeRight,
      eyes: { x: 500, y: 500 },
      irisRefined: true,
      ...over,
    }
  }

  it('scores a large, frontal, fully-visible face near 1', () => {
    expect(scoreDetection(anchors(), 1000, 1000)).toBeGreaterThan(0.95)
  })

  it('penalises a face too small to print from', () => {
    const tiny = anchors({ chin: { x: 500, y: 515 }, foreheadTop: { x: 500, y: 485 } })
    expect(scoreDetection(tiny, 1000, 1000)).toBeLessThan(scoreDetection(anchors(), 1000, 1000))
  })

  it('penalises a turned head, whose eyes crowd together', () => {
    const turned = anchors({ eyeLeft: { x: 480, y: 500 }, eyeRight: { x: 520, y: 500 } })
    expect(scoreDetection(turned, 1000, 1000)).toBeLessThan(scoreDetection(anchors(), 1000, 1000))
  })

  it('penalises anchors that fall outside the frame', () => {
    const cropped = anchors({ foreheadTop: { x: 500, y: -50 }, chin: { x: 500, y: 250 } })
    expect(scoreDetection(cropped, 1000, 1000)).toBeLessThan(scoreDetection(anchors(), 1000, 1000))
  })

  it('returns 0 for a degenerate face', () => {
    const flat = anchors({ chin: { x: 500, y: 500 }, foreheadTop: { x: 500, y: 500 } })
    expect(scoreDetection(flat, 1000, 1000)).toBe(0)
  })

  it('always reports a value in 0-1', () => {
    for (const size of [10, 200, 4000]) {
      const score = scoreDetection(anchors(), size, size)
      expect(score).toBeGreaterThanOrEqual(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })
})

describe('toLandmarks', () => {
  it('assembles the three points the geometry engine consumes', () => {
    const a: FaceAnchors = {
      chin: { x: 1, y: 2 },
      foreheadTop: { x: 3, y: 4 },
      eyeLeft: { x: 5, y: 6 },
      eyeRight: { x: 7, y: 8 },
      eyes: { x: 6, y: 7 },
      irisRefined: true,
    }
    expect(toLandmarks(a, { x: 9, y: 10 })).toEqual({
      crown: { x: 9, y: 10 },
      chin: { x: 1, y: 2 },
      eyes: { x: 6, y: 7 },
    })
  })
})
