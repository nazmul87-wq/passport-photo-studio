/**
 * Person segmentation and background replacement.
 *
 * Two responsibilities, deliberately kept in one module because they share an
 * expensive resource:
 *
 *   1. Run MediaPipe's selfie segmenter over the source image and hand back a
 *      per-pixel "is this the subject" mask. `detect.ts` uses that mask to find
 *      the top of the hair, and the background feature uses it to replace the
 *      backdrop — so the result is cached per image and both callers share one
 *      inference pass.
 *
 *   2. Composite the subject onto a flat background colour, with a *feathered*
 *      edge. This is the part that decides whether the output looks like a
 *      photograph or like a cut-out. A raw segmentation mask is a hard binary
 *      edge; pasted over a flat colour it produces the jagged, aliased halo
 *      around hair that any passport officer recognises instantly. Blurring the
 *      alpha slightly and then applying a gamma to pull the soft edge back
 *      towards the subject gives a matte that survives print.
 *
 * Everything below the "pure helpers" heading is plain arithmetic over plain
 * arrays: no DOM, no WASM, no model. That is where the interesting logic lives
 * and it is unit-tested in segment.test.ts. The two functions that genuinely
 * need a browser — `segmentPerson` and `compositeOnBackground` — are thin.
 *
 * PRIVACY: every asset this module loads is same-origin. See
 * scripts/vendor-models.mjs. `resolveModelUrl` actively refuses absolute URLs so
 * that a future edit cannot quietly reintroduce a CDN fetch.
 */

import type { ImageSegmenter, MPMask } from '@mediapipe/tasks-vision'
import type { LoadedImage } from '../lib/loadImage'
import type { BackgroundRule } from './specs'
import { clamp } from './units'

/** A subject mask in source-image pixel coordinates, values in [0, 1]. */
export interface PersonMask {
  /** Row-major, `width * height` entries. 1 = subject, 0 = background. */
  mask: Float32Array
  width: number
  height: number
  /** The segmenter's own quality score, if the model reported one. */
  quality: number
}

/** Directory the vendored assets live in, relative to the app's base URL. */
export const MODEL_DIR = 'models'
export const SEGMENTER_MODEL = `${MODEL_DIR}/selfie_segmenter.tflite`
export const WASM_DIR = `${MODEL_DIR}/wasm`

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a vendored asset to a same-origin URL.
 *
 * The app deploys under a GitHub Pages subpath, so a leading `/models/...`
 * would 404 in production while working perfectly in dev — exactly the class of
 * bug that only shows up after deploy. Everything goes through Vite's
 * `BASE_URL`.
 *
 * Absolute URLs are rejected rather than passed through. The no-network promise
 * is the product; making it a hard error to break it is cheap insurance.
 *
 * BOTH halves are checked, not just the filename. Vite supports an absolute
 * `base` for CDN deployments, so `VITE_BASE=https://cdn.example.com/` would turn
 * every model and WASM URL remote while a filename-only guard stayed silent —
 * the precise regression this function exists to prevent, walking in through the
 * door it was not watching.
 */
const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:/i

function assertRelative(part: string, what: string): void {
  if (ABSOLUTE_URL.test(part) || part.startsWith('//')) {
    throw new Error(
      `Model assets must be same-origin; refusing to load ${what} "${part}". ` +
        'Vendor it into public/models with scripts/vendor-models.mjs.',
    )
  }
}

export function resolveModelUrl(file: string, base?: string): string {
  assertRelative(file, 'asset')
  const root = base ?? import.meta.env.BASE_URL ?? '/'
  assertRelative(root, 'base path')
  return `${root.replace(/\/+$/, '')}/${file.replace(/^\/+/, '')}`
}

/**
 * Bring a mask to [0, 1] floats regardless of how MediaPipe handed it over.
 * Confidence masks arrive as Float32Array already in range; category masks
 * arrive as bytes.
 */
export function normalizeMask(mask: Float32Array | Uint8Array | Uint8ClampedArray): Float32Array {
  const out = new Float32Array(mask.length)
  if (mask instanceof Float32Array) {
    for (let i = 0; i < mask.length; i++) out[i] = clamp(mask[i]!, 0, 1)
  } else {
    for (let i = 0; i < mask.length; i++) out[i] = mask[i]! / 255
  }
  return out
}

/**
 * Bilinear resample of a single-channel mask.
 *
 * MediaPipe normally returns masks at input resolution, but it is not
 * contractual and the model works internally at 256x256. Resampling here means
 * every consumer downstream can assume mask coordinates *are* image
 * coordinates, which removes a whole category of off-by-a-scale-factor bug.
 */
export function resampleMask(
  src: ArrayLike<number>,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number,
): Float32Array {
  if (srcWidth === dstWidth && srcHeight === dstHeight) {
    const copy = new Float32Array(src.length)
    for (let i = 0; i < src.length; i++) copy[i] = src[i]!
    return copy
  }

  const out = new Float32Array(dstWidth * dstHeight)
  // Map destination pixel centres into source space, so a 2x upscale
  // interpolates rather than replicating the top-left sample.
  const sx = srcWidth / dstWidth
  const sy = srcHeight / dstHeight

  for (let y = 0; y < dstHeight; y++) {
    const fy = clamp((y + 0.5) * sy - 0.5, 0, srcHeight - 1)
    const y0 = Math.floor(fy)
    const y1 = Math.min(y0 + 1, srcHeight - 1)
    const wy = fy - y0
    for (let x = 0; x < dstWidth; x++) {
      const fx = clamp((x + 0.5) * sx - 0.5, 0, srcWidth - 1)
      const x0 = Math.floor(fx)
      const x1 = Math.min(x0 + 1, srcWidth - 1)
      const wx = fx - x0
      const a = src[y0 * srcWidth + x0]!
      const b = src[y0 * srcWidth + x1]!
      const c = src[y1 * srcWidth + x0]!
      const d = src[y1 * srcWidth + x1]!
      const top = a + (b - a) * wx
      const bottom = c + (d - c) * wx
      out[y * dstWidth + x] = top + (bottom - top) * wy
    }
  }
  return out
}

/**
 * Separable box blur with clamped edges.
 *
 * Two or three box passes approximate a Gaussian closely enough for an alpha
 * matte, at a fraction of the cost — and cost matters here because the mask is
 * the size of a 12-megapixel phone photo.
 */
export function boxBlur(
  src: Float32Array,
  width: number,
  height: number,
  radius: number,
): Float32Array {
  const r = Math.max(0, Math.floor(radius))
  if (r === 0) return Float32Array.from(src)

  const window = 2 * r + 1
  const horizontal = new Float32Array(src.length)

  for (let y = 0; y < height; y++) {
    const row = y * width
    // Prime the running sum with the clamped left edge repeated r times.
    let sum = src[row]! * r
    for (let x = 0; x <= r; x++) sum += src[row + Math.min(x, width - 1)]!
    for (let x = 0; x < width; x++) {
      horizontal[row + x] = sum / window
      const outgoing = src[row + clamp(x - r, 0, width - 1)]!
      const incoming = src[row + clamp(x + r + 1, 0, width - 1)]!
      sum += incoming - outgoing
    }
  }

  const out = new Float32Array(src.length)
  for (let x = 0; x < width; x++) {
    let sum = horizontal[x]! * r
    for (let y = 0; y <= r; y++) sum += horizontal[Math.min(y, height - 1) * width + x]!
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / window
      const outgoing = horizontal[clamp(y - r, 0, height - 1) * width + x]!
      const incoming = horizontal[clamp(y + r + 1, 0, height - 1) * width + x]!
      sum += incoming - outgoing
    }
  }
  return out
}

export interface FeatherOptions {
  /**
   * Blur radius for the alpha edge, in source pixels. Defaults to a fraction of
   * the image size so a 1000 px and a 4000 px photo feather by the same
   * *physical* amount rather than the same pixel count.
   */
  featherPx?: number
  /**
   * Exponent applied to the blurred alpha. Above 1 pulls the soft edge inward,
   * eating the halo of background colour that segmenters leave around hair;
   * below 1 pushes it outward and keeps more stray strands. 1 leaves the blur
   * symmetric.
   */
  gamma?: number
  /**
   * How completely to replace the background. 1 is a full replacement, 0 leaves
   * the original photo untouched. Anything in between is a partial clean-up,
   * which is often the honest choice for a busy backdrop that the segmenter is
   * not confident about.
   */
  strength?: number
  /** Number of box-blur passes used to approximate a Gaussian. */
  passes?: number
}

/** Feather radius scaled to the image, clamped to something sane. */
export function defaultFeatherPx(width: number, height: number): number {
  return clamp(Math.round(Math.min(width, height) * 0.0035), 1, 12)
}

export const DEFAULT_FEATHER: Required<Omit<FeatherOptions, 'featherPx'>> = {
  gamma: 1.2,
  strength: 1,
  passes: 2,
}

/**
 * Turn a raw subject mask into the alpha channel used for compositing.
 *
 * normalize -> blur -> gamma -> strength. The order matters: gamma has to act
 * on the *blurred* edge (that is the whole point, it reshapes the ramp), and
 * strength is a final global dial that must not be reshaped by gamma.
 */
export function featherAlpha(
  mask: Float32Array | Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: FeatherOptions = {},
): Float32Array {
  const featherPx = options.featherPx ?? defaultFeatherPx(width, height)
  const gamma = options.gamma ?? DEFAULT_FEATHER.gamma
  const strength = clamp(options.strength ?? DEFAULT_FEATHER.strength, 0, 1)
  const passes = Math.max(0, Math.round(options.passes ?? DEFAULT_FEATHER.passes))

  let alpha = normalizeMask(mask)
  if (featherPx > 0 && passes > 0) {
    // Splitting the radius across passes keeps the total spread close to
    // `featherPx` instead of multiplying it by the pass count.
    const perPass = Math.max(1, Math.round(featherPx / Math.sqrt(passes)))
    for (let p = 0; p < passes; p++) alpha = boxBlur(alpha, width, height, perPass)
  }

  if (gamma !== 1) {
    for (let i = 0; i < alpha.length; i++) alpha[i] = Math.pow(alpha[i]!, gamma)
  }
  if (strength !== 1) {
    for (let i = 0; i < alpha.length; i++) alpha[i] = 1 - strength * (1 - alpha[i]!)
  }
  return alpha
}

/**
 * Pick which of the segmenter's confidence masks is the person.
 *
 * The selfie model has been published with one output channel and with two
 * (background, person), and the ordering is a property of the model file rather
 * than of the API. Rather than hardcode an index that silently inverts the
 * matte if the model is ever swapped, ask the data: the subject of a portrait
 * occupies the middle of the frame and not the corners.
 */
export function choosePersonMaskIndex(
  masks: ReadonlyArray<ArrayLike<number>>,
  width: number,
  height: number,
): number {
  if (masks.length <= 1) return 0

  const centreScore = (mask: ArrayLike<number>): number => {
    let centre = 0
    let centreN = 0
    let corner = 0
    let cornerN = 0
    const cx = width / 2
    const cy = height / 2
    // Sample on a coarse grid; full-resolution accuracy buys nothing for a
    // decision between two candidates.
    const step = Math.max(1, Math.floor(Math.min(width, height) / 64))
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const v = mask[y * width + x] ?? 0
        const nx = (x - cx) / (width / 2)
        const ny = (y - cy) / (height / 2)
        if (nx * nx + ny * ny < 0.25) {
          centre += v
          centreN++
        } else if (Math.abs(nx) > 0.8 && Math.abs(ny) > 0.8) {
          corner += v
          cornerN++
        }
      }
    }
    const centreMean = centreN > 0 ? centre / centreN : 0
    const cornerMean = cornerN > 0 ? corner / cornerN : 0
    return centreMean - cornerMean
  }

  let best = 0
  let bestScore = Number.NEGATIVE_INFINITY
  for (let i = 0; i < masks.length; i++) {
    const score = centreScore(masks[i]!)
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  }
  return best
}

/** Fraction of the frame the mask calls subject, 0-1. */
export function maskCoverage(mask: Float32Array, threshold = 0.5): number {
  if (mask.length === 0) return 0
  let on = 0
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]! > threshold) on++
  }
  return on / mask.length
}

/**
 * Lower and upper bounds on how much of a correctly framed head-and-shoulders
 * portrait the subject should occupy.
 *
 * A passport photo is mostly face and shoulders, so anything under ~12% means
 * the segmenter did not find the person, and anything over ~92% means it
 * classified the wall as subject too. Either way the cut-out is unusable.
 */
export const MIN_SUBJECT_COVERAGE = 0.12
export const MAX_SUBJECT_COVERAGE = 0.92

/**
 * Is this mask plausibly a person, judged by coverage rather than the model's
 * own confidence?
 *
 * This exists because the reported `quality` cannot be trusted. On an image the
 * selfie segmenter does not understand it will return quality 1.0 — complete
 * confidence — alongside a mask containing essentially no subject at all.
 * Compositing that produces a blank photo, and a blank photo that looks
 * "successful" is the worst possible outcome here: the user prints six of them.
 * Measuring what the mask actually contains is the only reliable check.
 */
export function isPlausiblePersonMask(mask: PersonMask): boolean {
  const coverage = maskCoverage(mask.mask)
  return coverage >= MIN_SUBJECT_COVERAGE && coverage <= MAX_SUBJECT_COVERAGE
}

/** Nearest-neighbour mask lookup; out-of-bounds reads as background. */
export function sampleMask(
  mask: ArrayLike<number>,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  const ix = Math.round(x)
  const iy = Math.round(y)
  if (ix < 0 || iy < 0 || ix >= width || iy >= height) return 0
  return mask[iy * width + ix] ?? 0
}

export interface Rgb {
  r: number
  g: number
  b: number
}

const NAMED_COLORS: Record<string, Rgb> = {
  white: { r: 255, g: 255, b: 255 },
  black: { r: 0, g: 0, b: 0 },
  grey: { r: 128, g: 128, b: 128 },
  gray: { r: 128, g: 128, b: 128 },
  silver: { r: 192, g: 192, b: 192 },
}

/**
 * Parse the colour strings a spec can carry into channel values.
 *
 * Deliberately not done by round-tripping through a canvas: this has to work in
 * the Node test environment, and every colour any spec actually uses is a hex
 * triple.
 */
export function parseColor(color: string | BackgroundRule): Rgb {
  const value = (typeof color === 'string' ? color : color.color).trim().toLowerCase()

  const named = NAMED_COLORS[value]
  if (named) return named

  const hex = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value)
  if (hex) {
    const digits = hex[1]!
    if (digits.length <= 4) {
      return {
        r: parseInt(digits[0]!.repeat(2), 16),
        g: parseInt(digits[1]!.repeat(2), 16),
        b: parseInt(digits[2]!.repeat(2), 16),
      }
    }
    return {
      r: parseInt(digits.slice(0, 2), 16),
      g: parseInt(digits.slice(2, 4), 16),
      b: parseInt(digits.slice(4, 6), 16),
    }
  }

  const fn = /^rgba?\(([^)]+)\)$/.exec(value)
  if (fn) {
    const parts = fn[1]!.split(/[\s,/]+/).filter(Boolean)
    const channel = (raw: string | undefined): number => {
      if (raw === undefined) return 0
      const n = raw.endsWith('%') ? (parseFloat(raw) / 100) * 255 : parseFloat(raw)
      return Number.isFinite(n) ? clamp(Math.round(n), 0, 255) : 0
    }
    return { r: channel(parts[0]), g: channel(parts[1]), b: channel(parts[2]) }
  }

  throw new Error(`Unsupported background colour: ${String(color)}`)
}

/**
 * sRGB transfer functions.
 *
 * Blending a hair edge against a flat background in sRGB space is blending
 * encoded values, not light, and it darkens the transition — the classic grey
 * fringe around a cut-out. Converting to linear light, mixing there, and
 * converting back costs one lookup per channel and removes the fringe.
 */
export function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

export function linearToSrgb(linear: number): number {
  const c = clamp(linear, 0, 1)
  const encoded = c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
  return encoded * 255
}

/**
 * Blend one channel of subject over background at the given alpha, in linear
 * light. Exported so the composite's core arithmetic is testable without a
 * canvas.
 */
export function blendChannel(
  subject: number,
  background: number,
  alpha: number,
  linear: boolean,
): number {
  const a = clamp(alpha, 0, 1)
  if (!linear) return subject + (background - subject) * (1 - a)
  const s = srgbToLinear(subject)
  const b = srgbToLinear(background)
  return linearToSrgb(s * a + b * (1 - a))
}

// ---------------------------------------------------------------------------
// MediaPipe: lazily loaded, cached, same-origin
// ---------------------------------------------------------------------------

let segmenterPromise: Promise<ImageSegmenter> | null = null

/**
 * Create the segmenter once, on first use.
 *
 * Loading is deliberately lazy: the WASM runtime is ~11 MB and a user who only
 * wants to place the pins by hand should never pay for it. The MediaPipe bundle
 * itself is imported dynamically too, which keeps it out of the app's initial
 * chunk *and* keeps this module importable from the Node test environment,
 * where the bundle's browser globals do not exist.
 */
async function getSegmenter(): Promise<ImageSegmenter> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(resolveModelUrl(WASM_DIR))
      return vision.ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: resolveModelUrl(SEGMENTER_MODEL),
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        outputCategoryMask: false,
        outputConfidenceMasks: true,
      })
    })().catch((error: unknown) => {
      // Do not cache a failure: a transient WebGL context loss on first run
      // should not permanently disable the feature for the session.
      segmenterPromise = null
      throw error
    })
  }
  return segmenterPromise
}

/**
 * One inference per image, shared by every caller.
 *
 * Keyed on the decoded bitmap rather than the LoadedImage wrapper so that
 * re-wrapping the same decode (which the editor does when the filename changes)
 * still hits the cache. A WeakMap means an image the user has replaced becomes
 * collectable along with its mask, which for a 12 MP photo is ~48 MB of
 * Float32Array worth releasing.
 */
const maskCache = new WeakMap<ImageBitmap, Promise<PersonMask | null>>()

function readMask(mpMask: MPMask): Float32Array {
  return mpMask.hasFloat32Array()
    ? Float32Array.from(mpMask.getAsFloat32Array())
    : normalizeMask(mpMask.getAsUint8Array())
}

/**
 * Segment the subject out of the background.
 *
 * Returns null — rather than throwing — when the model or the WASM runtime is
 * unavailable, because every caller has a usable fallback and a failed optional
 * enhancement should never take the editor down with it.
 */
export async function segmentPerson(image: LoadedImage): Promise<PersonMask | null> {
  const cached = maskCache.get(image.bitmap)
  if (cached) return cached

  const run = (async (): Promise<PersonMask | null> => {
    try {
      const segmenter = await getSegmenter()
      const result = segmenter.segment(image.bitmap)
      const confidence = result.confidenceMasks
      if (!confidence || confidence.length === 0) {
        result.close()
        return null
      }

      const width = confidence[0]!.width
      const height = confidence[0]!.height
      const arrays = confidence.map(readMask)
      const index = choosePersonMaskIndex(arrays, width, height)
      const chosen = arrays[index]!
      const quality = result.qualityScores?.[index] ?? 1
      // MediaPipe owns the GPU-backed buffers; release them before the
      // arrays outlive the result object.
      result.close()

      const mask =
        width === image.width && height === image.height
          ? chosen
          : resampleMask(chosen, width, height, image.width, image.height)

      return { mask, width: image.width, height: image.height, quality }
    } catch (error) {
      console.warn('Person segmentation unavailable:', error)
      return null
    }
  })()

  maskCache.set(image.bitmap, run)

  // Cache successes only. `getSegmenter` deliberately avoids caching a failed
  // load so the next call can retry; caching a null result here would undo that
  // one level up. A single transient fault — a lost WebGL context, say — would
  // otherwise disable background replacement and accurate crown detection for
  // that photo for the rest of the session, with no way back except re-uploading
  // the file (which mints a new ImageBitmap, hence a new cache key) and nothing
  // in the UI to suggest it.
  void run.then((result) => {
    if (result === null && maskCache.get(image.bitmap) === run) {
      maskCache.delete(image.bitmap)
    }
  })

  return run
}

export interface CompositeOptions extends FeatherOptions {
  /** Blend in linear light. On by default; see srgbToLinear. */
  linear?: boolean
  /** Reuse an existing canvas instead of allocating a new one. */
  target?: HTMLCanvasElement
}

/**
 * Draw the subject over a flat background colour at source resolution.
 *
 * The output is a canvas the size of the original photo, so it drops straight
 * into `renderPhoto` as an ImageSource — background replacement happens before
 * the crop, and the crop code needs to know nothing about it.
 */
export function compositeOnBackground(
  image: LoadedImage,
  mask: PersonMask,
  color: string | BackgroundRule,
  options: CompositeOptions = {},
): HTMLCanvasElement {
  const { width, height } = image
  const canvas = options.target ?? document.createElement('canvas')
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }

  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })
  if (!ctx) throw new Error('Could not acquire a 2D canvas context')

  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  ctx.drawImage(image.bitmap, 0, 0, width, height)

  const frame = ctx.getImageData(0, 0, width, height)
  const pixels = frame.data

  const aligned =
    mask.width === width && mask.height === height
      ? mask.mask
      : resampleMask(mask.mask, mask.width, mask.height, width, height)
  const alpha = featherAlpha(aligned, width, height, options)

  const bg = parseColor(color)
  const linear = options.linear ?? true

  for (let i = 0, p = 0; i < alpha.length; i++, p += 4) {
    const a = alpha[i]!
    // Fully-inside pixels are the overwhelming majority of a portrait; skipping
    // the blend for them roughly halves the work on a typical photo.
    if (a >= 0.999) continue
    if (a <= 0.001) {
      pixels[p] = bg.r
      pixels[p + 1] = bg.g
      pixels[p + 2] = bg.b
      continue
    }
    pixels[p] = Math.round(blendChannel(pixels[p]!, bg.r, a, linear))
    pixels[p + 1] = Math.round(blendChannel(pixels[p + 1]!, bg.g, a, linear))
    pixels[p + 2] = Math.round(blendChannel(pixels[p + 2]!, bg.b, a, linear))
  }

  ctx.putImageData(frame, 0, 0)
  return canvas
}

/** Release the segmenter and its WASM heap. Safe to call when idle. */
export async function disposeSegmenter(): Promise<void> {
  const pending = segmenterPromise
  segmenterPromise = null
  if (!pending) return
  try {
    ;(await pending).close()
  } catch {
    // Already torn down, or never finished loading. Nothing to release.
  }
}
