/**
 * Compliance checking.
 *
 * Turns a spec plus a resolved crop into a list of findings the user can act
 * on, each with an optional mechanical fix.
 *
 * A deliberate design note on what is *not* checked here: several properties
 * are true by construction and so are not worth reporting. The head is always
 * exactly the requested height, the pupil line is always at the requested
 * height, and the face is always horizontally centred — the transform is built
 * from those constraints, so they cannot fail. Listing them as green ticks
 * would pad the panel with reassurance that carries no information. Everything
 * below is a check that can genuinely fail.
 */

import {
  cropOverflow,
  measureHeadroom,
  searchPlacement,
  solveFor,
  type CropTransform,
  type ImageExtent,
  type Placement,
} from './geometry'
import { specPixelSize, type BackgroundRule, type PhotoSpec } from './specs'

export type Severity = 'pass' | 'warn' | 'fail'

export interface Fix {
  label: string
  apply: (placement: Placement) => Placement
}

export interface Finding {
  id: string
  severity: Severity
  title: string
  detail: string
  fix?: Fix
}

/** Corner samples taken from the rendered photo, used for the background rule. */
export interface BackgroundSample {
  /** Mean colour across all sampled corner boxes. */
  mean: [number, number, number]
  /** Lowest channel of the mean — how bright the darkest component is. */
  minChannel: number
  /** max-min across channels — how far from neutral grey the background is. */
  spread: number
  /** Largest difference between any two corner means, i.e. how uneven it is. */
  unevenness: number
}

export interface ValidationInput {
  spec: PhotoSpec
  placement: Placement
  transform: CropTransform
  imageWidth: number
  imageHeight: number
  background?: BackgroundSample
}

/** Below this the print is visibly soft; above spec DPI it is pixel-perfect. */
const DPI_WARN_FLOOR = 210

export function validate(input: ValidationInput): Finding[] {
  const { spec, placement, transform, imageWidth, imageHeight, background } = input
  const extent: ImageExtent = { imageWidth, imageHeight }
  const findings: Finding[] = []

  // Degenerate pins first, and exclusively. With crown and chin on top of each
  // other the head length is ~0, the scale explodes, and the crop maps to a
  // sub-picometre region that is technically well inside the image — so the
  // bounds and head-in-frame checks both report a confident green tick. Showing
  // those alongside the real problem is worse than useless, so this replaces
  // them entirely rather than joining them.
  const degenerate = checkLandmarksUsable(transform)
  if (degenerate) return [degenerate]

  findings.push(checkResolution(spec, transform))
  findings.push(checkCropBounds(spec, placement, transform, imageWidth, imageHeight))

  const headroom = checkHeadroom(spec, placement, transform, extent)
  if (headroom) findings.push(headroom)

  findings.push(checkChinInFrame(spec, placement, transform, extent))

  if (background) findings.push(checkBackground(spec.background, background))

  const tilt = checkTilt(transform)
  if (tilt) findings.push(tilt)

  // Worst first: a panel that opens with the thing blocking the user is more
  // useful than one they have to scan.
  const rank: Record<Severity, number> = { fail: 0, warn: 1, pass: 2 }
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity])
}

/**
 * Smallest head, in source pixels, we will treat as a real measurement.
 * Below this the pins have effectively been dropped on the same spot.
 */
const MIN_HEAD_PIXELS = 8

/** Catch pin placements that make every other check meaningless. */
function checkLandmarksUsable(t: CropTransform): Finding | null {
  if (t.headPxSource >= MIN_HEAD_PIXELS && Number.isFinite(t.scale)) return null
  return {
    id: 'landmarks',
    severity: 'fail',
    title: 'Place the CROWN and CHIN pins',
    detail:
      'The crown and chin are on top of each other, so there is no head to measure. ' +
      'Drag the CROWN pin to the top of the hair and the CHIN pin to the bottom of the chin.',
  }
}

function checkResolution(spec: PhotoSpec, t: CropTransform): Finding {
  const dpi = Math.round(t.effectiveDpi)
  if (t.effectiveDpi >= spec.dpi) {
    return {
      id: 'resolution',
      severity: 'pass',
      title: 'Print resolution',
      detail: `${dpi} DPI — the source photo has more detail than the print needs.`,
    }
  }
  if (t.effectiveDpi >= DPI_WARN_FLOOR) {
    return {
      id: 'resolution',
      severity: 'warn',
      title: 'Print resolution',
      detail: `${dpi} DPI. Below the ${spec.dpi} DPI target, so the print will be slightly soft. Usually still accepted, but a closer or higher-resolution photo would be better.`,
    }
  }
  return {
    id: 'resolution',
    severity: 'fail',
    title: 'Print resolution too low',
    detail: `${dpi} DPI. The face occupies too few pixels in the original photo, so the print will be visibly blurry. Retake the photo closer to the camera or at a higher resolution.`,
  }
}

function checkCropBounds(
  spec: PhotoSpec,
  placement: Placement,
  t: CropTransform,
  imageWidth: number,
  imageHeight: number,
): Finding {
  const overflow = cropOverflow(t, imageWidth, imageHeight)
  if (!overflow.any) {
    return {
      id: 'bounds',
      severity: 'pass',
      title: 'Crop area',
      detail: 'The whole photo area is covered by the original image.',
    }
  }

  const fitted = solveFor(
    spec,
    placement,
    (r) => r.bounds,
    { imageWidth, imageHeight },
  )
  const sides = [
    overflow.top > 0 && 'top',
    overflow.bottom > 0 && 'bottom',
    overflow.left > 0 && 'left',
    overflow.right > 0 && 'right',
  ].filter(Boolean)

  return {
    id: 'bounds',
    severity: 'fail',
    title: 'Crop runs off the photo',
    detail: `The crop extends past the ${sides.join(', ')} of the original image, so part of the print would be blank. ${
      fitted === null
        ? 'There is not enough room around the head in this photo — retake it with more space above the head and around the shoulders.'
        : 'Zooming in slightly brings it back inside.'
    }`,
    fix:
      fitted === null
        ? undefined
        : {
            label: 'Zoom to fit',
            apply: (p) => ({ ...p, headHeight: fitted.headHeight, eyeHeight: fitted.eyeHeight }),
          },
  }
}

/**
 * Find head and eye heights whose crop stays inside the source image.
 * Kept as a named export because it reads better at the call site than the
 * generic solver, and because it is directly unit-tested.
 */
export function findFittingPlacement(
  spec: PhotoSpec,
  placement: Placement,
  imageWidth: number,
  imageHeight: number,
): { headHeight: number; eyeHeight: number } | null {
  return searchPlacement(spec, placement, (r) => r.bounds, { imageWidth, imageHeight })
}

function checkHeadroom(
  spec: PhotoSpec,
  placement: Placement,
  t: CropTransform,
  extent: ImageExtent,
): Finding | null {
  if (!spec.headroom) return null

  // Shared with the solver's constraint check, so the two can never disagree
  // about which placements pass. It also compares the displayed value, so the
  // panel can never say "2.0 mm, outside the required 2-8 mm".
  const { shown, inRange } = measureHeadroom(spec, t)
  const unit = spec.unit === 'mm' ? ' mm' : '"'

  if (inRange) {
    return {
      id: 'headroom',
      severity: 'pass',
      title: 'Space above the head',
      detail: `${shown.toFixed(1)}${unit}, within the required ${spec.headroom.min}–${spec.headroom.max}${unit}.`,
    }
  }

  const solved = solveFor(spec, placement, (r) => r.headroom, extent)
  return {
    id: 'headroom',
    severity: 'fail',
    title: shown < spec.headroom.min ? 'Too little space above the head' : 'Too much space above the head',
    detail: `${shown.toFixed(1)}${unit}, outside the required ${spec.headroom.min}–${spec.headroom.max}${unit}. ${
      solved
        ? 'Adjusting the head and eye heights within their permitted ranges fixes this.'
        : 'No combination of permitted head and eye heights satisfies this for this face — check that the CROWN and CHIN pins are placed accurately.'
    }`,
    fix: solved
      ? {
          label: 'Adjust to fit',
          apply: (p) => ({ ...p, headHeight: solved.headHeight, eyeHeight: solved.eyeHeight }),
        }
      : undefined,
  }
}

function checkChinInFrame(
  spec: PhotoSpec,
  placement: Placement,
  t: CropTransform,
  extent: ImageExtent,
): Finding {
  if (t.chinToBottomPx >= 0 && t.headroomPx >= 0) {
    return {
      id: 'head-in-frame',
      severity: 'pass',
      title: 'Head fits the frame',
      detail: 'The crown and chin are both inside the photo area.',
    }
  }

  // This search is against the constraint the finding is actually about.
  // It previously reused the headroom solver, or blindly reset to the spec
  // defaults, and checked neither result against the crown and chin positions —
  // so the offered fix left the head still cut off about nine times in ten.
  const solved = solveFor(spec, placement, (r) => r.headInFrame, extent)
  const which = t.headroomPx < 0 ? 'top of the head is' : 'chin is'

  return {
    id: 'head-in-frame',
    severity: 'fail',
    title: 'Head does not fit the frame',
    detail: `The ${which} cut off by the edge of the photo. ${
      solved
        ? 'Adjusting the head and eye heights brings it back inside.'
        : 'No permitted head and eye height fits this face in the frame — check that the CROWN and CHIN pins are on the top of the hair and the bottom of the chin.'
    }`,
    fix: solved
      ? {
          label: 'Adjust to fit',
          apply: (p) => ({ ...p, headHeight: solved.headHeight, eyeHeight: solved.eyeHeight }),
        }
      : undefined,
  }
}

/** Pure evaluation of a background sample against a spec rule. */
export function checkBackground(rule: BackgroundRule, sample: BackgroundSample): Finding {
  const tooDark = sample.minChannel < rule.minChannel
  const tooColoured = sample.spread > rule.maxSpread
  const uneven = sample.unevenness > 18

  if (!tooDark && !tooColoured && !uneven) {
    return {
      id: 'background',
      severity: 'pass',
      title: 'Background',
      detail: `Even and neutral, matching “${rule.label.toLowerCase()}”.`,
    }
  }

  const problems: string[] = []
  if (tooDark) problems.push('too dark')
  if (tooColoured) problems.push('has a colour cast')
  if (uneven) problems.push('unevenly lit')

  return {
    id: 'background',
    // A background that is merely a little dark is often accepted; a strong
    // colour cast or visible shading is what actually gets photos rejected.
    severity: tooColoured || uneven ? 'fail' : 'warn',
    title: `Background ${problems.join(' and ')}`,
    detail: `This spec requires ${rule.label.toLowerCase()}. Shooting against a plain wall in even, indirect light is the reliable fix; background cleanup can help but some authorities do not accept digitally altered backgrounds.`,
  }
}

function checkTilt(t: CropTransform): Finding | null {
  const autoDeg = Math.abs((t.autoAngle * 180) / Math.PI)
  if (autoDeg < 12) return null
  return {
    id: 'tilt',
    severity: 'warn',
    title: 'Head is noticeably tilted',
    detail: `The photo was levelled by ${autoDeg.toFixed(1)}°. Rotating this far can leave the crop reaching past the edges, and a straight-on photo is always safer. Consider retaking it with the head upright.`,
  }
}

/**
 * Sample the background from the top corners of the *rendered* photo, which is
 * what an examiner actually looks at.
 *
 * Only the top corners are sampled: in a correctly framed passport photo the
 * lower corners are shoulders, so including them would measure clothing and
 * report a colour cast on every photo of anyone not wearing white.
 */
export function sampleBackground(
  canvas: HTMLCanvasElement,
  spec: PhotoSpec,
): BackgroundSample | null {
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  const { width } = specPixelSize(spec)
  const box = Math.min(70, Math.round(width / 4))
  const corners: Array<[number, number]> = [
    [0, 0],
    [width - box, 0],
  ]

  const means: Array<[number, number, number]> = []
  for (const [x, y] of corners) {
    const data = ctx.getImageData(x, y, box, box).data
    let r = 0
    let g = 0
    let b = 0
    const count = data.length / 4
    for (let i = 0; i < data.length; i += 4) {
      r += data[i]!
      g += data[i + 1]!
      b += data[i + 2]!
    }
    means.push([r / count, g / count, b / count])
  }

  if (means.length === 0) return null

  const mean: [number, number, number] = [
    means.reduce((s, m) => s + m[0], 0) / means.length,
    means.reduce((s, m) => s + m[1], 0) / means.length,
    means.reduce((s, m) => s + m[2], 0) / means.length,
  ]

  let unevenness = 0
  for (let i = 0; i < means.length; i++) {
    for (let j = i + 1; j < means.length; j++) {
      const a = means[i]!
      const b = means[j]!
      unevenness = Math.max(
        unevenness,
        Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2])),
      )
    }
  }

  return {
    mean,
    minChannel: Math.min(...mean),
    spread: Math.max(...mean) - Math.min(...mean),
    unevenness,
  }
}

/** Overall verdict for the panel header. */
export function overallSeverity(findings: Finding[]): Severity {
  if (findings.some((f) => f.severity === 'fail')) return 'fail'
  if (findings.some((f) => f.severity === 'warn')) return 'warn'
  return 'pass'
}
