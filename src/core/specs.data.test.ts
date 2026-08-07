import { describe, expect, it } from 'vitest'
import { SPEC_REGISTRY, specPixelSize, type PhotoSpec } from './specs'

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

describe('SPEC_REGISTRY integrity', () => {
  it('is non-empty', () => {
    expect(SPEC_REGISTRY.length).toBeGreaterThan(0)
  })

  it('has unique ids', () => {
    const ids = SPEC_REGISTRY.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it.each(SPEC_REGISTRY.map((s) => [s.id, s] as [string, PhotoSpec]))(
    '%s is internally consistent',
    (_id, spec) => {
      // id shape
      expect(spec.id).toMatch(KEBAB)

      // identity fields are present
      expect(spec.country.length).toBeGreaterThan(0)
      expect(spec.countryCode).toMatch(/^[A-Z]{2}$/)
      expect(spec.documents.length).toBeGreaterThan(0)

      // physical size
      expect(['mm', 'in']).toContain(spec.unit)
      expect(spec.photoW).toBeGreaterThan(0)
      expect(spec.photoH).toBeGreaterThan(0)
      expect(spec.dpi).toBeGreaterThan(0)

      // head range: ordered, default inside, and it must fit in the photo
      expect(spec.head.min).toBeLessThanOrEqual(spec.head.max)
      expect(spec.head.default).toBeGreaterThanOrEqual(spec.head.min)
      expect(spec.head.default).toBeLessThanOrEqual(spec.head.max)
      expect(spec.head.min).toBeGreaterThan(0)
      expect(spec.head.max).toBeLessThan(spec.photoH)

      // eye range: pupil line measured up from the bottom edge
      expect(spec.eye.min).toBeLessThanOrEqual(spec.eye.max)
      expect(spec.eye.default).toBeGreaterThanOrEqual(spec.eye.min)
      expect(spec.eye.default).toBeLessThanOrEqual(spec.eye.max)
      expect(spec.eye.min).toBeGreaterThan(0)
      expect(spec.eye.max).toBeLessThan(spec.photoH)

      // headroom, where the authority publishes one
      if (spec.headroom) {
        expect(spec.headroom.min).toBeLessThanOrEqual(spec.headroom.max)
        expect(spec.headroom.min).toBeGreaterThanOrEqual(0)
        expect(spec.headroom.max).toBeLessThan(spec.photoH)
      }

      // background rule is usable by the compliance checker
      expect(spec.background.label.length).toBeGreaterThan(0)
      expect(spec.background.minChannel).toBeGreaterThan(0)
      expect(spec.background.minChannel).toBeLessThanOrEqual(255)
      expect(spec.background.maxSpread).toBeGreaterThan(0)
      expect(spec.background.color).toMatch(/^#[0-9a-f]{6}$/)

      // provenance
      expect(spec.sourceUrl).toMatch(/^https:\/\/\S+$/)
      expect(spec.lastVerified).toMatch(ISO_DATE)
      expect(Number.isNaN(Date.parse(spec.lastVerified))).toBe(false)

      // notes are short, non-empty rules
      for (const note of spec.notes ?? []) {
        expect(note.trim().length).toBeGreaterThan(0)
      }

      // derived pixel size
      const { width, height } = specPixelSize(spec)
      expect(Number.isInteger(width)).toBe(true)
      expect(Number.isInteger(height)).toBe(true)
      expect(width).toBeGreaterThan(0)
      expect(height).toBeGreaterThan(0)
    },
  )
})

describe('pixel size fixtures', () => {
  it('us-2x2 renders at 600x600', () => {
    const spec = SPEC_REGISTRY.find((s) => s.id === 'us-2x2')!
    expect(spec).toBeDefined()
    expect(specPixelSize(spec)).toEqual({ width: 600, height: 600 })
  })

  it('intl-35x45 renders at 413x531', () => {
    const spec = SPEC_REGISTRY.find((s) => s.id === 'intl-35x45')!
    expect(spec).toBeDefined()
    expect(specPixelSize(spec)).toEqual({ width: 413, height: 531 })
  })
})
