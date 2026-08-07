/**
 * Photo specification types and helpers.
 *
 * The data itself lives in specs.data.ts. That file imports only *types* from
 * here, which are erased at compile time, so the apparent cycle between the two
 * modules never exists at runtime.
 */

import { toPx, type Unit } from './units'
import { SPEC_REGISTRY } from './specs.data'

/** A permitted range with the value we start the user at. */
export interface SpecRange {
  min: number
  max: number
  default: number
}

export interface BackgroundRule {
  /** Human-readable requirement, shown in the compliance panel. */
  label: string
  /** Every sampled channel must exceed this (0-255) to pass. */
  minChannel: number
  /** max(r,g,b) - min(r,g,b) must stay under this, i.e. neutral not tinted. */
  maxSpread: number
  /** Fill colour used when the user enables background cleanup. */
  color: string
}

export interface PhotoSpec {
  id: string
  country: string
  /** ISO 3166-1 alpha-2, used for the flag in the picker. */
  countryCode: string
  documents: string[]
  unit: Unit
  photoW: number
  photoH: number
  dpi: number
  /** Chin to crown, along the head axis. */
  head: SpecRange
  /** Pupil line to the bottom edge of the photo. */
  eye: SpecRange
  /** Crown to the top edge. Omitted where the authority does not specify one. */
  headroom?: { min: number; max: number }
  background: BackgroundRule
  /** Extra rules worth showing but not mechanically checkable. */
  notes?: string[]
  sourceUrl: string
  /** ISO date (YYYY-MM-DD) the spec was last checked against the source. */
  lastVerified: string
}

export { SPEC_REGISTRY }

/** Output pixel dimensions, derived from physical size and DPI. */
export function specPixelSize(spec: PhotoSpec): { width: number; height: number } {
  return {
    width: Math.round(toPx(spec.photoW, spec.unit, spec.dpi)),
    height: Math.round(toPx(spec.photoH, spec.unit, spec.dpi)),
  }
}

/** Aspect ratio (w/h) of the finished photo. */
export function specAspect(spec: PhotoSpec): number {
  return spec.photoW / spec.photoH
}

/** Convert a spec-unit measurement to output pixels for this spec. */
export function specToPx(spec: PhotoSpec, value: number): number {
  return toPx(value, spec.unit, spec.dpi)
}

/** Physical size rendered for a picker row, e.g. "35 × 45 mm". */
export function specSizeLabel(spec: PhotoSpec): string {
  return spec.unit === 'mm'
    ? `${spec.photoW} × ${spec.photoH} mm`
    : `${spec.photoW} × ${spec.photoH} in`
}

/** Free-text haystack for the searchable picker. */
export function specSearchText(spec: PhotoSpec): string {
  return [spec.country, spec.countryCode, ...spec.documents, specSizeLabel(spec)]
    .join(' ')
    .toLowerCase()
}

export const DEFAULT_SPEC_ID = 'us-2x2'

export function getSpec(id: string): PhotoSpec {
  const spec = SPEC_REGISTRY.find((s) => s.id === id)
  if (!spec) throw new Error(`Unknown photo spec: ${id}`)
  return spec
}
