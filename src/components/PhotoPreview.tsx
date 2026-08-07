import { useEffect, useRef } from 'react'
import type { Placement } from '@/core/geometry'
import { renderFinalPhoto, type PhotoPipeline } from '@/core/pipeline'
import { specAspect, type PhotoSpec } from '@/core/specs'
import type { LoadedImage } from '@/lib/loadImage'
import { cn } from '@/lib/utils'

interface PhotoPreviewProps {
  spec: PhotoSpec
  image: LoadedImage
  placement: Placement
  pipeline: PhotoPipeline
  className?: string
}

/**
 * The finished photo, rendered at full spec resolution and displayed scaled.
 * Rendering at true size means what the user sees is literally the file that
 * will be exported, not an approximation of it.
 */
export function PhotoPreview({
  spec,
  image,
  placement,
  pipeline,
  className,
}: PhotoPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    renderFinalPhoto(spec, image.bitmap, placement, pipeline, canvas)
  }, [spec, image, placement, pipeline])

  return (
    // No border, tint or overlay of any kind on this element. It is the
    // literal exported file, and the compliance panel samples the same render
    // — anything layered on top would have the user and the validator judging
    // a colour the downloaded photo does not have.
    <canvas
      ref={canvasRef}
      role="img"
      className={cn('block h-auto w-full rounded-lg', className)}
      style={{ aspectRatio: specAspect(spec) }}
      aria-label="Preview of the finished passport photo"
    />
  )
}
