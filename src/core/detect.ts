/**
 * Automatic landmark detection.
 *
 * The geometry engine needs exactly three points: CROWN, CHIN and EYES. Two of
 * them fall straight out of a face mesh. The third does not, and that is the
 * interesting problem this module solves.
 *
 *   CHIN  landmark 152, the menton. Unambiguous.
 *   EYES  midpoint of the two iris centres (468 and 473, present only when the
 *         model is the iris-refined 478-point variant). The pupil line is what
 *         every passport spec measures from, so eye *corners* are not good
 *         enough — they sit a few millimetres off and that error scales
 *         straight into the crop.
 *   CROWN not in the mesh at all. The face mesh stops at the hairline;
 *         landmark 10 is roughly the top of the forehead. Every spec means the
 *         top of the *head including hair*, which for a tall hairstyle can be
 *         several centimetres above landmark 10 and for a bald head is barely
 *         above it. A fixed ratio from landmark 10 is therefore wrong in a way
 *         that varies per person — the worst kind of wrong, because it looks
 *         plausible.
 *
 * So the crown comes from the segmentation mask: start at the forehead, walk
 * upward along the chin->forehead axis, and keep going while the subject mask
 * still says "this is the person". Where it stops is the top of the hair.
 *
 * If segmentation is unavailable we fall back to extrapolating from landmark 10
 * and report `source: 'partial'`, which the UI turns into "check the crown pin"
 * rather than silently shipping a mismeasured head.
 *
 * As with segment.ts, the pure geometry is exported separately from the
 * MediaPipe plumbing and is unit-tested; MediaPipe itself cannot run under
 * vitest.
 */

import type { FaceLandmarker } from '@mediapipe/tasks-vision'
import type { LoadedImage } from '../lib/loadImage'
import { distance, type Landmarks, type Point } from './geometry'
import {
  MODEL_DIR,
  WASM_DIR,
  isPlausiblePersonMask,
  resolveModelUrl,
  sampleMask,
  segmentPerson,
} from './segment'
import { clamp, radToDeg } from './units'

export const FACE_MODEL = `${MODEL_DIR}/face_landmarker.task`

/**
 * Indices into MediaPipe's 478-point face mesh.
 *
 * The two iris entries only exist on the refined model. `eyeOuterA/B` are the
 * outer eye corners, used as a degraded fallback if a 468-point mesh ever turns
 * up: the midpoint of the outer corners is within a couple of millimetres of
 * the pupil midpoint on a frontal face, and the line between them has the same
 * roll. It is not as good, and `mapFaceAnchors` reports which was used.
 */
export const FACE_LANDMARK = {
  chin: 152,
  foreheadTop: 10,
  irisA: 468,
  irisB: 473,
  eyeOuterA: 33,
  eyeOuterB: 263,
} as const

/** Number of points the iris-refined mesh returns. */
export const REFINED_LANDMARK_COUNT = 478

export interface FaceAnchors {
  chin: Point
  /** Landmark 10 — top of the forehead, at or just below the hairline. */
  foreheadTop: Point
  /** Iris centres (or eye corners), ordered left-to-right in image space. */
  eyeLeft: Point
  eyeRight: Point
  /** Midpoint of the two, i.e. the pupil line. */
  eyes: Point
  /** False when the mesh lacked iris points and eye corners were used. */
  irisRefined: boolean
}

export interface DetectionResult {
  landmarks: Landmarks
  /** Head roll in degrees, clockwise positive in screen coordinates. */
  rollDeg: number
  /** 0-1 plausibility of the detection. See `scoreDetection`. */
  confidence: number
  /**
   * 'detected' — crown measured from the segmentation mask.
   * 'partial'  — crown estimated; the UI should ask the user to check the pin.
   */
  source: 'detected' | 'partial'
  /** Why the result is partial, for the message the UI shows. */
  note?: string
}

// ---------------------------------------------------------------------------
// Pure geometry
// ---------------------------------------------------------------------------

/**
 * Convert MediaPipe's normalised landmarks into the source-image pixel
 * coordinates the rest of the app works in, and pull out the points we care
 * about.
 *
 * Returns null rather than throwing when the mesh is too short to be usable —
 * a caller that gets a malformed result should fall back, not crash.
 */
export function mapFaceAnchors(
  points: ReadonlyArray<{ x: number; y: number }>,
  width: number,
  height: number,
): FaceAnchors | null {
  const at = (index: number): Point | null => {
    const p = points[index]
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null
    return { x: p.x * width, y: p.y * height }
  }

  const chin = at(FACE_LANDMARK.chin)
  const foreheadTop = at(FACE_LANDMARK.foreheadTop)
  if (!chin || !foreheadTop) return null

  const irisRefined = points.length >= REFINED_LANDMARK_COUNT
  const a = irisRefined ? at(FACE_LANDMARK.irisA) : at(FACE_LANDMARK.eyeOuterA)
  const b = irisRefined ? at(FACE_LANDMARK.irisB) : at(FACE_LANDMARK.eyeOuterB)
  if (!a || !b) return null

  // Order by x so callers never have to care which mesh index is which side of
  // the face — a detail MediaPipe describes from the subject's point of view,
  // not the image's, and which flips for a mirrored selfie.
  const [eyeLeft, eyeRight] = a.x <= b.x ? [a, b] : [b, a]

  return {
    chin,
    foreheadTop,
    eyeLeft,
    eyeRight,
    eyes: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    irisRefined,
  }
}

/**
 * Head roll from the eye line, in degrees, clockwise positive in screen
 * coordinates (y down). A level head gives 0.
 *
 * Argument order does not matter: the points are sorted by x first, so this is
 * the angle of the *image-left to image-right* eye vector either way.
 *
 * Note this is reported for the UI's benefit. `geometry.computeTransform`
 * derives its own correction from the crown->chin axis, which is the axis the
 * crop is actually built on; the two agree for an upright head and can differ
 * slightly for a head that is both tilted and turned.
 */
export function rollDegFromEyes(a: Point, b: Point): number {
  const [left, right] = a.x <= b.x ? [a, b] : [b, a]
  return radToDeg(Math.atan2(right.y - left.y, right.x - left.x))
}

/**
 * Anthropometric fallback ratio.
 *
 * Standard head measurements put menton-to-vertex (chin to true top of skull)
 * at roughly 1.2x menton-to-trichion (chin to hairline). Landmark 10 sits at
 * about the trichion, so extending the chin->forehead vector by this factor
 * lands near the top of a close-cropped head. It makes no allowance for hair
 * volume, which is precisely why a result built on it is reported as 'partial'.
 */
export const CROWN_EXTRAPOLATION = 1.2

export function extrapolateCrown(
  chin: Point,
  foreheadTop: Point,
  ratio: number = CROWN_EXTRAPOLATION,
): Point {
  return {
    x: chin.x + (foreheadTop.x - chin.x) * ratio,
    y: chin.y + (foreheadTop.y - chin.y) * ratio,
  }
}

export interface CrownWalkOptions {
  /** Mask value above which a pixel counts as subject. */
  threshold?: number
  /** Fraction of the band's samples that must be subject to keep walking. */
  minCoverage?: number
  /** Half-width of the sampling band, as a fraction of chin->forehead length. */
  bandRatio?: number
  /** How far above the forehead to look, as a fraction of chin->forehead. */
  maxTravelRatio?: number
  /** Samples across the band at each step. */
  samples?: number
  /** Step size along the axis, in pixels. */
  stepPx?: number
  /** Consecutive empty steps tolerated before the walk gives up. */
  tolerance?: number
  /**
   * Shortest walk that counts as a real measurement, as a fraction of
   * chin->forehead. Below this the mask is disagreeing with the face and the
   * caller is better off with the anthropometric estimate.
   */
  minTravelRatio?: number
}

export interface CrownWalk {
  crown: Point
  /**
   * True when the walk ended because it ran out of image or out of search
   * range while the subject was still present — i.e. the real crown may be
   * higher than the point returned, typically because the head is cropped at
   * the top of the frame.
   */
  clipped: boolean
  /** Distance travelled above the forehead landmark, in pixels. */
  travelPx: number
}

const DEFAULT_WALK: Required<CrownWalkOptions> = {
  threshold: 0.5,
  // A ponytail or a receding hairline can leave the very top of the head
  // narrow, so demand only that a small part of the band is still subject.
  minCoverage: 0.12,
  // Wide enough to span a full head of hair, narrow enough to miss the
  // shoulders, which sit far below the search region anyway.
  bandRatio: 0.42,
  maxTravelRatio: 0.9,
  samples: 21,
  stepPx: 1,
  tolerance: 4,
  // Even a shaved head has skull above landmark 10; a walk that stops
  // immediately means the mask is wrong, not that the head ends there.
  minTravelRatio: 0.05,
}

/**
 * Walk the subject mask upward from the forehead to find the top of the hair.
 *
 * The walk follows the chin->forehead axis rather than straight up, so a tilted
 * head is measured along its own axis — the same axis `geometry.ts` builds the
 * crop on. At each step it samples a band perpendicular to that axis and asks
 * what fraction of it is subject. The last step where enough of the band is
 * still subject is the crown.
 *
 * A short tolerance run guards against the model punching a small hole through
 * thin hair, which otherwise stops the walk a centimetre early.
 *
 * `mask` is expected in source-image pixel coordinates; `segmentPerson`
 * guarantees that.
 */
export function crownFromMask(
  mask: ArrayLike<number>,
  maskWidth: number,
  maskHeight: number,
  chin: Point,
  foreheadTop: Point,
  options: CrownWalkOptions = {},
): CrownWalk | null {
  const o = { ...DEFAULT_WALK, ...options }
  const faceLen = distance(chin, foreheadTop)
  if (!(faceLen > 1)) return null

  // Unit vector pointing up the head, from chin towards forehead.
  const ux = (foreheadTop.x - chin.x) / faceLen
  const uy = (foreheadTop.y - chin.y) / faceLen
  // Perpendicular, i.e. across the head.
  const px = -uy
  const py = ux

  const halfWidth = o.bandRatio * faceLen
  const maxTravel = o.maxTravelRatio * faceLen
  const samples = Math.max(3, Math.round(o.samples))
  const step = Math.max(0.25, o.stepPx)

  const coverageAt = (travel: number): number => {
    const cx = foreheadTop.x + ux * travel
    const cy = foreheadTop.y + uy * travel
    let hits = 0
    for (let s = 0; s < samples; s++) {
      // -1 .. +1 across the band.
      const t = (2 * s) / (samples - 1) - 1
      const x = cx + px * t * halfWidth
      const y = cy + py * t * halfWidth
      if (sampleMask(mask, maskWidth, maskHeight, x, y) >= o.threshold) hits++
    }
    return hits / samples
  }

  // If the mask does not even cover the forehead the segmentation disagrees
  // with the face detection; trusting it to find the crown would be worse than
  // admitting we do not know.
  if (coverageAt(0) < o.minCoverage) return null

  let lastGood = 0
  let misses = 0
  // Assume we ran out of room until we actually see the mask end. Exiting the
  // loop by exhausting `maxTravel` or by leaving the frame both mean the real
  // crown could be higher than what we return.
  let foundTop = false

  for (let travel = step; travel <= maxTravel; travel += step) {
    const cx = foreheadTop.x + ux * travel
    const cy = foreheadTop.y + uy * travel
    if (cx < 0 || cy < 0 || cx >= maskWidth || cy >= maskHeight) break

    if (coverageAt(travel) >= o.minCoverage) {
      lastGood = travel
      misses = 0
    } else if (++misses > o.tolerance) {
      // Genuinely past the top of the head.
      foundTop = true
      break
    }
  }

  if (lastGood < o.minTravelRatio * faceLen) return null

  return {
    crown: { x: foreheadTop.x + ux * lastGood, y: foreheadTop.y + uy * lastGood },
    clipped: !foundTop,
    travelPx: lastGood,
  }
}

/**
 * A 0-1 plausibility score for a detection.
 *
 * MediaPipe's FaceLandmarker API does not expose the detector's own confidence
 * (it only surfaces landmarks, blendshapes and a transform matrix), so this is
 * an honest geometric heuristic rather than a model score, and it is named for
 * what it is. It answers: is the face big enough to crop from, is it facing the
 * camera, and is it fully inside the frame — the three things that actually
 * make a passport photo unusable.
 */
export function scoreDetection(anchors: FaceAnchors, width: number, height: number): number {
  const faceLen = distance(anchors.chin, anchors.foreheadTop)
  if (!(faceLen > 0)) return 0

  // A face smaller than ~15% of the short edge cannot supply enough pixels for
  // a 300 DPI print, whatever the detector thinks.
  const sizeScore = clamp(faceLen / (0.15 * Math.min(width, height)), 0, 1)

  // Interocular distance is about 0.45 of chin-to-hairline on a frontal face
  // and shrinks as the head turns, so this doubles as a "looking at the camera"
  // test — which is a hard requirement of every spec here.
  const eyeSpan = distance(anchors.eyeLeft, anchors.eyeRight)
  const frontality = clamp(1 - Math.abs(eyeSpan / faceLen - 0.45) / 0.3, 0, 1)

  const inFrame = [anchors.chin, anchors.foreheadTop, anchors.eyeLeft, anchors.eyeRight].filter(
    (p) => p.x >= 0 && p.y >= 0 && p.x < width && p.y < height,
  ).length
  const frameScore = inFrame / 4

  return clamp(0.35 * sizeScore + 0.45 * frontality + 0.2 * frameScore, 0, 1)
}

/** Assemble the three landmarks the geometry engine wants. */
export function toLandmarks(anchors: FaceAnchors, crown: Point): Landmarks {
  return { crown, chin: anchors.chin, eyes: anchors.eyes }
}

// ---------------------------------------------------------------------------
// MediaPipe: lazily loaded, cached, same-origin
// ---------------------------------------------------------------------------

let landmarkerPromise: Promise<FaceLandmarker> | null = null

/**
 * Create the face landmarker once, on first use.
 *
 * `import()` rather than a static import keeps the ~11 MB WASM runtime and the
 * MediaPipe bundle out of the initial page load — a user who places the pins by
 * hand never downloads it — and keeps this module importable under vitest,
 * where the bundle's browser globals do not exist.
 *
 * A note on threading: MediaPipe can run in a worker with OffscreenCanvas, and
 * that would be the right home for a multi-second inference. It is not done
 * here because the worker entry point would have to be its own module and the
 * one-file-per-concern boundary for this change does not include it. Inference
 * therefore blocks the main thread for the duration; `detectFace` yields a frame
 * before starting so the UI can paint a spinner first. Moving this into a
 * worker is the obvious follow-up.
 */
async function getLandmarker(): Promise<FaceLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await import('@mediapipe/tasks-vision')
      const fileset = await vision.FilesetResolver.forVisionTasks(resolveModelUrl(WASM_DIR))
      return vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: resolveModelUrl(FACE_MODEL),
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        numFaces: 1,
        outputFaceBlendshapes: false,
        outputFacialTransformationMatrixes: false,
      })
    })().catch((error: unknown) => {
      landmarkerPromise = null
      throw error
    })
  }
  return landmarkerPromise
}

/**
 * Let the browser paint before we monopolise the main thread.
 *
 * The timeout is not a nicety, it is the correctness guarantee. Browsers do not
 * fire requestAnimationFrame in a hidden tab, so waiting on rAF alone hangs
 * forever the moment a user switches tabs while their photo is being analysed —
 * which is exactly what people do while waiting. Whichever fires first wins, and
 * `settled` keeps the promise from resolving twice.
 */
function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(finish)
    setTimeout(finish, 50)
  })
}

/**
 * Detect the face and produce a complete set of landmarks in source-image pixel
 * coordinates.
 *
 * Returns null when there is no usable face — no detection, or a mesh too
 * degenerate to map. The caller keeps `defaultPlacement` in that case, so
 * detection is always an enhancement and never a prerequisite.
 */
export async function detectFace(image: LoadedImage): Promise<DetectionResult | null> {
  let anchors: FaceAnchors | null = null

  try {
    const landmarker = await getLandmarker()
    await nextFrame()
    const result = landmarker.detect(image.bitmap)
    const face = result.faceLandmarks[0]
    if (!face || face.length === 0) return null
    anchors = mapFaceAnchors(face, image.width, image.height)
  } catch (error) {
    console.warn('Face detection unavailable:', error)
    return null
  }

  if (!anchors) return null

  const rollDeg = rollDegFromEyes(anchors.eyeLeft, anchors.eyeRight)
  const base = scoreDetection(anchors, image.width, image.height)

  // The crown is the whole reason this module talks to the segmenter.
  //
  // The plausibility guard matters here as much as it does before compositing.
  // An empty mask is caught downstream by crownFromMask's own coverage check,
  // but a mask that swallowed the WHOLE FRAME is not: coverage is 1.0
  // everywhere, so the walk runs to its travel limit and puts the crown roughly
  // 4.5x too high. That inflates the measured head length, zooms the crop out by
  // the same factor, and prints a face far too small — reported to the user as
  // nothing worse than "check the crown pin".
  const person = await segmentPerson(image)
  if (person && isPlausiblePersonMask(person)) {
    const walk = crownFromMask(
      person.mask,
      person.width,
      person.height,
      anchors.chin,
      anchors.foreheadTop,
    )
    if (walk) {
      return {
        landmarks: toLandmarks(anchors, walk.crown),
        rollDeg,
        confidence: clamp(base * (walk.clipped ? 0.8 : 1), 0, 1),
        source: walk.clipped ? 'partial' : 'detected',
        note: walk.clipped
          ? 'The top of the head may be outside the photo — check the crown pin.'
          : undefined,
      }
    }
  }

  // No mask, or a mask that disagrees with the face. Estimate and say so.
  return {
    landmarks: toLandmarks(anchors, extrapolateCrown(anchors.chin, anchors.foreheadTop)),
    rollDeg,
    confidence: clamp(base * 0.75, 0, 1),
    source: 'partial',
    note: 'The crown is estimated and does not account for hair volume — check the crown pin.',
  }
}

/** Release the landmarker and its WASM heap. Safe to call when idle. */
export async function disposeDetector(): Promise<void> {
  const pending = landmarkerPromise
  landmarkerPromise = null
  if (!pending) return
  try {
    ;(await pending).close()
  } catch {
    // Already torn down, or never finished loading.
  }
}
