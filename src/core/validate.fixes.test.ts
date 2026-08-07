/**
 * Regression tests for the fix actions.
 *
 * A code review measured two defects here that ordinary unit tests missed:
 *   - `checkChinInFrame` offered a fix that failed to resolve its own finding in
 *     275 of 306 cases (90%), because it reused the headroom solver and never
 *     checked the result against the crown and chin positions.
 *   - "Zoom to fit" and "Adjust to fit" undid each other, because the bounds
 *     search ignored headroom and the headroom search ignored the image bounds.
 *
 * Both were invisible to a single hand-picked example. These tests sweep the
 * space instead, and assert the two properties that matter for any fix:
 *   1. If a fix is offered, applying it RESOLVES the finding.
 *   2. Applying a fix never turns another passing check into a failure.
 */

import { describe, expect, it } from 'vitest'
import { computeTransform, type Landmarks, type Placement } from './geometry'
import { getSpec, type PhotoSpec } from './specs'
import { validate, type Finding } from './validate'

const US = getSpec('us-2x2')
const JP = getSpec('jp-35x45')
const UK = getSpec('intl-35x45')

/** A head whose pupil line sits `eyeRatio` of the way from crown to chin. */
function headWith(eyeRatio: number, crownY = 300, len = 500, cx = 500): Landmarks {
  return {
    crown: { x: cx, y: crownY },
    chin: { x: cx, y: crownY + len },
    eyes: { x: cx, y: crownY + len * eyeRatio },
  }
}

function runValidate(
  spec: PhotoSpec,
  placement: Placement,
  imageWidth: number,
  imageHeight: number,
): Finding[] {
  return validate({
    spec,
    placement,
    transform: computeTransform(spec, placement),
    imageWidth,
    imageHeight,
  })
}

const severityOf = (findings: Finding[], id: string) =>
  findings.find((f) => f.id === id)?.severity

/**
 * Every combination worth sweeping: face proportion, head position in the
 * source, head size, and both ends of each permitted range.
 */
function* scenarios(spec: PhotoSpec) {
  // Sized so the whole sweep stays a few seconds: each scenario runs the full
  // validator, and each fix runs a 25x25 constrained search. The extremes are
  // what matter here, not density — every value below is either a boundary of a
  // permitted range or a deliberately awkward face proportion.
  const eyeRatios = [0.15, 0.45, 0.62, 0.85]
  const crownYs = [8, 200, 400]
  const headLens = [200, 500, 750]
  const sources: Array<[number, number]> = [
    [900, 1200],
    [1400, 1900],
  ]
  const heads = [spec.head.min, spec.head.default, spec.head.max]
  const eyes = [spec.eye.min, spec.eye.default, spec.eye.max]

  for (const eyeRatio of eyeRatios)
    for (const crownY of crownYs)
      for (const len of headLens)
        for (const [w, h] of sources)
          for (const headHeight of heads)
            for (const eyeHeight of eyes) {
              yield {
                placement: {
                  landmarks: headWith(eyeRatio, crownY, len),
                  headHeight,
                  eyeHeight,
                  rollAdjustDeg: 0,
                } satisfies Placement,
                imageWidth: w,
                imageHeight: h,
              }
            }
}

/** Mechanical checks — the ones a fix is allowed to move. */
const MECHANICAL = ['bounds', 'headroom', 'head-in-frame'] as const

describe.each([
  ['us-2x2', US],
  ['jp-35x45 (publishes a headroom band)', JP],
  ['intl-35x45', UK],
])('fix actions for %s', (_label, spec) => {
  it('every offered fix resolves the finding it is attached to', { timeout: 60000 }, () => {
    const failures: string[] = []
    let offered = 0

    for (const { placement, imageWidth, imageHeight } of scenarios(spec)) {
      const before = runValidate(spec, placement, imageWidth, imageHeight)
      for (const finding of before) {
        if (!finding.fix) continue
        offered++
        const after = runValidate(
          spec,
          finding.fix.apply(placement),
          imageWidth,
          imageHeight,
        )
        const now = severityOf(after, finding.id)
        if (now === 'fail') {
          failures.push(
            `${finding.id}: still failing after "${finding.fix.label}" ` +
              `(head ${placement.headHeight}, eye ${placement.eyeHeight}, ` +
              `${imageWidth}x${imageHeight})`,
          )
        }
      }
    }

    expect(offered).toBeGreaterThan(0)
    expect(failures.slice(0, 5)).toEqual([])
  })

  it('no fix turns a passing mechanical check into a failure', { timeout: 60000 }, () => {
    const regressions: string[] = []

    for (const { placement, imageWidth, imageHeight } of scenarios(spec)) {
      const before = runValidate(spec, placement, imageWidth, imageHeight)
      for (const finding of before) {
        if (!finding.fix) continue
        const after = runValidate(
          spec,
          finding.fix.apply(placement),
          imageWidth,
          imageHeight,
        )
        for (const id of MECHANICAL) {
          if (severityOf(before, id) === 'pass' && severityOf(after, id) === 'fail') {
            regressions.push(
              `"${finding.fix.label}" broke ${id} ` +
                `(head ${placement.headHeight}, eye ${placement.eyeHeight}, ` +
                `${imageWidth}x${imageHeight})`,
            )
          }
        }
      }
    }

    expect(regressions.slice(0, 5)).toEqual([])
  })

  it('applying fixes repeatedly converges instead of ping-ponging', { timeout: 60000 }, () => {
    for (const { placement, imageWidth, imageHeight } of scenarios(spec)) {
      let current = placement
      const seen = new Set<string>()

      for (let step = 0; step < 6; step++) {
        const findings = runValidate(spec, current, imageWidth, imageHeight)
        const next = findings.find((f) => f.severity === 'fail' && f.fix)
        if (!next) break

        const key = `${current.headHeight.toFixed(4)}:${current.eyeHeight.toFixed(4)}`
        if (seen.has(key)) {
          throw new Error(
            `Fix loop revisited head ${current.headHeight} / eye ${current.eyeHeight} ` +
              `for a ${imageWidth}x${imageHeight} source — the fixes are undoing each other.`,
          )
        }
        seen.add(key)
        current = next.fix!.apply(current)
      }
    }
  })
})

describe('headroom message', () => {
  it('never claims a displayed value is outside a range that contains it', { timeout: 60000 }, () => {
    for (const { placement, imageWidth, imageHeight } of scenarios(JP)) {
      const f = runValidate(JP, placement, imageWidth, imageHeight).find(
        (x) => x.id === 'headroom',
      )
      if (f?.severity !== 'fail') continue
      const shown = Number(/^([\d.-]+)/.exec(f.detail)?.[1])
      if (Number.isNaN(shown)) continue
      const insideDisplayed =
        shown >= JP.headroom!.min && shown <= JP.headroom!.max
      expect(
        insideDisplayed,
        `reported "${f.detail.slice(0, 60)}" but ${shown} is inside ${JP.headroom!.min}-${JP.headroom!.max}`,
      ).toBe(false)
    }
  })
})
