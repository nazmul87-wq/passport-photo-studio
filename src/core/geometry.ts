/**
 * The crop geometry engine.
 *
 * Everything the app produces is derived from three landmarks placed on the
 * source image and two physical constraints from the spec:
 *
 *   CROWN  top of the hair
 *   CHIN   bottom of the chin
 *   EYES   midpoint between the pupils
 *
 *   head height   chin -> crown, measured along the head axis
 *   eye height    pupil line -> bottom edge of the photo
 *
 * Those two constraints fix the scale and the vertical position of the crop.
 * The head axis fixes the rotation. The result is a single affine transform
 * from source-image space to output-photo space.
 *
 * Coordinate spaces
 *   image space   pixels in the uploaded photo, y down, origin top-left
 *   output space  pixels in the finished photo, y down, origin top-left
 *
 * This module is deliberately free of DOM and React so it can be tested as
 * pure arithmetic.
 */

import { specToPx, type PhotoSpec, specPixelSize } from './specs'
import { clamp, degToRad, radToDeg } from './units'

export interface Point {
  x: number
  y: number
}

export interface Landmarks {
  crown: Point
  chin: Point
  eyes: Point
}

export interface Placement {
  landmarks: Landmarks
  /** Chin-to-crown height, in the spec's unit. */
  headHeight: number
  /** Pupil line above the bottom edge, in the spec's unit. */
  eyeHeight: number
  /**
   * Manual levelling offset in degrees, applied *on top of* the automatic
   * correction derived from the head axis. 0 means "trust the landmarks".
   */
  rollAdjustDeg: number
}

/**
 * A resolved affine map from image space to output space, plus the derived
 * quantities the UI and validator both need. Computed once per state change
 * and passed around, so no one recomputes trigonometry in a render loop.
 */
export interface CropTransform {
  /** Output pixels per source pixel. >1 means upscaling, i.e. losing detail. */
  scale: number
  /** Total rotation applied, radians, clockwise positive in screen coords. */
  angle: number
  /** Automatic component of `angle`, from the head axis. */
  autoAngle: number
  /** Output-space point the EYES landmark maps to. */
  anchor: Point
  /** Image-space rotation origin (the EYES landmark). */
  origin: Point
  outWidth: number
  outHeight: number
  /** Head length in source pixels — the raw resolution the crop is built on. */
  headPxSource: number
  /** Head length in output pixels. */
  headPxOutput: number
  /** True DPI of the print after scaling. Below the spec DPI means upscaling. */
  effectiveDpi: number
  /**
   * Fraction of head height from crown down to the pupil line. A property of
   * the person, not the spec — it is what makes headroom a real constraint
   * rather than something the app can always satisfy.
   */
  eyeRatio: number
  /** Crown to the top edge, in output pixels. Negative means cropped off. */
  headroomPx: number
  /** Chin to the bottom edge, in output pixels. */
  chinToBottomPx: number
}

const EPSILON = 1e-9

export function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** Rotate `p` about the origin by `angle` radians (y-down screen convention). */
export function rotate(p: Point, angle: number): Point {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c }
}

/**
 * The rotation needed to stand the head upright, in radians.
 *
 * Measured as the angle of the crown->chin vector away from straight down, so
 * a perfectly vertical head returns 0 regardless of head size.
 */
export function headAxisAngle(landmarks: Landmarks): number {
  const dx = landmarks.chin.x - landmarks.crown.x
  const dy = landmarks.chin.y - landmarks.crown.y
  return Math.atan2(dx, dy)
}

/** Same, in degrees — what the levelling readout shows. */
export function headTiltDeg(landmarks: Landmarks): number {
  return radToDeg(headAxisAngle(landmarks))
}

/**
 * Resolve a placement into the affine transform and every derived measurement.
 * Pure; safe to call on every pointer move.
 */
export function computeTransform(spec: PhotoSpec, placement: Placement): CropTransform {
  const { landmarks, headHeight, eyeHeight, rollAdjustDeg } = placement
  const { crown, chin, eyes } = landmarks
  const { width: outWidth, height: outHeight } = specPixelSize(spec)

  const headPxSource = Math.max(distance(crown, chin), EPSILON)
  const headPxOutput = specToPx(spec, headHeight)
  const scale = headPxOutput / headPxSource

  const autoAngle = headAxisAngle(landmarks)
  const angle = autoAngle + degToRad(rollAdjustDeg)

  const eyePxFromBottom = specToPx(spec, eyeHeight)
  const anchor: Point = { x: outWidth / 2, y: outHeight - eyePxFromBottom }

  // Where the pupil line sits within the head, as a fraction of head height.
  // Projected onto the head axis so a tilted head still measures correctly.
  const axis = { x: chin.x - crown.x, y: chin.y - crown.y }
  const toEyes = { x: eyes.x - crown.x, y: eyes.y - crown.y }
  const eyeRatio = (toEyes.x * axis.x + toEyes.y * axis.y) / (headPxSource * headPxSource)

  const headroomPx = anchor.y - eyeRatio * headPxOutput
  const chinToBottomPx = outHeight - (anchor.y + (1 - eyeRatio) * headPxOutput)

  return {
    scale,
    angle,
    autoAngle,
    anchor,
    origin: eyes,
    outWidth,
    outHeight,
    headPxSource,
    headPxOutput,
    effectiveDpi: spec.dpi / scale,
    eyeRatio,
    headroomPx,
    chinToBottomPx,
  }
}

/** Map a point from image space into output space. */
export function imgToOut(p: Point, t: CropTransform): Point {
  const rel = { x: p.x - t.origin.x, y: p.y - t.origin.y }
  const r = rotate(rel, t.angle)
  return { x: t.anchor.x + r.x * t.scale, y: t.anchor.y + r.y * t.scale }
}

/** Map a point from output space back into image space. */
export function outToImg(p: Point, t: CropTransform): Point {
  const rel = { x: (p.x - t.anchor.x) / t.scale, y: (p.y - t.anchor.y) / t.scale }
  const r = rotate(rel, -t.angle)
  return { x: t.origin.x + r.x, y: t.origin.y + r.y }
}

/**
 * The affine matrix in the argument order canvas expects:
 * ctx.setTransform(a, b, c, d, e, f) then ctx.drawImage(source, 0, 0).
 *
 * One setTransform call does the entire crop, rotate and scale in hardware —
 * there is never a reason to touch pixels individually for the crop itself.
 */
export function toCanvasMatrix(t: CropTransform): [number, number, number, number, number, number] {
  const c = Math.cos(t.angle) * t.scale
  const s = Math.sin(t.angle) * t.scale
  const a = c
  const b = s
  const cc = -s
  const d = c
  const e = t.anchor.x - (a * t.origin.x + cc * t.origin.y)
  const f = t.anchor.y - (b * t.origin.x + d * t.origin.y)
  return [a, b, cc, d, e, f]
}

/**
 * The four corners of the output rectangle expressed in image space, in
 * clockwise order from the top-left. If any corner falls outside the source
 * image the crop is reaching past the edge of the photo.
 */
export function cropCornersInImageSpace(t: CropTransform): [Point, Point, Point, Point] {
  return [
    outToImg({ x: 0, y: 0 }, t),
    outToImg({ x: t.outWidth, y: 0 }, t),
    outToImg({ x: t.outWidth, y: t.outHeight }, t),
    outToImg({ x: 0, y: t.outHeight }, t),
  ]
}

/**
 * How far the crop overhangs each edge of the source image, in source pixels.
 * Zero on every side means the crop is fully covered by real pixels.
 */
export function cropOverflow(
  t: CropTransform,
  imageWidth: number,
  imageHeight: number,
): { left: number; top: number; right: number; bottom: number; any: boolean } {
  const corners = cropCornersInImageSpace(t)
  const xs = corners.map((p) => p.x)
  const ys = corners.map((p) => p.y)
  const left = Math.max(0, -Math.min(...xs))
  const top = Math.max(0, -Math.min(...ys))
  const right = Math.max(0, Math.max(...xs) - imageWidth)
  const bottom = Math.max(0, Math.max(...ys) - imageHeight)
  return { left, top, right, bottom, any: left + top + right + bottom > 1e-6 }
}

/**
 * Choose head and eye heights that satisfy the spec's headroom rule, staying
 * inside both permitted ranges. This is what the compliance panel's "fix"
 * action calls.
 *
 * Headroom is `outHeight - eyeHeight - eyeRatio * headHeight`, so shrinking the
 * head or lowering the eye line both buy headroom. We prefer adjusting the head
 * height first because it is the less visually obvious change, then fall back to
 * the eye line, and finally return the closest achievable result so the caller
 * can report an honest failure rather than silently producing a bad crop.
 */
export interface ConstraintReport {
  /** The crop rectangle is fully covered by real source pixels. */
  bounds: boolean
  /** Crown-to-top-edge is inside the spec's published band (true if none). */
  headroom: boolean
  /** Both crown and chin are inside the frame. */
  headInFrame: boolean
  all: boolean
}

/** Source image size, needed for the bounds constraint. */
export interface ImageExtent {
  imageWidth: number
  imageHeight: number
}

/**
 * Evaluate every mechanical constraint at once.
 *
 * Having a single place that answers "is this placement legal" is what stops
 * the fix actions contradicting each other — each one used to know about only
 * its own rule and would happily walk the placement out of another's feasible
 * set.
 */
export function evaluateConstraints(
  spec: PhotoSpec,
  placement: Placement,
  extent?: ImageExtent,
): ConstraintReport {
  const t = computeTransform(spec, placement)

  const bounds = extent
    ? !cropOverflow(t, extent.imageWidth, extent.imageHeight).any
    : true

  const headroom = measureHeadroom(spec, t).inRange
  const headInFrame = t.headroomPx >= 0 && t.chinToBottomPx >= 0

  return { bounds, headroom, headInFrame, all: bounds && headroom && headInFrame }
}

/**
 * The single definition of the headroom measurement and whether it passes.
 *
 * The comparison is made against the *rounded* value, the same one the panel
 * prints. Two things depend on this agreeing exactly: the message must never
 * read "2.0 mm, outside the required 2-8 mm", and — less obviously — the solver
 * and the compliance check must agree on which placements pass. When they
 * disagreed by a rounding step, the solver would hand back a placement it
 * believed satisfied headroom while the panel scored it a failure, which
 * resurfaced as a fix that appeared to break a passing check.
 */
export function measureHeadroom(
  spec: PhotoSpec,
  t: CropTransform,
): { value: number; shown: number; inRange: boolean } {
  const inches = t.headroomPx / spec.dpi
  const value = spec.unit === 'mm' ? inches * 25.4 : inches
  const shown = Number(value.toFixed(1))
  const inRange = spec.headroom
    ? shown >= spec.headroom.min && shown <= spec.headroom.max
    : true
  return { value, shown, inRange }
}

/** How finely each permitted range is sampled when searching. */
const SEARCH_STEPS = 24

/**
 * Search the (head height, eye height) space for a placement the caller accepts.
 *
 * Every fix action in the app funnels through here. Before this existed there
 * were three separate searches over the same grid with three different
 * objectives and step sizes, none aware of the others' constraints — which is
 * how "Zoom to fit" could break a passing headroom check and "Adjust to fit"
 * could break the bounds check straight back, leaving the user clicking two
 * buttons forever.
 *
 * Ties go to the candidate closest to what the user already has. Head height is
 * weighted more heavily *so that it moves less*: changing the head size visibly
 * rescales the face, whereas shifting the eye line slides it within the frame,
 * which is the less jarring correction. Both terms are normalised by their own
 * range width first, because head and eye ranges are different widths and
 * comparing raw millimetres between them is meaningless.
 */
export function searchPlacement(
  spec: PhotoSpec,
  placement: Placement,
  accept: (report: ConstraintReport) => boolean,
  extent?: ImageExtent,
): { headHeight: number; eyeHeight: number } | null {
  const headSpan = spec.head.max - spec.head.min || 1
  const eyeSpan = spec.eye.max - spec.eye.min || 1

  let best: { headHeight: number; eyeHeight: number; drift: number } | null = null

  for (let i = 0; i <= SEARCH_STEPS; i++) {
    const headHeight = spec.head.min + (i / SEARCH_STEPS) * (spec.head.max - spec.head.min)
    for (let j = 0; j <= SEARCH_STEPS; j++) {
      const eyeHeight = spec.eye.min + (j / SEARCH_STEPS) * (spec.eye.max - spec.eye.min)
      const candidate = { ...placement, headHeight, eyeHeight }
      if (!accept(evaluateConstraints(spec, candidate, extent))) continue

      const drift =
        (Math.abs(headHeight - placement.headHeight) / headSpan) * 2 +
        Math.abs(eyeHeight - placement.eyeHeight) / eyeSpan
      if (!best || drift < best.drift) best = { headHeight, eyeHeight, drift }
    }
  }

  return best ? { headHeight: best.headHeight, eyeHeight: best.eyeHeight } : null
}

/**
 * Find a placement that fixes `target` without breaking anything that currently
 * works.
 *
 * Two tiers. First it tries to satisfy every constraint at once, which is what
 * makes the fixes mutually consistent.
 *
 * If the photo cannot satisfy them all, it falls back — but the fallback is NOT
 * "just fix the target". It is "fix the target and keep every constraint that
 * is passing right now still passing". That distinction is the whole point: a
 * fallback that optimises only for the clicked constraint is exactly how "Zoom
 * to fit" ends up breaking headroom and "Adjust to fit" breaks bounds straight
 * back, leaving the user alternating between two buttons forever. Because a fix
 * can never regress a passing check, the loop is impossible by construction
 * rather than by good luck.
 *
 * If even that is unreachable, null — and the caller offers no fix at all,
 * which is more honest than a button that makes things worse.
 */
export function solveFor(
  spec: PhotoSpec,
  placement: Placement,
  target: (report: ConstraintReport) => boolean,
  extent?: ImageExtent,
): { headHeight: number; eyeHeight: number; complete: boolean } | null {
  const everything = searchPlacement(spec, placement, (r) => r.all, extent)
  if (everything) return { ...everything, complete: true }

  const current = evaluateConstraints(spec, placement, extent)
  const withoutRegression = searchPlacement(
    spec,
    placement,
    (r) =>
      target(r) &&
      (!current.bounds || r.bounds) &&
      (!current.headroom || r.headroom) &&
      (!current.headInFrame || r.headInFrame),
    extent,
  )

  return withoutRegression ? { ...withoutRegression, complete: false } : null
}

/**
 * Back-compatible headroom solver, now a thin wrapper over the shared search.
 */
export function solveForHeadroom(
  spec: PhotoSpec,
  placement: Placement,
): { headHeight: number; eyeHeight: number; satisfied: boolean } {
  const current = { headHeight: placement.headHeight, eyeHeight: placement.eyeHeight }
  if (!spec.headroom) return { ...current, satisfied: true }

  const solved = searchPlacement(spec, placement, (r) => r.headroom && r.headInFrame)
  if (solved) return { ...solved, satisfied: true }

  // Nothing in range works for this face; hand back the spec defaults so the
  // user sees a sane crop alongside the failing headroom warning.
  return { headHeight: spec.head.default, eyeHeight: spec.eye.default, satisfied: false }
}

/** Clamp a placement's adjustable values into their permitted ranges. */
export function clampPlacement(spec: PhotoSpec, placement: Placement): Placement {
  return {
    ...placement,
    headHeight: clamp(placement.headHeight, spec.head.min, spec.head.max),
    eyeHeight: clamp(placement.eyeHeight, spec.eye.min, spec.eye.max),
    rollAdjustDeg: clamp(placement.rollAdjustDeg, -15, 15),
  }
}

/** A starting placement for a freshly loaded image, before face detection. */
export function defaultPlacement(spec: PhotoSpec, width: number, height: number): Placement {
  // A plausible head occupying the middle of the frame, so the pins are always
  // visible and grabbable even if detection fails or is declined.
  const cx = width / 2
  const headLen = height * 0.45
  const crownY = height * 0.16
  return {
    landmarks: {
      crown: { x: cx, y: crownY },
      chin: { x: cx, y: crownY + headLen },
      eyes: { x: cx, y: crownY + headLen * 0.45 },
    },
    headHeight: spec.head.default,
    eyeHeight: spec.eye.default,
    rollAdjustDeg: 0,
  }
}
