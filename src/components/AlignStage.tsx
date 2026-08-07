/**
 * The alignment stage.
 *
 * Shows the source photo with the crop rectangle overlaid and the three
 * landmarks as draggable pins. A magnifying loupe follows the pin during a
 * drag, because placing a chin to the nearest pixel by eye is otherwise
 * guesswork on a downscaled preview.
 *
 * Everything is drawn in CSS pixels; the canvas backing store is scaled by the
 * device pixel ratio so the guides stay hairline-sharp on retina displays.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  computeTransform,
  cropCornersInImageSpace,
  outToImg,
  type Placement,
  type Point,
} from '@/core/geometry'
import type { PhotoSpec } from '@/core/specs'
import type { LandmarkKey } from '@/state/useEditor'
import type { LoadedImage } from '@/lib/loadImage'
import { cn } from '@/lib/utils'

const PIN_ORDER: LandmarkKey[] = ['crown', 'eyes', 'chin']

const PIN_STYLE: Record<LandmarkKey, { color: string; label: string; hint: string }> = {
  crown: { color: '#a855f7', label: 'CROWN', hint: 'Top of the hair' },
  eyes: { color: '#3b82f6', label: 'EYES', hint: 'Midpoint between the pupils' },
  chin: { color: '#f97316', label: 'CHIN', hint: 'Bottom of the chin' },
}

const STAGE_PADDING = 28
const HIT_RADIUS = 22
const LOUPE_RADIUS = 62
const LOUPE_ZOOM = 3.5

interface AlignStageProps {
  spec: PhotoSpec
  image: LoadedImage
  placement: Placement
  activePin: LandmarkKey
  onActivePinChange: (key: LandmarkKey) => void
  onLandmarkChange: (key: LandmarkKey, x: number, y: number) => void
  onGestureEnd: () => void
  className?: string
}

interface View {
  scale: number
  offsetX: number
  offsetY: number
}

export function AlignStage({
  spec,
  image,
  placement,
  activePin,
  onActivePinChange,
  onLandmarkChange,
  onGestureEnd,
  className,
}: AlignStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [dragging, setDragging] = useState<LandmarkKey | null>(null)
  const pointerRef = useRef<Point | null>(null)

  // Track the container so the stage fills whatever space the layout gives it.
  // The size is only pushed into state when it genuinely changes: returning a
  // fresh object on every observation would re-render, resize the canvas, and
  // feed the observer again, which locks the tab up.
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const width = Math.round(entry.contentRect.width)
      const height = Math.round(entry.contentRect.height)
      setSize((prev) => (prev.width === width && prev.height === height ? prev : { width, height }))
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const view = useCallback((): View => {
    const availW = Math.max(1, size.width - STAGE_PADDING * 2)
    const availH = Math.max(1, size.height - STAGE_PADDING * 2)
    const scale = Math.min(availW / image.width, availH / image.height)
    return {
      scale,
      offsetX: (size.width - image.width * scale) / 2,
      offsetY: (size.height - image.height * scale) / 2,
    }
  }, [size.width, size.height, image.width, image.height])

  const imgToStage = useCallback(
    (p: Point, v: View): Point => ({
      x: p.x * v.scale + v.offsetX,
      y: p.y * v.scale + v.offsetY,
    }),
    [],
  )

  const stageToImg = useCallback(
    (p: Point, v: View): Point => ({
      x: (p.x - v.offsetX) / v.scale,
      y: (p.y - v.offsetY) / v.scale,
    }),
    [],
  )

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width === 0 || size.height === 0) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    canvas.style.width = `${size.width}px`
    canvas.style.height = `${size.height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)

    const v = view()
    const t = computeTransform(spec, placement)

    // 1. The photo itself.
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image.bitmap, v.offsetX, v.offsetY, image.width * v.scale, image.height * v.scale)

    // 2. Dim everything the crop will discard. An even-odd fill between the
    //    stage rect and the crop quad shades only the outside, leaving the
    //    kept region at full brightness.
    const quad = cropCornersInImageSpace(t).map((p) => imgToStage(p, v))
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, size.width, size.height)
    ctx.moveTo(quad[0]!.x, quad[0]!.y)
    for (const p of quad.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.closePath()
    ctx.fillStyle = 'rgba(9, 11, 17, 0.62)'
    ctx.fill('evenodd')
    ctx.restore()

    // 3. Crop outline.
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(quad[0]!.x, quad[0]!.y)
    for (const p of quad.slice(1)) ctx.lineTo(p.x, p.y)
    ctx.closePath()
    ctx.strokeStyle = 'rgba(255,255,255,0.95)'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.restore()

    // 4. The lines the spec actually constrains: where the eyes must sit, and
    //    where the crown and chin land. Drawn in output space and mapped back,
    //    so they stay correct under rotation.
    const guide = (outY: number, color: string, dash: number[]) => {
      const a = imgToStage(outToImg({ x: 0, y: outY }, t), v)
      const b = imgToStage(outToImg({ x: t.outWidth, y: outY }, t), v)
      ctx.save()
      ctx.setLineDash(dash)
      ctx.strokeStyle = color
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.moveTo(a.x, a.y)
      ctx.lineTo(b.x, b.y)
      ctx.stroke()
      ctx.restore()
    }
    guide(t.anchor.y, 'rgba(96,165,250,0.95)', [7, 5])
    guide(t.headroomPx, 'rgba(168,85,247,0.7)', [3, 5])
    guide(t.outHeight - t.chinToBottomPx, 'rgba(249,115,22,0.7)', [3, 5])

    // 5. Pins, active one last so it is never hidden under its neighbours.
    const order = [...PIN_ORDER].sort((a, b) =>
      a === activePin ? 1 : b === activePin ? -1 : 0,
    )
    for (const key of order) {
      const p = imgToStage(placement.landmarks[key], v)
      drawPin(ctx, p, PIN_STYLE[key], key === activePin, key === dragging)
    }

    // 6. Loupe, only while dragging.
    if (dragging && pointerRef.current) {
      drawLoupe(ctx, {
        image,
        stagePoint: imgToStage(placement.landmarks[dragging], v),
        imagePoint: placement.landmarks[dragging],
        pointer: pointerRef.current,
        bounds: size,
        color: PIN_STYLE[dragging].color,
      })
    }
  }, [spec, image, placement, size, view, imgToStage, activePin, dragging])

  /**
   * Coordinate readout for the live region.
   *
   * The latest placement goes through a ref rather than the dependency array
   * because the announcement is scheduled from inside the keydown handler,
   * before React has applied the move — reading `placement` there would always
   * report the position one keystroke behind. The debounce means holding an
   * arrow key announces the resting position once instead of forty times.
   */
  const [announcement, setAnnouncement] = useState('')
  const announceTimer = useRef<number | null>(null)
  const latestRef = useRef({ placement, activePin })
  latestRef.current = { placement, activePin }

  const scheduleAnnouncement = useCallback(() => {
    if (announceTimer.current !== null) window.clearTimeout(announceTimer.current)
    announceTimer.current = window.setTimeout(() => {
      const { placement: p, activePin: key } = latestRef.current
      const point = p.landmarks[key]
      setAnnouncement(
        `${PIN_STYLE[key].label} at ${Math.round(point.x)}, ${Math.round(point.y)} pixels`,
      )
    }, 400)
  }, [])

  useEffect(
    () => () => {
      if (announceTimer.current !== null) window.clearTimeout(announceTimer.current)
    },
    [],
  )

  const pickPin = useCallback(
    (stagePoint: Point): LandmarkKey | null => {
      const v = view()
      let best: { key: LandmarkKey; dist: number } | null = null
      for (const key of PIN_ORDER) {
        const p = imgToStage(placement.landmarks[key], v)
        const dist = Math.hypot(p.x - stagePoint.x, p.y - stagePoint.y)
        if (dist <= HIT_RADIUS && (!best || dist < best.dist)) best = { key, dist }
      }
      return best?.key ?? null
    },
    [placement.landmarks, view, imgToStage],
  )

  const localPoint = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const point = localPoint(event)
    const key = pickPin(point)
    if (!key) return
    event.currentTarget.setPointerCapture(event.pointerId)
    pointerRef.current = point
    setDragging(key)
    onActivePinChange(key)
    event.currentTarget.focus()
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging) return
    const point = localPoint(event)
    pointerRef.current = point
    const img = stageToImg(point, view())
    onLandmarkChange(dragging, img.x, img.y)
  }

  const endDrag = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragging) return
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    pointerRef.current = null
    setDragging(null)
    onGestureEnd()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLCanvasElement>) => {
    // Cycle pins with Tab-like keys so the stage is usable without a mouse.
    if (event.key === '[' || event.key === ']') {
      const index = PIN_ORDER.indexOf(activePin)
      const delta = event.key === ']' ? 1 : -1
      onActivePinChange(PIN_ORDER[(index + delta + PIN_ORDER.length) % PIN_ORDER.length]!)
      event.preventDefault()
      scheduleAnnouncement()
      return
    }

    const step = event.shiftKey ? 10 : 1
    const deltas: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }
    const delta = deltas[event.key]
    if (!delta) return

    event.preventDefault()
    const current = placement.landmarks[activePin]
    onLandmarkChange(activePin, current.x + delta[0], current.y + delta[1])
    scheduleAnnouncement()
  }

  return (
    <div ref={containerRef} className={cn('relative h-full w-full bg-stage', className)}>
      <canvas
        ref={canvasRef}
        role="application"
        tabIndex={0}
        aria-label={`Alignment stage. Active landmark: ${PIN_STYLE[activePin].label}.`}
        aria-describedby="stage-instructions"
        // Taken out of flow so its own dimensions can never influence the
        // container the ResizeObserver is watching.
        className="absolute inset-0 cursor-crosshair"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onBlur={onGestureEnd}
        onKeyDown={handleKeyDown}
      />

      <p id="stage-instructions" className="sr-only">
        Arrow keys nudge the active landmark by one pixel, Shift and an arrow key by ten.
        Left and right square brackets switch between the crown, eyes and chin landmarks.
        Exact pixel coordinates for all three landmarks can also be typed into the
        “Exact position” fields in the controls panel.
      </p>

      {/*
        Keyboard nudging is otherwise silent: the pin moves, the canvas
        repaints, and a screen reader is told nothing at all. This reports the
        landmark and its coordinates after the keystrokes stop, the same way a
        slider reports its value. It is updated only from the keyboard — a
        pointer drag fires hundreds of moves a second and announcing those
        would be unusable.
      */}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </div>
  )
}

function drawPin(
  ctx: CanvasRenderingContext2D,
  p: Point,
  style: { color: string; label: string },
  active: boolean,
  dragging: boolean,
): void {
  const radius = active ? 11 : 8
  ctx.save()

  // Halo, so the pin reads against both a bright forehead and dark hair.
  ctx.beginPath()
  ctx.arc(p.x, p.y, radius + 3, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(9,11,17,0.45)'
  ctx.fill()

  ctx.beginPath()
  ctx.arc(p.x, p.y, radius, 0, Math.PI * 2)
  ctx.strokeStyle = style.color
  ctx.lineWidth = active ? 3 : 2
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(p.x - radius - 6, p.y)
  ctx.lineTo(p.x - 3, p.y)
  ctx.moveTo(p.x + 3, p.y)
  ctx.lineTo(p.x + radius + 6, p.y)
  ctx.moveTo(p.x, p.y - radius - 6)
  ctx.lineTo(p.x, p.y - 3)
  ctx.moveTo(p.x, p.y + 3)
  ctx.lineTo(p.x, p.y + radius + 6)
  ctx.strokeStyle = style.color
  ctx.lineWidth = 1.5
  ctx.stroke()

  if (active && !dragging) {
    ctx.font = '600 11px ui-sans-serif, system-ui, sans-serif'
    const width = ctx.measureText(style.label).width
    const boxX = p.x - width / 2 - 6
    const boxY = p.y + radius + 10
    ctx.fillStyle = 'rgba(9,11,17,0.8)'
    ctx.beginPath()
    ctx.roundRect(boxX, boxY, width + 12, 18, 5)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(style.label, p.x, boxY + 9)
  }

  ctx.restore()
}

/**
 * The loupe sits offset from the pointer rather than under it — on touch the
 * finger covers exactly the pixels the user is trying to see, so the magnified
 * view goes above and flips to whichever side has room.
 */
function drawLoupe(
  ctx: CanvasRenderingContext2D,
  opts: {
    image: LoadedImage
    stagePoint: Point
    imagePoint: Point
    pointer: Point
    bounds: { width: number; height: number }
    color: string
  },
): void {
  const { image, imagePoint, pointer, bounds, color } = opts
  const r = LOUPE_RADIUS

  let cx = pointer.x
  let cy = pointer.y - r - 46
  if (cy - r < 4) cy = pointer.y + r + 46
  cx = Math.min(bounds.width - r - 6, Math.max(r + 6, cx))
  cy = Math.min(bounds.height - r - 6, Math.max(r + 6, cy))

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = '#0b0d14'
  ctx.fill()
  ctx.clip()

  // Draw the source at LOUPE_ZOOM with the landmark pinned to the loupe centre.
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(
    image.bitmap,
    cx - imagePoint.x * LOUPE_ZOOM,
    cy - imagePoint.y * LOUPE_ZOOM,
    image.width * LOUPE_ZOOM,
    image.height * LOUPE_ZOOM,
  )

  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(cx - r, cy)
  ctx.lineTo(cx - 5, cy)
  ctx.moveTo(cx + 5, cy)
  ctx.lineTo(cx + r, cy)
  ctx.moveTo(cx, cy - r)
  ctx.lineTo(cx, cy - 5)
  ctx.moveTo(cx, cy + 5)
  ctx.lineTo(cx, cy + r)
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.strokeStyle = color
  ctx.lineWidth = 3
  ctx.stroke()
  ctx.restore()
}

export { PIN_ORDER, PIN_STYLE }
