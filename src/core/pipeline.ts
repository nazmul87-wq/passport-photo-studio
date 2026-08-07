/**
 * The single definition of "the finished photo".
 *
 * Preview, background sampling and export all call this. If the preview and the
 * exported file were produced by two different code paths they would eventually
 * disagree, and the user would only discover it after paying to print.
 */

import { applyToCanvas, isNeutral, UNIT_GAINS, type Adjustments, type ChannelGains } from './enhance'
import type { Placement } from './geometry'
import { renderPhoto, type ImageSource } from './render'
import type { PhotoSpec } from './specs'

export interface PhotoPipeline {
  adjustments: Adjustments
  /** White-balance gains, usually from autoWhiteBalance. */
  gains: ChannelGains
  /**
   * Pre-composited source (subject cut out and placed on a clean background).
   * When present it replaces the original image for the crop.
   */
  composited?: ImageSource | null
}

export function renderFinalPhoto(
  spec: PhotoSpec,
  source: ImageSource,
  placement: Placement,
  pipeline: PhotoPipeline,
  target?: HTMLCanvasElement,
): HTMLCanvasElement {
  const canvas = renderPhoto(spec, pipeline.composited ?? source, placement, target)
  if (!isNeutral(pipeline.adjustments, pipeline.gains)) {
    applyToCanvas(canvas, pipeline.adjustments, pipeline.gains)
  }
  return canvas
}

export const NEUTRAL_PIPELINE_GAINS = UNIT_GAINS
