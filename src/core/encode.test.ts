import { describe, expect, it } from 'vitest'
import { readDpi, setJpegDpi, setPngDpi } from './encode'

/**
 * A minimal but structurally valid PNG: signature, IHDR, one IDAT, IEND.
 * The pixel data is irrelevant — these tests exercise chunk surgery, and using
 * a hand-built file keeps them free of any canvas dependency.
 */
function makePng(withExistingPhys = false): Uint8Array {
  const chunks: number[][] = []

  const chunk = (type: string, data: number[]) => {
    const bytes = [
      (data.length >>> 24) & 0xff,
      (data.length >>> 16) & 0xff,
      (data.length >>> 8) & 0xff,
      data.length & 0xff,
      ...[...type].map((c) => c.charCodeAt(0)),
      ...data,
    ]
    // CRC over type + data. Recomputed here independently of the module under
    // test so a broken CRC implementation cannot pass by agreeing with itself.
    let crc = 0xffffffff
    for (let i = 4; i < bytes.length; i++) {
      crc ^= bytes[i]!
      for (let k = 0; k < 8; k++) {
        crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0
    bytes.push((crc >>> 24) & 0xff, (crc >>> 16) & 0xff, (crc >>> 8) & 0xff, crc & 0xff)
    chunks.push(bytes)
  }

  chunk('IHDR', [0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])
  if (withExistingPhys) chunk('pHYs', [0, 0, 0x0b, 0x13, 0, 0, 0x0b, 0x13, 1]) // 72 dpi
  chunk('IDAT', [0x78, 0x9c, 0x63, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01])
  chunk('IEND', [])

  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunks.flat(),
  ])
}

/** SOI + JFIF APP0 (units=0, density=1, as browsers emit) + SOS + EOI. */
function makeJpeg(withJfif = true): Uint8Array {
  const head = withJfif
    ? [
        0xff, 0xe0, 0x00, 0x10,
        0x4a, 0x46, 0x49, 0x46, 0x00,
        0x01, 0x02,
        0x00, // units: none
        0x00, 0x01, 0x00, 0x01, // density 1x1
        0x00, 0x00,
      ]
    : []
  return new Uint8Array([0xff, 0xd8, ...head, 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9])
}

describe('setPngDpi', () => {
  it('declares 300 DPI on a PNG that had no pHYs chunk', () => {
    const out = setPngDpi(makePng(), 300)
    expect(readDpi(out)).toBeCloseTo(300, 0)
  })

  it('replaces an existing pHYs chunk without changing the file length', () => {
    const original = makePng(true)
    expect(readDpi(original)).toBeCloseTo(72, 0)
    const out = setPngDpi(original, 300)
    expect(out.length).toBe(original.length)
    expect(readDpi(out)).toBeCloseTo(300, 0)
  })

  it('inserts pHYs after IHDR and before IDAT', () => {
    const out = setPngDpi(makePng(), 300)
    const text = Array.from(out)
      .map((b) => String.fromCharCode(b))
      .join('')
    expect(text.indexOf('IHDR')).toBeLessThan(text.indexOf('pHYs'))
    expect(text.indexOf('pHYs')).toBeLessThan(text.indexOf('IDAT'))
  })

  it('writes a CRC that a standard PNG reader would accept', () => {
    const out = setPngDpi(makePng(), 300)
    const at = Array.from(out)
      .map((b) => String.fromCharCode(b))
      .join('')
      .indexOf('pHYs') - 4

    let crc = 0xffffffff
    for (let i = at + 4; i < at + 17; i++) {
      crc ^= out[i]!
      for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
    crc = (crc ^ 0xffffffff) >>> 0
    const stored =
      ((out[at + 17]! << 24) | (out[at + 18]! << 16) | (out[at + 19]! << 8) | out[at + 20]!) >>> 0
    expect(stored).toBe(crc)
  })

  it('rejects input that is not a PNG', () => {
    expect(() => setPngDpi(new Uint8Array([1, 2, 3]), 300)).toThrow(/Not a PNG/)
  })
})

describe('setJpegDpi', () => {
  it('patches the density of a browser-emitted JFIF header in place', () => {
    const original = makeJpeg()
    expect(readDpi(original)).toBeNull() // units = 0 means "no real density"
    const out = setJpegDpi(original, 300)
    expect(out.length).toBe(original.length)
    expect(readDpi(out)).toBe(300)
  })

  it('inserts a JFIF segment when the file has none', () => {
    const out = setJpegDpi(makeJpeg(false), 300)
    expect(readDpi(out)).toBe(300)
    expect(out[0]).toBe(0xff)
    expect(out[1]).toBe(0xd8)
  })

  it('rejects input that is not a JPEG', () => {
    expect(() => setJpegDpi(new Uint8Array([1, 2, 3]), 300)).toThrow(/Not a JPEG/)
  })
})

describe('readDpi', () => {
  it('returns null for an unrecognised format', () => {
    expect(readDpi(new Uint8Array([0, 1, 2, 3]))).toBeNull()
  })
})
