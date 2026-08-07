/**
 * Physical resolution metadata for exported images.
 *
 * Canvas `toBlob` produces a file with pixel dimensions but no statement of how
 * large those pixels are meant to be. Print dialogs and photo labs then fall
 * back to "fit to paper", which silently rescales the sheet — and a 2x2in photo
 * printed at 1.9in fails every automated check at the passport office.
 *
 * These helpers patch the density fields so the file declares its real size:
 *   PNG   a pHYs chunk (pixels per metre)
 *   JPEG  the JFIF APP0 density fields (dots per inch)
 *
 * Both operate on raw bytes, so they are testable without a DOM.
 */

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const METRES_PER_INCH = 0.0254

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((b, i) => bytes[i] === b)
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0xd8
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  )
}

function writeU32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff
  bytes[offset + 1] = (value >>> 16) & 0xff
  bytes[offset + 2] = (value >>> 8) & 0xff
  bytes[offset + 3] = value & 0xff
}

function chunkType(bytes: Uint8Array, offset: number): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  )
}

/** Build a complete pHYs chunk (length + type + data + CRC). */
function buildPhysChunk(dpi: number): Uint8Array {
  const ppm = Math.round(dpi / METRES_PER_INCH)
  const chunk = new Uint8Array(21) // 4 length + 4 type + 9 data + 4 crc
  writeU32(chunk, 0, 9)
  chunk.set([0x70, 0x48, 0x59, 0x73], 4) // 'pHYs'
  writeU32(chunk, 8, ppm)
  writeU32(chunk, 12, ppm)
  chunk[16] = 1 // unit specifier: metre
  writeU32(chunk, 17, crc32(chunk.subarray(4, 17)))
  return chunk
}

/**
 * Insert or replace the pHYs chunk in a PNG.
 * pHYs must appear before the first IDAT, so we place it directly after IHDR.
 */
export function setPngDpi(bytes: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  if (!isPng(bytes)) throw new Error('Not a PNG')

  const phys = buildPhysChunk(dpi)
  let offset = 8 // past the signature
  let insertAt = -1

  while (offset + 8 <= bytes.length) {
    const length = readU32(bytes, offset)
    const type = chunkType(bytes, offset + 4)
    const total = 12 + length

    if (type === 'IHDR') insertAt = offset + total
    if (type === 'pHYs') {
      // Replace in place; the chunk is a fixed size so the layout is unchanged.
      const out = new Uint8Array(bytes.length)
      out.set(bytes)
      out.set(phys, offset)
      return out
    }
    if (type === 'IDAT' || type === 'IEND') break
    offset += total
  }

  if (insertAt < 0) throw new Error('PNG has no IHDR chunk')

  const out = new Uint8Array(bytes.length + phys.length)
  out.set(bytes.subarray(0, insertAt), 0)
  out.set(phys, insertAt)
  out.set(bytes.subarray(insertAt), insertAt + phys.length)
  return out
}

/**
 * Set the JFIF density fields in a JPEG.
 * Browsers emit a JFIF APP0 with units=0 (aspect ratio only), so this is
 * normally an in-place patch; a JPEG without one gets a segment inserted.
 */
export function setJpegDpi(bytes: Uint8Array, dpi: number): Uint8Array<ArrayBuffer> {
  if (!isJpeg(bytes)) throw new Error('Not a JPEG')

  const density = Math.round(dpi)
  const isJfifApp0 = (at: number) =>
    bytes[at] === 0xff &&
    bytes[at + 1] === 0xe0 &&
    bytes[at + 4] === 0x4a && // J
    bytes[at + 5] === 0x46 && // F
    bytes[at + 6] === 0x49 && // I
    bytes[at + 7] === 0x46 && // F
    bytes[at + 8] === 0x00

  if (isJfifApp0(2)) {
    const out = new Uint8Array(bytes.length)
    out.set(bytes)
    out[13] = 1 // units: dots per inch
    out[14] = (density >> 8) & 0xff
    out[15] = density & 0xff
    out[16] = (density >> 8) & 0xff
    out[17] = density & 0xff
    return out
  }

  // No JFIF header — build a minimal one and splice it in after SOI.
  const app0 = new Uint8Array([
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, // 'JFIF\0'
    0x01, 0x02, // version 1.02
    0x01, // units: dpi
    (density >> 8) & 0xff, density & 0xff,
    (density >> 8) & 0xff, density & 0xff,
    0x00, 0x00, // no thumbnail
  ])
  const out = new Uint8Array(bytes.length + app0.length)
  out.set(bytes.subarray(0, 2), 0)
  out.set(app0, 2)
  out.set(bytes.subarray(2), 2 + app0.length)
  return out
}

/** Read back the declared DPI, or null if the file does not declare one. */
export function readDpi(bytes: Uint8Array): number | null {
  if (isPng(bytes)) {
    let offset = 8
    while (offset + 8 <= bytes.length) {
      const length = readU32(bytes, offset)
      const type = chunkType(bytes, offset + 4)
      if (type === 'pHYs') {
        if (bytes[offset + 16] !== 1) return null // not metre-based
        return readU32(bytes, offset + 8) * METRES_PER_INCH
      }
      if (type === 'IEND') break
      offset += 12 + length
    }
    return null
  }

  if (isJpeg(bytes)) {
    // APP0 marker at 2-3, length at 4-5, 'JFIF\0' at 6-10, version at 11-12,
    // units at 13, X/Y density at 14-17.
    if (
      bytes[2] === 0xff &&
      bytes[3] === 0xe0 &&
      bytes[6] === 0x4a &&
      bytes[7] === 0x46 &&
      bytes[13] === 1
    ) {
      return (bytes[14]! << 8) | bytes[15]!
    }
    return null
  }

  return null
}

/** Patch whichever format the blob happens to be, returning a new Blob. */
export async function withDpi(blob: Blob, dpi: number): Promise<Blob> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  if (isPng(bytes)) return new Blob([setPngDpi(bytes, dpi)], { type: 'image/png' })
  if (isJpeg(bytes)) return new Blob([setJpegDpi(bytes, dpi)], { type: 'image/jpeg' })
  return blob
}
