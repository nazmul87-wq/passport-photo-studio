import { describe, expect, it } from 'vitest'
import {
  clampPlacement,
  computeTransform,
  cropCornersInImageSpace,
  cropOverflow,
  defaultPlacement,
  headTiltDeg,
  imgToOut,
  outToImg,
  solveForHeadroom,
  toCanvasMatrix,
  type Landmarks,
  type Placement,
} from './geometry'
import { getSpec, specPixelSize } from './specs'
import { degToRad } from './units'

const US = getSpec('us-2x2')
const INTL = getSpec('intl-35x45')
/** Headroom fixture: Japan is one of the few authorities publishing a crown margin. */
const JP = getSpec('jp-35x45')

/** An upright head: crown directly above chin, eyes 45% of the way down. */
function uprightHead(cx = 500, crownY = 200, headLen = 400): Landmarks {
  return {
    crown: { x: cx, y: crownY },
    chin: { x: cx, y: crownY + headLen },
    eyes: { x: cx, y: crownY + headLen * 0.45 },
  }
}

function placement(landmarks: Landmarks, over: Partial<Placement> = {}): Placement {
  return {
    landmarks,
    headHeight: US.head.default,
    eyeHeight: US.eye.default,
    rollAdjustDeg: 0,
    ...over,
  }
}

describe('spec pixel dimensions', () => {
  it('derives the reference implementation\'s exact output sizes', () => {
    expect(specPixelSize(US)).toEqual({ width: 600, height: 600 })
    expect(specPixelSize(INTL)).toEqual({ width: 413, height: 531 })
  })
})

describe('headAxisAngle', () => {
  it('reports zero tilt for a vertical head', () => {
    expect(headTiltDeg(uprightHead())).toBeCloseTo(0, 10)
  })

  it('measures tilt independently of head size', () => {
    const small: Landmarks = {
      crown: { x: 100, y: 100 },
      chin: { x: 100 + 50 * Math.sin(degToRad(10)), y: 100 + 50 * Math.cos(degToRad(10)) },
      eyes: { x: 100, y: 120 },
    }
    const large: Landmarks = {
      crown: { x: 100, y: 100 },
      chin: { x: 100 + 900 * Math.sin(degToRad(10)), y: 100 + 900 * Math.cos(degToRad(10)) },
      eyes: { x: 100, y: 400 },
    }
    expect(headTiltDeg(small)).toBeCloseTo(10, 6)
    expect(headTiltDeg(large)).toBeCloseTo(10, 6)
  })
})

describe('computeTransform', () => {
  it('places the pupil line at the required height above the bottom edge', () => {
    const t = computeTransform(US, placement(uprightHead()))
    const eyesOut = imgToOut(uprightHead().eyes, t)
    // 1.25in from the bottom of a 600px (2in) photo => y = 600 - 375 = 225
    expect(eyesOut.y).toBeCloseTo(225, 9)
    expect(eyesOut.x).toBeCloseTo(300, 9)
  })

  it('renders the head at exactly the requested physical height', () => {
    const lm = uprightHead()
    const t = computeTransform(US, placement(lm))
    const crownOut = imgToOut(lm.crown, t)
    const chinOut = imgToOut(lm.chin, t)
    // 1.19in at 300dpi = 357px
    expect(Math.hypot(chinOut.x - crownOut.x, chinOut.y - crownOut.y)).toBeCloseTo(357, 6)
  })

  it('stands a tilted head upright', () => {
    const angle = degToRad(9)
    const headLen = 400
    const lm: Landmarks = {
      crown: { x: 500, y: 200 },
      chin: {
        x: 500 + headLen * Math.sin(angle),
        y: 200 + headLen * Math.cos(angle),
      },
      eyes: { x: 500 + 180 * Math.sin(angle), y: 200 + 180 * Math.cos(angle) },
    }
    const t = computeTransform(INTL, {
      landmarks: lm,
      headHeight: INTL.head.default,
      eyeHeight: INTL.eye.default,
      rollAdjustDeg: 0,
    })
    const crownOut = imgToOut(lm.crown, t)
    const chinOut = imgToOut(lm.chin, t)
    // After correction the head axis must be vertical.
    expect(chinOut.x - crownOut.x).toBeCloseTo(0, 6)
    expect(chinOut.y).toBeGreaterThan(crownOut.y)
  })

  it('applies the manual levelling offset on top of the automatic correction', () => {
    const lm = uprightHead()
    const t = computeTransform(US, placement(lm, { rollAdjustDeg: 5 }))
    const crownOut = imgToOut(lm.crown, t)
    const chinOut = imgToOut(lm.chin, t)
    const tilt = Math.atan2(chinOut.x - crownOut.x, chinOut.y - crownOut.y)
    expect((tilt * 180) / Math.PI).toBeCloseTo(-5, 6)
  })

  it('reports effective DPI below the spec DPI when upscaling', () => {
    // A tiny head must be enlarged to fill the frame, costing real resolution.
    const t = computeTransform(US, placement(uprightHead(500, 200, 100)))
    expect(t.scale).toBeGreaterThan(1)
    expect(t.effectiveDpi).toBeLessThan(US.dpi)
    expect(t.effectiveDpi).toBeCloseTo(US.dpi / t.scale, 9)
  })

  it('measures the eye ratio along the head axis, not vertically', () => {
    const angle = degToRad(20)
    const headLen = 400
    const lm: Landmarks = {
      crown: { x: 500, y: 200 },
      chin: { x: 500 + headLen * Math.sin(angle), y: 200 + headLen * Math.cos(angle) },
      eyes: {
        x: 500 + headLen * 0.45 * Math.sin(angle),
        y: 200 + headLen * 0.45 * Math.cos(angle),
      },
    }
    const t = computeTransform(US, placement(lm))
    expect(t.eyeRatio).toBeCloseTo(0.45, 9)
  })
})

describe('imgToOut / outToImg', () => {
  it('round-trips exactly across randomised placements', () => {
    let seed = 20260807
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }

    for (let i = 0; i < 500; i++) {
      const headLen = 60 + rand() * 900
      const angle = (rand() - 0.5) * degToRad(50)
      const crown = { x: rand() * 2000, y: rand() * 2000 }
      const lm: Landmarks = {
        crown,
        chin: {
          x: crown.x + headLen * Math.sin(angle),
          y: crown.y + headLen * Math.cos(angle),
        },
        eyes: {
          x: crown.x + headLen * 0.45 * Math.sin(angle) + (rand() - 0.5) * 4,
          y: crown.y + headLen * 0.45 * Math.cos(angle),
        },
      }
      const spec = rand() > 0.5 ? US : INTL
      const t = computeTransform(spec, {
        landmarks: lm,
        headHeight: spec.head.default,
        eyeHeight: spec.eye.default,
        rollAdjustDeg: (rand() - 0.5) * 20,
      })

      const p = { x: rand() * 2000, y: rand() * 2000 }
      const back = outToImg(imgToOut(p, t), t)
      expect(back.x).toBeCloseTo(p.x, 6)
      expect(back.y).toBeCloseTo(p.y, 6)
    }
  })
})

describe('toCanvasMatrix', () => {
  it('agrees with imgToOut for arbitrary points', () => {
    const t = computeTransform(INTL, {
      landmarks: uprightHead(320, 90, 260),
      headHeight: INTL.head.default,
      eyeHeight: INTL.eye.default,
      rollAdjustDeg: -4,
    })
    const [a, b, c, d, e, f] = toCanvasMatrix(t)
    for (const p of [
      { x: 0, y: 0 },
      { x: 640, y: 480 },
      { x: -120, y: 75 },
    ]) {
      const viaMatrix = { x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f }
      const viaFn = imgToOut(p, t)
      expect(viaMatrix.x).toBeCloseTo(viaFn.x, 6)
      expect(viaMatrix.y).toBeCloseTo(viaFn.y, 6)
    }
  })
})

describe('cropOverflow', () => {
  it('reports no overflow when the source comfortably covers the crop', () => {
    const t = computeTransform(US, placement(uprightHead(1000, 400, 700)))
    expect(cropOverflow(t, 2000, 2600).any).toBe(false)
  })

  it('detects a crop that reaches past the top of the source', () => {
    // Crown very close to the top edge leaves no room for the headroom band.
    const t = computeTransform(US, placement(uprightHead(500, 5, 400)))
    const overflow = cropOverflow(t, 1000, 1400)
    expect(overflow.any).toBe(true)
    expect(overflow.top).toBeGreaterThan(0)
  })

  it('returns four corners that bound the mapped output rectangle', () => {
    const t = computeTransform(US, placement(uprightHead()))
    const corners = cropCornersInImageSpace(t)
    expect(corners).toHaveLength(4)
    for (const corner of corners) {
      const back = imgToOut(corner, t)
      expect(back.x).toBeGreaterThan(-1e-6)
      expect(back.x).toBeLessThan(t.outWidth + 1e-6)
    }
  })
})

describe('solveForHeadroom', () => {
  it('is a no-op for specs without a headroom rule', () => {
    const p = placement(uprightHead())
    const solved = solveForHeadroom(US, p)
    expect(solved.satisfied).toBe(true)
    expect(solved.headHeight).toBe(p.headHeight)
    expect(solved.eyeHeight).toBe(p.eyeHeight)
  })

  it('finds values inside both ranges that satisfy the headroom band', () => {
    // Japan, because MOFA actually publishes a crown margin. The UK entry
    // previously carried an invented one solely to make this test possible.
    expect(JP.headroom).toBeDefined()
    const p: Placement = {
      landmarks: uprightHead(),
      headHeight: JP.head.max,
      eyeHeight: JP.eye.max,
      rollAdjustDeg: 0,
    }
    const solved = solveForHeadroom(JP, p)
    expect(solved.satisfied).toBe(true)
    expect(solved.headHeight).toBeGreaterThanOrEqual(JP.head.min - 1e-9)
    expect(solved.headHeight).toBeLessThanOrEqual(JP.head.max + 1e-9)

    const t = computeTransform(JP, { ...p, ...solved })
    const headroomMm = (t.headroomPx / JP.dpi) * 25.4
    expect(headroomMm).toBeGreaterThanOrEqual(JP.headroom!.min - 1e-6)
    expect(headroomMm).toBeLessThanOrEqual(JP.headroom!.max + 1e-6)
  })

  it('reports satisfied:false rather than guessing when nothing in range works', () => {
    // A face whose eyes sit very low in the head cannot satisfy Japan's 2-6 mm
    // crown margin at any permitted head/eye combination.
    const lowEyes: Landmarks = {
      crown: { x: 500, y: 200 },
      chin: { x: 500, y: 700 },
      eyes: { x: 500, y: 660 }, // eyeRatio ~0.92
    }
    const solved = solveForHeadroom(JP, {
      landmarks: lowEyes,
      headHeight: JP.head.default,
      eyeHeight: JP.eye.default,
      rollAdjustDeg: 0,
    })
    expect(solved.satisfied).toBe(false)
    // Even when it gives up it must hand back usable in-range values.
    expect(solved.headHeight).toBeGreaterThanOrEqual(JP.head.min)
    expect(solved.headHeight).toBeLessThanOrEqual(JP.head.max)
  })
})

describe('clampPlacement', () => {
  it('pulls out-of-range values back inside the spec', () => {
    const clamped = clampPlacement(US, placement(uprightHead(), {
      headHeight: 99,
      eyeHeight: -5,
      rollAdjustDeg: 400,
    }))
    expect(clamped.headHeight).toBe(US.head.max)
    expect(clamped.eyeHeight).toBe(US.eye.min)
    expect(clamped.rollAdjustDeg).toBe(15)
  })
})

describe('defaultPlacement', () => {
  it('produces a usable, in-range starting placement', () => {
    const p = defaultPlacement(US, 1200, 1600)
    expect(p.headHeight).toBe(US.head.default)
    expect(p.landmarks.crown.y).toBeLessThan(p.landmarks.eyes.y)
    expect(p.landmarks.eyes.y).toBeLessThan(p.landmarks.chin.y)
    expect(headTiltDeg(p.landmarks)).toBeCloseTo(0, 9)
  })
})
