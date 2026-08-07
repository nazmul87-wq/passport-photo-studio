/**
 * Photo enhancement.
 *
 * A non-destructive adjustment stack applied to the cropped photo only. The
 * tone curve is precomputed into a per-channel 256-entry lookup table, so the
 * pixel pass is three array reads plus a saturation blend — a 600×600 photo is
 * 360k pixels and finishes in a couple of milliseconds, which is why this needs
 * neither WebGL nor a worker.
 *
 * Auto white balance is the highest-value control here: a cream, beige or
 * blue-tinted wall is the most common reason an otherwise fine photo fails the
 * background rule, and correcting it is a colour fix rather than a manipulation
 * of the subject.
 */

import type { BackgroundSample } from './validate'

export interface Adjustments {
  /** Overall brightness, in stops. -1..1 */
  exposure: number
  /** Tonal separation about mid-grey. -1..1 */
  contrast: number
  /** Colour intensity. -1 is greyscale, 0 untouched, 1 doubled. */
  saturation: number
  /** Cool to warm. -1..1 */
  temperature: number
  /** Lifts or deepens the darker tones only. -1..1 */
  shadows: number
  /** Recovers or brightens the lighter tones only. -1..1 */
  highlights: number
}

export const NEUTRAL_ADJUSTMENTS: Adjustments = {
  exposure: 0,
  contrast: 0,
  saturation: 0,
  temperature: 0,
  shadows: 0,
  highlights: 0,
}

/** Per-channel multipliers, e.g. from auto white balance. */
export interface ChannelGains {
  r: number
  g: number
  b: number
}

export const UNIT_GAINS: ChannelGains = { r: 1, g: 1, b: 1 }

export function isNeutral(a: Adjustments, gains: ChannelGains = UNIT_GAINS): boolean {
  return (
    a.exposure === 0 &&
    a.contrast === 0 &&
    a.saturation === 0 &&
    a.temperature === 0 &&
    a.shadows === 0 &&
    a.highlights === 0 &&
    gains.r === 1 &&
    gains.g === 1 &&
    gains.b === 1
  )
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/**
 * The tone curve for a single normalised input value, before per-channel gain.
 * Exported for testing: the ordering of these operations is the whole
 * character of the adjustment, and it is worth pinning down.
 */
export function toneCurve(v: number, a: Adjustments): number {
  let x = clamp01(v)

  // Exposure first, in stops, so it behaves like a camera control.
  if (a.exposure !== 0) x *= Math.pow(2, a.exposure * 2)
  x = clamp01(x)

  // Shadows and highlights are weighted lifts that leave mid-tones alone.
  if (a.shadows !== 0) {
    const weight = (1 - x) * (1 - x)
    x += a.shadows * 0.5 * weight
  }
  if (a.highlights !== 0) {
    const weight = x * x
    x += a.highlights * 0.5 * weight
  }
  x = clamp01(x)

  // Contrast last, pivoting on mid-grey.
  if (a.contrast !== 0) {
    const amount = a.contrast > 0 ? 1 + a.contrast * 1.5 : 1 + a.contrast
    x = (x - 0.5) * amount + 0.5
  }

  return clamp01(x)
}

export interface ToneLut {
  r: Uint8Array
  g: Uint8Array
  b: Uint8Array
}

/**
 * Bake the tone curve, temperature shift and channel gains into three lookup
 * tables. Everything except saturation is per-channel and order-independent
 * once resolved, so it collapses into a single table read per channel.
 */
export function buildLut(a: Adjustments, gains: ChannelGains = UNIT_GAINS): ToneLut {
  // Temperature warms by lifting red and cutting blue, leaving green as the
  // anchor so overall brightness barely moves.
  const tempR = 1 + a.temperature * 0.12
  const tempB = 1 - a.temperature * 0.12

  const lut: ToneLut = { r: new Uint8Array(256), g: new Uint8Array(256), b: new Uint8Array(256) }
  for (let i = 0; i < 256; i++) {
    const base = toneCurve(i / 255, a)
    lut.r[i] = Math.round(clamp01(base * tempR * gains.r) * 255)
    lut.g[i] = Math.round(clamp01(base * gains.g) * 255)
    lut.b[i] = Math.round(clamp01(base * tempB * gains.b) * 255)
  }
  return lut
}

/** Rec. 709 luma, used as the grey axis for the saturation blend. */
export function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/**
 * Apply the adjustment stack to raw RGBA bytes, in place.
 * Accepts a plain Uint8ClampedArray so it is testable without a canvas.
 */
export function applyToPixels(
  data: Uint8ClampedArray,
  a: Adjustments,
  gains: ChannelGains = UNIT_GAINS,
): void {
  if (isNeutral(a, gains)) return

  const lut = buildLut(a, gains)
  const sat = 1 + a.saturation

  for (let i = 0; i < data.length; i += 4) {
    let r = lut.r[data[i]!]!
    let g = lut.g[data[i + 1]!]!
    let b = lut.b[data[i + 2]!]!

    if (a.saturation !== 0) {
      const l = luma(r, g, b)
      r = l + (r - l) * sat
      g = l + (g - l) * sat
      b = l + (b - l) * sat
    }

    data[i] = r
    data[i + 1] = g
    data[i + 2] = b
    // Alpha is left untouched: the crop is opaque, and background compositing
    // owns alpha elsewhere in the pipeline.
  }
}

/**
 * Gains that neutralise a colour cast, derived from the sampled background.
 *
 * A grey-world assumption over the whole photo would be wrong here — a face
 * fills most of the frame and skin is genuinely warm, so averaging it would
 * push the whole image blue. The background corners are the one region we know
 * is *supposed* to be neutral, which makes them the correct reference.
 */
export function autoWhiteBalance(sample: BackgroundSample): ChannelGains {
  const [r, g, b] = sample.mean
  if (r <= 0 || g <= 0 || b <= 0) return UNIT_GAINS

  // Normalise against the brightest channel so the correction only ever pulls
  // channels down. Scaling up would clip a background that is already near
  // white and produce a flat, blown-out wall.
  const target = Math.max(r, g, b)
  const gains = { r: target / r, g: target / g, b: target / b }

  // Then rescale so the brightest gain is 1: the result corrects the cast
  // without changing overall exposure.
  const maxGain = Math.max(gains.r, gains.g, gains.b)
  return { r: gains.r / maxGain, g: gains.g / maxGain, b: gains.b / maxGain }
}

/** How far from neutral the sampled background is, 0 (perfect) upward. */
export function castStrength(sample: BackgroundSample): number {
  return sample.spread
}

/** Apply adjustments to a canvas in place. Returns the same canvas. */
export function applyToCanvas(
  canvas: HTMLCanvasElement,
  a: Adjustments,
  gains: ChannelGains = UNIT_GAINS,
): HTMLCanvasElement {
  if (isNeutral(a, gains)) return canvas
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return canvas
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height)
  applyToPixels(image.data, a, gains)
  ctx.putImageData(image, 0, 0)
  return canvas
}
