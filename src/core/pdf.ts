/**
 * A single-page PDF wrapper for an exported sheet.
 *
 * Why this exists alongside `encode.ts`: a PNG's pHYs chunk is *advisory*. It
 * states a physical resolution and hopes the consumer honours it, and Chrome's
 * print preview, most phone print paths and most photo-lab kiosks do not — they
 * scale the bitmap to the paper and hand back a sheet whose photos are the
 * wrong size by a percent or two, which is exactly what a template gauge at a
 * passport office catches.
 *
 * A PDF states its page size in `/MediaBox`, in PostScript points (72 to the
 * inch), and that is not a hint. "Actual size" in any viewer means this box.
 * So the sheet stops depending on the print path getting the DPI right: at 300
 * DPI a 1200x1800 px sheet declares a 288x432 pt page, and it prints 4x6 in.
 *
 * The image is embedded as a `/DCTDecode` XObject, which means the JPEG bytes
 * are stored *verbatim* — this module compresses nothing and decodes nothing,
 * it is assembly. That is also why there is no dependency: the hard part
 * (JPEG encoding) was already done by the canvas.
 *
 * The tradeoff is that the payload must be JPEG. PDF cannot carry PNG bytes
 * directly — its `FlateDecode` wants raw zlib over unfiltered samples, whereas
 * a PNG applies a per-scanline filter and canvas emits colour-type-6 RGBA. So
 * the PDF path is lossy where the PNG path is not; at high quality that is
 * invisible in a 300 DPI print, and the PNG export stays available for anyone
 * who would rather have the lossless file.
 *
 * No Info dictionary is written: no producer string, no creation date. A
 * timestamp in a file the user is about to hand to a print shop is metadata
 * this app has no reason to author.
 *
 * Pure byte arithmetic, no DOM, so it is unit-tested the same way `encode.ts`
 * is.
 */

/** PostScript points per inch. Fixed by the PDF spec, not a preference. */
const POINTS_PER_INCH = 72

export interface PdfSheet {
  /** Baseline JPEG bytes, as `canvas.toBlob('image/jpeg')` produces them. */
  jpeg: Uint8Array
  /** Pixel dimensions of that JPEG. */
  widthPx: number
  heightPx: number
  /** Physical resolution those pixels are meant to print at. */
  dpi: number
}

function ascii(text: string): Uint8Array {
  const bytes = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff
  return bytes
}

/**
 * Numbers in a PDF are plain decimals — no exponent form, which a strict parser
 * is entitled to reject and which `String(1e-7)` would happily produce. Two
 * decimal places is a hundredth of a point, far finer than any printer.
 */
function num(value: number): string {
  return String(Number(value.toFixed(2)))
}

/** An xref entry is exactly 20 bytes, including the trailing space and newline. */
function xrefEntry(offset: number, generation: number, kind: 'n' | 'f'): string {
  return `${String(offset).padStart(10, '0')} ${String(generation).padStart(5, '0')} ${kind} \n`
}

/**
 * Wrap a JPEG in a one-page PDF whose page is exactly the image's physical size.
 *
 * Throws on input that is not a JPEG. A PDF built around bytes that no viewer
 * can decode opens as a blank page, and a blank page that the user only
 * discovers at the print shop is worse than a failed export.
 */
export function buildPdf(sheet: PdfSheet): Uint8Array<ArrayBuffer> {
  const { jpeg, widthPx, heightPx, dpi } = sheet

  if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw new Error('Not a JPEG')
  if (!(widthPx > 0) || !(heightPx > 0)) throw new Error('Sheet has no pixel dimensions')
  if (!(dpi > 0)) throw new Error('Sheet has no DPI')

  const pageWidth = (widthPx / dpi) * POINTS_PER_INCH
  const pageHeight = (heightPx / dpi) * POINTS_PER_INCH

  // The image XObject is drawn into the unit square, so the CTM *is* the page
  // size. `q`/`Q` bracket it out of habit rather than necessity — there is
  // nothing after it, but a content stream that leaks its transform is the kind
  // of thing that breaks the moment someone adds a second drawing operation.
  const content = `q\n${num(pageWidth)} 0 0 ${num(pageHeight)} 0 0 cm\n/Im0 Do\nQ\n`

  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R ' +
      `/MediaBox [0 0 ${num(pageWidth)} ${num(pageHeight)}] ` +
      '/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>`,
    '<< /Type /XObject /Subtype /Image ' +
      // Pixels here, points in the MediaBox. Confusing the two is the mistake
      // this format invites: the page would be right and the image tiny.
      `/Width ${widthPx} /Height ${heightPx} ` +
      '/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode ' +
      `/Length ${jpeg.length} >>`,
  ]

  const parts: Uint8Array[] = []
  let cursor = 0
  const emit = (chunk: Uint8Array | string): void => {
    const bytes = typeof chunk === 'string' ? ascii(chunk) : chunk
    parts.push(bytes)
    cursor += bytes.length
  }

  emit('%PDF-1.4\n')
  // Four high bytes in a comment. Tells anything that sniffs the file — version
  // control, transfer tools — to treat it as binary rather than mangling line
  // endings in the JPEG payload.
  emit(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]))

  // Byte offset of each object, indexed from 1 to match its object number.
  const offsets: number[] = [0]

  objects.forEach((dictionary, index) => {
    const id = index + 1
    offsets[id] = cursor
    emit(`${id} 0 obj\n${dictionary}\n`)

    // `/Length` counts the data only. The newline before `endstream` is the
    // separator the spec asks for and sits outside the count, which is why it
    // is emitted here rather than baked into `content`.
    if (id === 4) emit(`stream\n${content}\nendstream\n`)
    if (id === 5) {
      emit('stream\n')
      emit(jpeg)
      emit('\nendstream\n')
    }

    emit('endobj\n')
  })

  const xrefOffset = cursor
  emit(`xref\n0 ${objects.length + 1}\n`)
  emit(xrefEntry(0, 65535, 'f'))
  for (let id = 1; id <= objects.length; id++) emit(xrefEntry(offsets[id]!, 0, 'n'))

  emit(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`)
  emit(`startxref\n${xrefOffset}\n%%EOF\n`)

  const out = new Uint8Array(cursor)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

/** Page size the built PDF will declare, in points. Exposed for the UI readout. */
export function pdfPageSize(widthPx: number, heightPx: number, dpi: number): {
  widthPt: number
  heightPt: number
} {
  return {
    widthPt: (widthPx / dpi) * POINTS_PER_INCH,
    heightPt: (heightPx / dpi) * POINTS_PER_INCH,
  }
}
