/**
 * Tests for the pure half of segment.ts.
 *
 * MediaPipe needs WebGL, WASM and a real canvas, none of which exist in the
 * Node test environment, so `segmentPerson` and `compositeOnBackground` are not
 * exercised here — see the report in segment.ts for what that leaves untested.
 * Everything those two functions *decide* lives in the helpers below, which is
 * why they were factored out in the first place.
 */

import { describe, expect, it } from 'vitest'
import {
  blendChannel,
  boxBlur,
  choosePersonMaskIndex,
  defaultFeatherPx,
  featherAlpha,
  linearToSrgb,
  normalizeMask,
  parseColor,
  resampleMask,
  resolveModelUrl,
  sampleMask,
  srgbToLinear,
} from './segment'

/** Build a mask from a predicate over pixel coordinates. */
function maskFrom(width: number, height: number, fn: (x: number, y: number) => number): Float32Array {
  const out = new Float32Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) out[y * width + x] = fn(x, y)
  }
  return out
}

function sum(values: Float32Array): number {
  let total = 0
  for (const v of values) total += v
  return total
}

describe('resolveModelUrl', () => {
  it('joins the app base path onto the asset path', () => {
    expect(resolveModelUrl('models/face.task', '/')).toBe('/models/face.task')
    expect(resolveModelUrl('models/face.task', '/passport/')).toBe('/passport/models/face.task')
  })

  it('tolerates a base with or without a trailing slash', () => {
    expect(resolveModelUrl('models/wasm', '/repo')).toBe('/repo/models/wasm')
    expect(resolveModelUrl('/models/wasm', '/repo/')).toBe('/repo/models/wasm')
  })

  it('produces a same-origin path by default', () => {
    const url = resolveModelUrl('models/face.task')
    expect(url.startsWith('/')).toBe(true)
    expect(url.endsWith('models/face.task')).toBe(true)
  })

  it('refuses absolute URLs, so a CDN cannot creep back in', () => {
    expect(() => resolveModelUrl('https://cdn.jsdelivr.net/model.task')).toThrow(/same-origin/)
    expect(() => resolveModelUrl('//storage.googleapis.com/model.task')).toThrow(/same-origin/)
  })
})

describe('normalizeMask', () => {
  it('scales byte masks into 0-1', () => {
    const out = normalizeMask(new Uint8Array([0, 51, 255]))
    expect(out[0]).toBe(0)
    expect(out[1]).toBeCloseTo(0.2, 6)
    expect(out[2]).toBe(1)
  })

  it('clamps float masks that stray outside the range', () => {
    const out = normalizeMask(new Float32Array([-0.5, 0.25, 1.5]))
    expect(Array.from(out)).toEqual([0, 0.25, 1])
  })

  it('returns a copy, never a view of the input', () => {
    const input = new Float32Array([0.5])
    const out = normalizeMask(input)
    out[0] = 1
    expect(input[0]).toBe(0.5)
  })
})

describe('resampleMask', () => {
  it('copies when the sizes already match', () => {
    const src = new Float32Array([0, 1, 1, 0])
    const out = resampleMask(src, 2, 2, 2, 2)
    expect(Array.from(out)).toEqual([0, 1, 1, 0])
    out[0] = 9
    expect(src[0]).toBe(0)
  })

  it('interpolates rather than replicating when upscaling', () => {
    // A left-to-right ramp: 0 on the left column, 1 on the right.
    const src = new Float32Array([0, 1, 0, 1])
    const out = resampleMask(src, 2, 2, 4, 2)
    // Pixel centres map to -0.25, 0.25, 0.75, 1.25 in source space, clamped.
    expect(out[0]).toBeCloseTo(0, 5)
    expect(out[1]).toBeCloseTo(0.25, 5)
    expect(out[2]).toBeCloseTo(0.75, 5)
    expect(out[3]).toBeCloseTo(1, 5)
  })

  it('keeps a constant mask constant through a downscale', () => {
    const src = maskFrom(64, 64, () => 0.7)
    const out = resampleMask(src, 64, 64, 16, 16)
    expect(out.length).toBe(256)
    for (const v of out) expect(v).toBeCloseTo(0.7, 5)
  })
})

describe('boxBlur', () => {
  it('is the identity at radius 0', () => {
    const src = maskFrom(8, 8, (x) => (x < 4 ? 1 : 0))
    expect(Array.from(boxBlur(src, 8, 8, 0))).toEqual(Array.from(src))
  })

  it('leaves a uniform field uniform, including at the clamped edges', () => {
    const src = maskFrom(16, 16, () => 0.4)
    for (const v of boxBlur(src, 16, 16, 3)) expect(v).toBeCloseTo(0.4, 5)
  })

  it('conserves mass and stays symmetric around an interior impulse', () => {
    const w = 33
    const src = new Float32Array(w * w)
    const centre = 16 * w + 16
    src[centre] = 1
    const out = boxBlur(src, w, w, 3)
    expect(sum(out)).toBeCloseTo(1, 5)
    expect(out[16 * w + 15]).toBeCloseTo(out[16 * w + 17]!, 6)
    expect(out[15 * w + 16]).toBeCloseTo(out[17 * w + 16]!, 6)
  })

  it('turns a hard edge into a monotonic ramp', () => {
    const w = 20
    const src = maskFrom(w, 1, (x) => (x < 10 ? 1 : 0))
    const out = boxBlur(src, w, 1, 3)
    for (let x = 7; x <= 12; x++) {
      expect(out[x]!).toBeGreaterThan(0)
      expect(out[x]!).toBeLessThan(1)
      expect(out[x]!).toBeGreaterThan(out[x + 1]!)
    }
  })
})

describe('featherAlpha', () => {
  const hardEdge = maskFrom(32, 32, (x) => (x < 16 ? 1 : 0))

  it('passes the mask straight through when every knob is neutral', () => {
    const out = featherAlpha(hardEdge, 32, 32, { featherPx: 0, gamma: 1, strength: 1 })
    expect(Array.from(out)).toEqual(Array.from(hardEdge))
  })

  it('softens the edge into intermediate alpha values', () => {
    const out = featherAlpha(hardEdge, 32, 32, { featherPx: 3, gamma: 1, strength: 1 })
    const soft = Array.from(out.slice(16 * 32, 16 * 32 + 32)).filter((v) => v > 0.01 && v < 0.99)
    expect(soft.length).toBeGreaterThan(2)
  })

  it('applies gamma to the alpha, pulling the soft edge inward', () => {
    const half = new Float32Array([0.5, 0.5])
    const out = featherAlpha(half, 2, 1, { featherPx: 0, gamma: 2, strength: 1 })
    expect(out[0]).toBeCloseTo(0.25, 6)
    // Gamma above 1 can only shrink alpha, i.e. keep less of the subject edge.
    const feathered = featherAlpha(hardEdge, 32, 32, { featherPx: 3, gamma: 1 })
    const tighter = featherAlpha(hardEdge, 32, 32, { featherPx: 3, gamma: 2 })
    expect(sum(tighter)).toBeLessThan(sum(feathered))
  })

  it('at strength 0 keeps the original image everywhere', () => {
    const out = featherAlpha(hardEdge, 32, 32, { featherPx: 2, strength: 0 })
    for (const v of out) expect(v).toBeCloseTo(1, 6)
  })

  it('blends linearly between no replacement and full replacement', () => {
    const src = new Float32Array([0, 1])
    const full = featherAlpha(src, 2, 1, { featherPx: 0, gamma: 1, strength: 1 })
    const half = featherAlpha(src, 2, 1, { featherPx: 0, gamma: 1, strength: 0.5 })
    expect(full[0]).toBe(0)
    expect(half[0]).toBeCloseTo(0.5, 6)
    expect(half[1]).toBeCloseTo(1, 6)
  })

  it('never leaves the 0-1 range', () => {
    const noisy = maskFrom(24, 24, (x, y) => ((x * 7 + y * 13) % 11) / 10)
    for (const v of featherAlpha(noisy, 24, 24, { featherPx: 4, gamma: 1.4, strength: 0.8 })) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(1)
    }
  })
})

describe('defaultFeatherPx', () => {
  it('scales with the image but stays within useful bounds', () => {
    expect(defaultFeatherPx(200, 200)).toBe(1)
    expect(defaultFeatherPx(1000, 1500)).toBe(4)
    expect(defaultFeatherPx(8000, 8000)).toBe(12)
  })
})

describe('choosePersonMaskIndex', () => {
  const w = 64
  const h = 64
  const person = maskFrom(w, h, (x, y) => {
    const nx = (x - w / 2) / (w / 2)
    const ny = (y - h / 2) / (h / 2)
    return nx * nx + ny * ny < 0.2 ? 1 : 0
  })
  const background = maskFrom(w, h, (x, y) => 1 - person[y * w + x]!)

  it('trivially returns the only mask', () => {
    expect(choosePersonMaskIndex([background], w, h)).toBe(0)
  })

  it('picks the centre-heavy mask whichever order it arrives in', () => {
    expect(choosePersonMaskIndex([background, person], w, h)).toBe(1)
    expect(choosePersonMaskIndex([person, background], w, h)).toBe(0)
  })
})

describe('sampleMask', () => {
  const mask = new Float32Array([0, 0.5, 1, 0.25])

  it('reads the nearest pixel', () => {
    expect(sampleMask(mask, 2, 2, 0.4, 0.4)).toBe(0)
    expect(sampleMask(mask, 2, 2, 1, 0)).toBe(0.5)
    expect(sampleMask(mask, 2, 2, 0.4, 1.2)).toBe(1)
    expect(sampleMask(mask, 2, 2, 0.6, 1.2)).toBe(0.25)
  })

  it('reads outside the image as background', () => {
    expect(sampleMask(mask, 2, 2, -1, 0)).toBe(0)
    expect(sampleMask(mask, 2, 2, 0, 5)).toBe(0)
  })
})

describe('parseColor', () => {
  it('parses the hex forms the specs actually use', () => {
    expect(parseColor('#ffffff')).toEqual({ r: 255, g: 255, b: 255 })
    expect(parseColor('#f5f5f5')).toEqual({ r: 245, g: 245, b: 245 })
    expect(parseColor('#F0A')).toEqual({ r: 255, g: 0, b: 170 })
  })

  it('accepts rgb() and named colours', () => {
    expect(parseColor('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 })
    expect(parseColor('rgba(10 20 30 / 0.5)')).toEqual({ r: 10, g: 20, b: 30 })
    expect(parseColor('white')).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('reads the colour off a BackgroundRule', () => {
    const rule = { label: 'Plain white', minChannel: 240, maxSpread: 12, color: '#ffffff' }
    expect(parseColor(rule)).toEqual({ r: 255, g: 255, b: 255 })
  })

  it('throws rather than silently painting the wrong background', () => {
    expect(() => parseColor('chartreuse-ish')).toThrow(/Unsupported background colour/)
  })
})

describe('sRGB transfer', () => {
  it('round-trips channel values', () => {
    for (const v of [0, 1, 10, 128, 200, 255]) {
      expect(linearToSrgb(srgbToLinear(v))).toBeCloseTo(v, 4)
    }
  })

  it('maps the endpoints exactly', () => {
    expect(srgbToLinear(0)).toBe(0)
    expect(srgbToLinear(255)).toBeCloseTo(1, 6)
  })
})

describe('blendChannel', () => {
  it('returns the subject at alpha 1 and the background at alpha 0', () => {
    expect(blendChannel(30, 255, 1, true)).toBeCloseTo(30, 3)
    expect(blendChannel(30, 255, 0, true)).toBeCloseTo(255, 3)
    expect(blendChannel(30, 255, 1, false)).toBeCloseTo(30, 6)
    expect(blendChannel(30, 255, 0, false)).toBeCloseTo(255, 6)
  })

  it('blending in linear light keeps the edge brighter than blending in sRGB', () => {
    // This difference is the grey fringe around hair: sRGB blending of a dark
    // strand against a white backdrop lands too dark.
    const linear = blendChannel(30, 255, 0.5, true)
    const naive = blendChannel(30, 255, 0.5, false)
    expect(linear).toBeGreaterThan(naive)
  })

  it('is monotonic in alpha', () => {
    let previous = blendChannel(30, 255, 0, true)
    for (let a = 0.1; a <= 1.0001; a += 0.1) {
      const next = blendChannel(30, 255, a, true)
      expect(next).toBeLessThan(previous)
      previous = next
    }
  })

  it('clamps alpha outside 0-1', () => {
    expect(blendChannel(30, 255, 2, false)).toBeCloseTo(30, 6)
    expect(blendChannel(30, 255, -1, false)).toBeCloseTo(255, 6)
  })
})
