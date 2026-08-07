import { describe, expect, it } from 'vitest'
import {
  applyToPixels,
  autoWhiteBalance,
  buildLut,
  isNeutral,
  luma,
  NEUTRAL_ADJUSTMENTS,
  toneCurve,
  UNIT_GAINS,
  type Adjustments,
} from './enhance'
import type { BackgroundSample } from './validate'

const adjust = (over: Partial<Adjustments> = {}): Adjustments => ({
  ...NEUTRAL_ADJUSTMENTS,
  ...over,
})

const sample = (mean: [number, number, number]): BackgroundSample => ({
  mean,
  minChannel: Math.min(...mean),
  spread: Math.max(...mean) - Math.min(...mean),
  unevenness: 0,
})

/** Build an RGBA buffer from flat RGB triples. */
function pixels(...rgb: Array<[number, number, number]>): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgb.length * 4)
  rgb.forEach(([r, g, b], i) => {
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = 255
  })
  return out
}

describe('toneCurve', () => {
  it('is the identity when nothing is adjusted', () => {
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      expect(toneCurve(v, NEUTRAL_ADJUSTMENTS)).toBeCloseTo(v, 10)
    }
  })

  it('stays within 0..1 for every input and every extreme setting', () => {
    const extremes: Adjustments[] = [
      adjust({ exposure: 1 }),
      adjust({ exposure: -1 }),
      adjust({ contrast: 1, exposure: 1, shadows: 1, highlights: 1 }),
      adjust({ contrast: -1, exposure: -1, shadows: -1, highlights: -1 }),
    ]
    for (const a of extremes) {
      for (let i = 0; i <= 255; i++) {
        const out = toneCurve(i / 255, a)
        expect(out).toBeGreaterThanOrEqual(0)
        expect(out).toBeLessThanOrEqual(1)
      }
    }
  })

  it('is monotonic, so adjustments never invert tonal order', () => {
    const cases = [
      adjust({ exposure: 0.4 }),
      adjust({ contrast: 0.6 }),
      adjust({ shadows: 0.7 }),
      adjust({ highlights: -0.7 }),
      adjust({ exposure: -0.3, contrast: 0.4, shadows: 0.5, highlights: -0.5 }),
    ]
    for (const a of cases) {
      let prev = -1
      for (let i = 0; i <= 255; i++) {
        const out = toneCurve(i / 255, a)
        expect(out).toBeGreaterThanOrEqual(prev - 1e-9)
        prev = out
      }
    }
  })

  it('brightens with positive exposure and darkens with negative', () => {
    expect(toneCurve(0.4, adjust({ exposure: 0.3 }))).toBeGreaterThan(0.4)
    expect(toneCurve(0.4, adjust({ exposure: -0.3 }))).toBeLessThan(0.4)
  })

  it('lifts shadows far more than highlights', () => {
    const a = adjust({ shadows: 0.5 })
    const darkLift = toneCurve(0.1, a) - 0.1
    const brightLift = toneCurve(0.9, a) - 0.9
    expect(darkLift).toBeGreaterThan(brightLift * 5)
  })

  it('leaves mid-grey fixed under contrast', () => {
    expect(toneCurve(0.5, adjust({ contrast: 0.8 }))).toBeCloseTo(0.5, 10)
    expect(toneCurve(0.5, adjust({ contrast: -0.8 }))).toBeCloseTo(0.5, 10)
  })
})

describe('buildLut', () => {
  it('is the identity table when nothing is adjusted', () => {
    const lut = buildLut(NEUTRAL_ADJUSTMENTS)
    for (let i = 0; i < 256; i++) {
      expect(lut.r[i]).toBe(i)
      expect(lut.g[i]).toBe(i)
      expect(lut.b[i]).toBe(i)
    }
  })

  it('warms red and cools blue with positive temperature', () => {
    const lut = buildLut(adjust({ temperature: 0.5 }))
    expect(lut.r[128]!).toBeGreaterThan(128)
    expect(lut.b[128]!).toBeLessThan(128)
    expect(lut.g[128]!).toBe(128)
  })
})

describe('applyToPixels', () => {
  it('does nothing at all when the stack is neutral', () => {
    const data = pixels([10, 120, 240])
    const before = Array.from(data)
    applyToPixels(data, NEUTRAL_ADJUSTMENTS)
    expect(Array.from(data)).toEqual(before)
  })

  it('never touches alpha', () => {
    const data = pixels([10, 120, 240])
    data[3] = 128
    applyToPixels(data, adjust({ exposure: 0.5, saturation: 0.5 }))
    expect(data[3]).toBe(128)
  })

  it('drives colour to grey at minimum saturation', () => {
    const data = pixels([200, 60, 20])
    applyToPixels(data, adjust({ saturation: -1 }))
    expect(data[0]).toBe(data[1])
    expect(data[1]).toBe(data[2])
    expect(data[0]).toBeCloseTo(Math.round(luma(200, 60, 20)), 0)
  })

  it('leaves an already-grey pixel grey at any saturation', () => {
    const data = pixels([128, 128, 128])
    applyToPixels(data, adjust({ saturation: 1 }))
    expect(data[0]).toBe(data[1])
    expect(data[1]).toBe(data[2])
  })
})

describe('autoWhiteBalance', () => {
  it('is a no-op on an already neutral background', () => {
    const g = autoWhiteBalance(sample([240, 240, 240]))
    expect(g.r).toBeCloseTo(1, 6)
    expect(g.g).toBeCloseTo(1, 6)
    expect(g.b).toBeCloseTo(1, 6)
  })

  it('never scales a channel above 1, so a near-white wall cannot clip', () => {
    for (const mean of [
      [250, 240, 225],
      [225, 235, 250],
      [200, 210, 190],
      [255, 250, 240],
    ] as Array<[number, number, number]>) {
      const g = autoWhiteBalance(sample(mean))
      expect(Math.max(g.r, g.g, g.b)).toBeLessThanOrEqual(1 + 1e-9)
      expect(Math.min(g.r, g.g, g.b)).toBeGreaterThan(0)
    }
  })

  it('neutralises a warm cream wall', () => {
    const warm = sample([250, 240, 225])
    const gains = autoWhiteBalance(warm)
    const data = pixels(warm.mean.map(Math.round) as unknown as [number, number, number])
    applyToPixels(data, NEUTRAL_ADJUSTMENTS, gains)
    const spread = Math.max(data[0]!, data[1]!, data[2]!) - Math.min(data[0]!, data[1]!, data[2]!)
    expect(spread).toBeLessThanOrEqual(1)
  })

  it('neutralises a cool blue-tinted wall', () => {
    const cool = sample([228, 236, 250])
    const gains = autoWhiteBalance(cool)
    const data = pixels([228, 236, 250])
    applyToPixels(data, NEUTRAL_ADJUSTMENTS, gains)
    const spread = Math.max(data[0]!, data[1]!, data[2]!) - Math.min(data[0]!, data[1]!, data[2]!)
    expect(spread).toBeLessThanOrEqual(1)
  })

  it('guards against a degenerate all-black sample', () => {
    expect(autoWhiteBalance(sample([0, 0, 0]))).toEqual(UNIT_GAINS)
  })
})

describe('isNeutral', () => {
  it('recognises the untouched stack', () => {
    expect(isNeutral(NEUTRAL_ADJUSTMENTS)).toBe(true)
  })

  it('accounts for channel gains as well as the sliders', () => {
    expect(isNeutral(NEUTRAL_ADJUSTMENTS, { r: 0.9, g: 1, b: 1 })).toBe(false)
  })
})
