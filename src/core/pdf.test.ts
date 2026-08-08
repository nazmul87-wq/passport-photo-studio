import { describe, expect, it } from 'vitest'
import { buildPdf, pdfPageSize } from './pdf'

/**
 * A stand-in JPEG: SOI, a JFIF APP0, SOS and EOI. Nothing decodes it here —
 * `buildPdf` stores the payload verbatim, so these tests are about the wrapper.
 * Structural bytes rather than random ones, so the "appears verbatim" assertion
 * is not accidentally satisfied by a shorter run.
 */
function fakeJpeg(payloadLength = 64): Uint8Array {
  const filler = Array.from({ length: payloadLength }, (_, i) => (i * 7 + 3) & 0xff)
  return new Uint8Array([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00,
    0x01, 0x02, 0x01,
    0x01, 0x2c, 0x01, 0x2c,
    0x00, 0x00,
    0xff, 0xda, 0x00, 0x02,
    ...filler,
    0xff, 0xd9,
  ])
}

const text = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => String.fromCharCode(b)).join('')

/** Byte index of the first occurrence of `needle` in `haystack`, or -1. */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer
    }
    return i
  }
  return -1
}

describe('buildPdf: the page is the physical size', () => {
  it('declares a 4x6 in page for a 4x6 in sheet at 300 DPI', () => {
    // 1200x1800 px / 300 dpi = 4x6 in = 288x432 pt. This single assertion is
    // the entire reason the feature exists.
    const pdf = buildPdf({ jpeg: fakeJpeg(), widthPx: 1200, heightPx: 1800, dpi: 300 })
    expect(text(pdf)).toContain('/MediaBox [0 0 288 432]')
  })

  it('declares the same page whatever DPI produced those pixels', () => {
    // 600x900 at 150 DPI is also 4x6 in. If the page tracked pixels instead of
    // inches, this would come out half-size.
    const pdf = buildPdf({ jpeg: fakeJpeg(), widthPx: 600, heightPx: 900, dpi: 150 })
    expect(text(pdf)).toContain('/MediaBox [0 0 288 432]')
  })

  it('rounds A4 to two decimal places rather than emitting exponent form', () => {
    const a4 = { widthPx: Math.round((210 / 25.4) * 300), heightPx: Math.round((297 / 25.4) * 300) }
    const pdf = buildPdf({ jpeg: fakeJpeg(), ...a4, dpi: 300 })
    expect(text(pdf)).toContain('/MediaBox [0 0 595.2 841.92]')
    expect(text(pdf)).not.toMatch(/e[+-]\d/)
  })

  it('keeps pixel dimensions on the image and points on the page', () => {
    // The mistake this format invites: a correct page holding a tiny image.
    const pdf = buildPdf({ jpeg: fakeJpeg(), widthPx: 1200, heightPx: 1800, dpi: 300 })
    expect(text(pdf)).toContain('/Width 1200 /Height 1800')
    expect(text(pdf)).toContain('288 0 0 432 0 0 cm')
  })
})

describe('buildPdf: the payload is stored verbatim', () => {
  const jpeg = fakeJpeg()
  const pdf = buildPdf({ jpeg, widthPx: 1200, heightPx: 1800, dpi: 300 })

  it('embeds the JPEG bytes unchanged and contiguous', () => {
    expect(indexOfBytes(pdf, jpeg)).toBeGreaterThan(0)
  })

  it('declares a stream length equal to the JPEG length', () => {
    expect(text(pdf)).toContain(`/Filter /DCTDecode /Length ${jpeg.length} >>`)
  })

  it('does not re-encode: the output is the payload plus a small wrapper', () => {
    expect(pdf.length).toBeGreaterThan(jpeg.length)
    expect(pdf.length - jpeg.length).toBeLessThan(1024)
  })
})

describe('buildPdf: structural validity', () => {
  const pdf = buildPdf({ jpeg: fakeJpeg(), widthPx: 1200, heightPx: 1800, dpi: 300 })
  const source = text(pdf)

  it('opens with the header and a binary marker comment', () => {
    expect(source.startsWith('%PDF-1.4\n')).toBe(true)
    // A comment opener at byte 9, then four bytes above 0x7f, so nothing
    // downstream treats the file as text and rewrites its line endings.
    expect(pdf[9]).toBe(0x25)
    expect([pdf[10], pdf[11], pdf[12], pdf[13]].every((b) => b! > 0x7f)).toBe(true)
    expect(pdf[14]).toBe(0x0a)
  })

  it('points every xref entry at its own object header', () => {
    const start = source.indexOf('xref\n')
    // Entry 0 is the free head; objects run 1..5 after it, 20 bytes each.
    const first = start + 'xref\n0 6\n'.length
    for (let id = 1; id <= 5; id++) {
      const entry = source.slice(first + id * 20, first + (id + 1) * 20)
      expect(entry).toHaveLength(20)
      const offset = Number(entry.slice(0, 10))
      expect(source.slice(offset)).toMatch(new RegExp(`^${id} 0 obj\\n`))
    }
  })

  it('marks object 0 free and every other object in use', () => {
    const start = source.indexOf('xref\n')
    expect(source.slice(start)).toContain('0000000000 65535 f \n')
    expect(source.slice(start).match(/ 00000 n \n/g)).toHaveLength(5)
  })

  it('points startxref at the xref keyword', () => {
    const declared = Number(source.match(/startxref\n(\d+)\n/)![1])
    expect(source.slice(declared, declared + 4)).toBe('xref')
  })

  it('ends with the EOF marker', () => {
    expect(source.endsWith('%%EOF\n')).toBe(true)
  })

  it('writes no Info dictionary, so no timestamp reaches the file', () => {
    expect(source).not.toContain('/Info')
    expect(source).not.toContain('/CreationDate')
    expect(source).not.toContain('/Producer')
  })
})

describe('buildPdf: rejected input', () => {
  it('refuses bytes that are not a JPEG', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(() => buildPdf({ jpeg: png, widthPx: 1200, heightPx: 1800, dpi: 300 })).toThrow(
      /Not a JPEG/,
    )
  })

  it('refuses an empty payload', () => {
    expect(() =>
      buildPdf({ jpeg: new Uint8Array(), widthPx: 1200, heightPx: 1800, dpi: 300 }),
    ).toThrow(/Not a JPEG/)
  })

  it('refuses a sheet with no size, which would produce a zero-area page', () => {
    expect(() => buildPdf({ jpeg: fakeJpeg(), widthPx: 0, heightPx: 1800, dpi: 300 })).toThrow(
      /pixel dimensions/,
    )
    expect(() => buildPdf({ jpeg: fakeJpeg(), widthPx: 1200, heightPx: 1800, dpi: 0 })).toThrow(
      /DPI/,
    )
  })
})

describe('pdfPageSize', () => {
  it('agrees with what buildPdf writes into the MediaBox', () => {
    const { widthPt, heightPt } = pdfPageSize(1200, 1800, 300)
    expect(widthPt).toBeCloseTo(288, 6)
    expect(heightPt).toBeCloseTo(432, 6)
  })
})
