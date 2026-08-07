/**
 * Unit conversion. Every physical measurement in a PhotoSpec is expressed in
 * that spec's own unit ('in' or 'mm'); pixel dimensions are always *derived*
 * from the unit + DPI rather than hardcoded, so a spec can never drift out of
 * sync with its own pixel size.
 */

export type Unit = 'in' | 'mm'

export const MM_PER_INCH = 25.4

/** Millimetres per one unit of `unit`. */
export function mmPerUnit(unit: Unit): number {
  return unit === 'mm' ? 1 : MM_PER_INCH
}

export function toInches(value: number, unit: Unit): number {
  return unit === 'mm' ? value / MM_PER_INCH : value
}

export function fromInches(inches: number, unit: Unit): number {
  return unit === 'mm' ? inches * MM_PER_INCH : inches
}

export function toMm(value: number, unit: Unit): number {
  return unit === 'mm' ? value : value * MM_PER_INCH
}

/**
 * Convert a physical measurement to pixels at a given DPI.
 * Not rounded — rounding is the caller's decision, and rounding intermediate
 * values is how sub-pixel alignment errors creep into the crop.
 */
export function toPx(value: number, unit: Unit, dpi: number): number {
  return toInches(value, unit) * dpi
}

/** Convert pixels at a given DPI back to a physical measurement. */
export function fromPx(px: number, unit: Unit, dpi: number): number {
  return fromInches(px / dpi, unit)
}

/** Format a measurement for display, with the unit suffix. */
export function formatMeasure(value: number, unit: Unit, digits?: number): string {
  const d = digits ?? (unit === 'mm' ? 1 : 2)
  return `${value.toFixed(d)}${unit === 'mm' ? ' mm' : '"'}`
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export const degToRad = (deg: number): number => (deg * Math.PI) / 180
export const radToDeg = (rad: number): number => (rad * 180) / Math.PI
