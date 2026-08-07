import { describe, expect, it } from 'vitest'
import { computeTransform, cropOverflow, type Landmarks, type Placement } from './geometry'
import { getSpec } from './specs'
import {
  checkBackground,
  findFittingPlacement,
  overallSeverity,
  validate,
  type BackgroundSample,
  type Finding,
} from './validate'

const US = getSpec('us-2x2')
const INTL = getSpec('intl-35x45')
// Japan is the headroom fixture because MOFA actually publishes a crown margin
// (4±2 mm). The UK entry used to carry an invented one purely to satisfy these
// tests, which had it backwards: a test must not be the reason a spec claims a
// rule its authority never published.
const JP = getSpec('jp-35x45')

function head(cx = 500, crownY = 300, len = 500): Landmarks {
  return {
    crown: { x: cx, y: crownY },
    chin: { x: cx, y: crownY + len },
    eyes: { x: cx, y: crownY + len * 0.45 },
  }
}

function place(landmarks: Landmarks, over: Partial<Placement> = {}): Placement {
  return {
    landmarks,
    headHeight: US.head.default,
    eyeHeight: US.eye.default,
    rollAdjustDeg: 0,
    ...over,
  }
}

function run(spec = US, placement = place(head()), w = 1400, h = 1900): Finding[] {
  return validate({
    spec,
    placement,
    transform: computeTransform(spec, placement),
    imageWidth: w,
    imageHeight: h,
  })
}

const find = (findings: Finding[], id: string) => findings.find((f) => f.id === id)

describe('resolution', () => {
  it('passes when the source has more detail than the print needs', () => {
    // 500px head rendered at 357px is a downscale, so no detail is invented.
    expect(find(run(), 'resolution')?.severity).toBe('pass')
  })

  it('warns on a moderate upscale', () => {
    const p = place(head(500, 300, 300))
    const f = find(run(US, p), 'resolution')
    expect(f?.severity).toBe('warn')
  })

  it('fails when the face is far too small in the source', () => {
    const p = place(head(500, 300, 90))
    expect(find(run(US, p), 'resolution')?.severity).toBe('fail')
  })
})

describe('crop bounds', () => {
  it('passes when the source comfortably covers the crop', () => {
    expect(find(run(), 'bounds')?.severity).toBe('pass')
  })

  it('fails and offers a zoom fix when the crop runs off the edge', () => {
    // Head hard against the top of the source leaves no headroom to crop.
    const p = place(head(500, 8, 500))
    const f = find(run(US, p, 1000, 1400), 'bounds')
    expect(f?.severity).toBe('fail')
    expect(f?.fix).toBeDefined()
  })

  it('the offered fix actually resolves the finding', () => {
    const p = place(head(500, 8, 500))
    const f = find(run(US, p, 1000, 1400), 'bounds')
    const fixed = f!.fix!.apply(p)
    expect(find(run(US, fixed, 1000, 1400), 'bounds')?.severity).toBe('pass')
  })

  it('offers no fix when no permitted head height can rescue the photo', () => {
    // Head fills essentially the whole source: nothing to crop into.
    const p = place(head(50, 2, 96))
    const f = find(run(US, p, 100, 100), 'bounds')
    expect(f?.severity).toBe('fail')
    expect(f?.fix).toBeUndefined()
  })
})

describe('findFittingPlacement', () => {
  it('never returns values outside the permitted ranges', () => {
    const fitted = findFittingPlacement(US, place(head(500, 8, 500)), 1000, 1400)
    expect(fitted).not.toBeNull()
    expect(fitted!.headHeight).toBeGreaterThanOrEqual(US.head.min)
    expect(fitted!.headHeight).toBeLessThanOrEqual(US.head.max)
    expect(fitted!.eyeHeight).toBeGreaterThanOrEqual(US.eye.min)
    expect(fitted!.eyeHeight).toBeLessThanOrEqual(US.eye.max)
  })

  it('rescues photos that adjusting head height alone cannot', () => {
    // Crown 8px from the top: no head height on its own leaves enough room
    // above the pupil line, but raising the eye line as well does.
    const p = place(head(500, 8, 500))
    const headOnly = Array.from({ length: 40 }, (_, i) => US.head.min + (i / 39) * (US.head.max - US.head.min))
      .some((h) => {
        const t = computeTransform(US, { ...p, headHeight: h })
        return !cropOverflow(t, 1000, 1400).any
      })
    expect(headOnly).toBe(false)
    expect(findFittingPlacement(US, p, 1000, 1400)).not.toBeNull()
  })

  it('returns null when the photo simply has no margin', () => {
    expect(findFittingPlacement(US, place(head(50, 2, 96)), 100, 100)).toBeNull()
  })
})

describe('headroom', () => {
  const at = (headHeight: number, eyeHeight: number): Placement => ({
    landmarks: head(),
    headHeight,
    eyeHeight,
    rollAdjustDeg: 0,
  })

  it('is not reported for specs that do not define one', () => {
    expect(find(run(US), 'headroom')).toBeUndefined()
  })

  it('is not reported for the UK, whose authority publishes no crown margin', () => {
    expect(INTL.headroom).toBeUndefined()
    const p = at(INTL.head.default, INTL.eye.default)
    expect(find(run(INTL, p, 1400, 1900), 'headroom')).toBeUndefined()
  })

  it('is reported for specs that do define one', () => {
    expect(JP.headroom).toBeDefined()
    const p = at(JP.head.default, JP.eye.default)
    expect(find(run(JP, p, 1400, 1900), 'headroom')).toBeDefined()
  })

  it('offers a fix that lands the headroom inside the required band', () => {
    // Largest head with the highest eye line pushes the crown off the top edge.
    // The precondition is asserted rather than branched on: wrapping the body
    // in `if (severity === 'fail')` would let this test silently assert nothing.
    const p = at(JP.head.max, JP.eye.max)
    const f = find(run(JP, p, 1400, 1900), 'headroom')
    expect(f).toBeDefined()
    expect(f!.severity).toBe('fail')
    expect(f!.fix).toBeDefined()

    const fixed = f!.fix!.apply(p)
    expect(find(run(JP, fixed, 1400, 1900), 'headroom')?.severity).toBe('pass')
  })
})

describe('degenerate landmarks', () => {
  const collapsed = (): Landmarks => ({
    crown: { x: 100, y: 100 },
    chin: { x: 100, y: 100 },
    eyes: { x: 100, y: 100 },
  })

  it('reports one actionable failure instead of a page of green ticks', () => {
    const findings = run(US, place(collapsed()))
    expect(findings).toHaveLength(1)
    expect(findings[0]!.id).toBe('landmarks')
    expect(findings[0]!.severity).toBe('fail')
  })

  it('never reports bounds or head-in-frame as passing for a collapsed head', () => {
    // Both used to return a confident "pass": the crop maps to a sub-picometre
    // region which is, technically, well inside the image.
    const findings = run(US, place(collapsed()))
    expect(findings.some((f) => f.id === 'bounds' && f.severity === 'pass')).toBe(false)
    expect(findings.some((f) => f.id === 'head-in-frame' && f.severity === 'pass')).toBe(false)
  })

  it('does not trigger for a small but genuine head', () => {
    const findings = run(US, place(head(500, 300, 40)))
    expect(findings.some((f) => f.id === 'landmarks')).toBe(false)
  })
})

describe('checkBackground', () => {
  const clean: BackgroundSample = { mean: [248, 248, 247], minChannel: 247, spread: 1, unevenness: 2 }

  it('passes a clean white wall', () => {
    expect(checkBackground(US.background, clean).severity).toBe('pass')
  })

  it('warns rather than fails on a merely dim background', () => {
    const dim: BackgroundSample = { mean: [220, 220, 219], minChannel: 219, spread: 1, unevenness: 2 }
    expect(checkBackground(US.background, dim).severity).toBe('warn')
  })

  it('fails on a colour cast', () => {
    const blue: BackgroundSample = { mean: [235, 240, 255], minChannel: 235, spread: 20, unevenness: 3 }
    expect(checkBackground(US.background, blue).severity).toBe('fail')
  })

  it('fails on uneven lighting even when the mean colour is fine', () => {
    const uneven: BackgroundSample = { mean: [245, 245, 245], minChannel: 245, spread: 0, unevenness: 40 }
    expect(checkBackground(US.background, uneven).severity).toBe('fail')
  })

  it('applies each spec\'s own thresholds', () => {
    const greyish: BackgroundSample = { mean: [210, 210, 209], minChannel: 209, spread: 1, unevenness: 3 }
    // 209 is too dark for the strict US rule but fine for white-through-grey.
    expect(checkBackground(US.background, greyish).severity).toBe('warn')
    expect(checkBackground(INTL.background, greyish).severity).toBe('pass')
  })
})

describe('tilt', () => {
  it('is silent for a roughly upright head', () => {
    expect(find(run(), 'tilt')).toBeUndefined()
  })

  it('warns when the photo needed a large rotation', () => {
    const angle = (20 * Math.PI) / 180
    const lm: Landmarks = {
      crown: { x: 500, y: 300 },
      chin: { x: 500 + 500 * Math.sin(angle), y: 300 + 500 * Math.cos(angle) },
      eyes: { x: 500 + 225 * Math.sin(angle), y: 300 + 225 * Math.cos(angle) },
    }
    expect(find(run(US, place(lm)), 'tilt')?.severity).toBe('warn')
  })
})

describe('ordering and overall verdict', () => {
  it('puts failures first', () => {
    const findings = run(US, place(head(500, 8, 500)), 1000, 1400)
    const severities = findings.map((f) => f.severity)
    const firstPass = severities.indexOf('pass')
    const lastFail = severities.lastIndexOf('fail')
    if (firstPass !== -1 && lastFail !== -1) expect(lastFail).toBeLessThan(firstPass)
  })

  it('summarises to the worst severity present', () => {
    expect(overallSeverity([{ id: 'a', severity: 'pass', title: '', detail: '' }])).toBe('pass')
    expect(
      overallSeverity([
        { id: 'a', severity: 'pass', title: '', detail: '' },
        { id: 'b', severity: 'warn', title: '', detail: '' },
      ]),
    ).toBe('warn')
    expect(
      overallSeverity([
        { id: 'a', severity: 'warn', title: '', detail: '' },
        { id: 'b', severity: 'fail', title: '', detail: '' },
      ]),
    ).toBe('fail')
  })
})
