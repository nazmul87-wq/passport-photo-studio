import { describe, expect, it } from 'vitest'
import {
  isPlausiblePersonMask,
  maskCoverage,
  MAX_SUBJECT_COVERAGE,
  MIN_SUBJECT_COVERAGE,
  type PersonMask,
} from './segment'

/** A mask where `fraction` of the frame is subject. */
function mask(fraction: number, quality = 1, size = 1000): PersonMask {
  const data = new Float32Array(size)
  const on = Math.round(size * fraction)
  for (let i = 0; i < on; i++) data[i] = 1
  return { mask: data, width: size, height: 1, quality }
}

describe('maskCoverage', () => {
  it('measures the subject fraction', () => {
    expect(maskCoverage(mask(0).mask)).toBe(0)
    expect(maskCoverage(mask(0.25).mask)).toBeCloseTo(0.25, 6)
    expect(maskCoverage(mask(1).mask)).toBe(1)
  })

  it('handles an empty mask without dividing by zero', () => {
    expect(maskCoverage(new Float32Array(0))).toBe(0)
  })

  it('respects the threshold', () => {
    const soft = new Float32Array([0.4, 0.4, 0.6, 0.6])
    expect(maskCoverage(soft, 0.5)).toBe(0.5)
    expect(maskCoverage(soft, 0.3)).toBe(1)
    expect(maskCoverage(soft, 0.7)).toBe(0)
  })
})

describe('isPlausiblePersonMask', () => {
  it('accepts a normally framed portrait', () => {
    expect(isPlausiblePersonMask(mask(0.45))).toBe(true)
  })

  it('rejects a mask that found no subject EVEN AT FULL REPORTED QUALITY', () => {
    // This is the real failure mode: the selfie segmenter returns quality 1.0
    // on an image it does not understand, with a mask containing nothing.
    // Compositing it produced a 99.7% blank white photo, silently.
    expect(isPlausiblePersonMask(mask(0, 1))).toBe(false)
    expect(isPlausiblePersonMask(mask(0.001, 1))).toBe(false)
  })

  it('rejects a mask that swallowed the whole frame', () => {
    expect(isPlausiblePersonMask(mask(1, 1))).toBe(false)
    expect(isPlausiblePersonMask(mask(0.99, 1))).toBe(false)
  })

  it('is inclusive at both bounds', () => {
    expect(isPlausiblePersonMask(mask(MIN_SUBJECT_COVERAGE))).toBe(true)
    expect(isPlausiblePersonMask(mask(MAX_SUBJECT_COVERAGE))).toBe(true)
  })

  it('rejects just outside both bounds', () => {
    expect(isPlausiblePersonMask(mask(MIN_SUBJECT_COVERAGE - 0.02))).toBe(false)
    expect(isPlausiblePersonMask(mask(MAX_SUBJECT_COVERAGE + 0.02))).toBe(false)
  })
})
