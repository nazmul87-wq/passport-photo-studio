/**
 * Image intake.
 *
 * Decoding through `createImageBitmap` with `imageOrientation: 'from-image'`
 * applies the EXIF orientation flag, so a photo shot in portrait on a phone
 * arrives upright instead of lying on its side. Without this the landmarks
 * would be placed on a rotated image and every crop would be wrong.
 */

export interface LoadedImage {
  bitmap: ImageBitmap
  width: number
  height: number
  name: string
}

export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']

export async function loadImageFile(file: File): Promise<LoadedImage> {
  if (file.type && !file.type.startsWith('image/')) {
    throw new Error(`${file.name} is not an image.`)
  }

  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    // Safari historically rejects the options bag; retry without it rather than
    // failing the upload outright.
    bitmap = await createImageBitmap(file)
  }

  return { bitmap, width: bitmap.width, height: bitmap.height, name: file.name }
}

/** Pull the first image out of a drop or paste event, if there is one. */
export function firstImageFile(items: DataTransferItemList | FileList | null): File | null {
  if (!items) return null
  if ('length' in items && !('add' in items)) {
    const files = items as FileList
    for (const file of Array.from(files)) {
      if (file.type.startsWith('image/')) return file
    }
    return null
  }
  for (const item of Array.from(items as DataTransferItemList)) {
    if (item.kind === 'file') {
      const file = item.getAsFile()
      if (file && file.type.startsWith('image/')) return file
    }
  }
  return null
}

/** Trigger a browser download for a blob, then release the object URL. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  // Revoke on the next frame so the download has certainly started.
  requestAnimationFrame(() => URL.revokeObjectURL(url))
}

/** Canvas -> Blob as a promise, since toBlob is callback-based. */
export function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the image.'))),
      type,
      quality,
    )
  })
}
