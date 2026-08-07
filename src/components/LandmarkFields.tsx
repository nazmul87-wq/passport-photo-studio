/**
 * Numeric placement for the three landmarks.
 *
 * The alignment stage is a drag surface, and drag surfaces are unusable to
 * anyone on a screen reader, a switch device, or any pointer they cannot aim
 * precisely. Arrow-key nudging on the canvas helps, but it only moves the pin
 * relatively and gives no readout of where the pin actually is — a blind user
 * has no way to know a pin is 40px off, let alone to correct it.
 *
 * So the same three points are also editable as absolute pixel coordinates in
 * the source image. This is the accessible equivalent of the canvas, not a
 * convenience: it is the only path to landmark placement that does not require
 * sight and a steady hand. It is deliberately always visible rather than
 * folded into a disclosure.
 */

import { useEffect, useRef, useState } from 'react'
import { Input } from '@/components/ui/input'
import { PIN_STYLE } from '@/components/AlignStage'
import type { Placement } from '@/core/geometry'
import type { LandmarkKey } from '@/state/useEditor'
import { cn } from '@/lib/utils'

const PIN_ORDER: LandmarkKey[] = ['crown', 'eyes', 'chin']

interface LandmarkFieldsProps {
  placement: Placement
  /** Source image size, so the fields can state and enforce their range. */
  imageWidth: number
  imageHeight: number
  activePin: LandmarkKey
  onActivePinChange: (key: LandmarkKey) => void
  onLandmarkChange: (key: LandmarkKey, x: number, y: number) => void
  onCommit: () => void
}

export function LandmarkFields({
  placement,
  imageWidth,
  imageHeight,
  activePin,
  onActivePinChange,
  onLandmarkChange,
  onCommit,
}: LandmarkFieldsProps) {
  return (
    <section aria-labelledby="landmark-fields-heading" className="space-y-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="landmark-fields-heading" className="eyebrow">
          Exact position
        </h3>
        <span className="text-[11px] text-muted-foreground">pixels in the source photo</span>
      </div>

      <div className="glass-card space-y-2 rounded-xl p-2.5">
        <div
          aria-hidden
          className="grid grid-cols-[1fr_4.5rem_4.5rem] gap-2 px-0.5 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase"
        >
          <span>Landmark</span>
          <span className="text-center">X</span>
          <span className="text-center">Y</span>
        </div>

        {PIN_ORDER.map((key) => {
          const point = placement.landmarks[key]
          return (
            <div key={key} className="grid grid-cols-[1fr_4.5rem_4.5rem] items-center gap-2">
              <button
                type="button"
                onClick={() => onActivePinChange(key)}
                aria-pressed={activePin === key}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs font-medium transition-colors',
                  'hover:bg-accent hover:text-accent-foreground',
                  activePin === key ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-full ring-1 ring-black/20 dark:ring-white/25"
                  style={{ backgroundColor: PIN_STYLE[key].color }}
                />
                <span className="truncate">{PIN_STYLE[key].label}</span>
              </button>

              <CoordinateField
                label={`${PIN_STYLE[key].label} horizontal position, in pixels from the left edge`}
                value={point.x}
                max={imageWidth}
                onChange={(next) => onLandmarkChange(key, next, point.y)}
                onCommit={onCommit}
                onFocus={() => onActivePinChange(key)}
              />
              <CoordinateField
                label={`${PIN_STYLE[key].label} vertical position, in pixels from the top edge`}
                value={point.y}
                max={imageHeight}
                onChange={(next) => onLandmarkChange(key, point.x, next)}
                onCommit={onCommit}
                onFocus={() => onActivePinChange(key)}
              />
            </div>
          )
        })}
      </div>

      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {PIN_STYLE[activePin].hint}. Editing a number moves the pin on the photo, and
        dragging the pin updates the number.
      </p>
    </section>
  )
}

interface CoordinateFieldProps {
  label: string
  value: number
  max: number
  onChange: (value: number) => void
  onCommit: () => void
  onFocus: () => void
}

/**
 * A spinbutton bound to a value that something else can also change.
 *
 * The draft string is what makes it usable: without it, clearing the field to
 * retype a number would immediately parse as NaN and snap the pin back, so a
 * keyboard user could never type "412" over "38". While the field has focus
 * the draft wins; the moment it does not, the placement is the truth again —
 * which is what lets a drag on the canvas update the number live.
 */
function CoordinateField({ label, value, max, onChange, onCommit, onFocus }: CoordinateFieldProps) {
  const rounded = Math.round(value)
  const [draft, setDraft] = useState(String(rounded))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setDraft(String(rounded))
  }, [rounded])

  return (
    <Input
      type="number"
      inputMode="numeric"
      step={1}
      min={0}
      max={Math.round(max)}
      aria-label={label}
      value={draft}
      className="h-8 px-2 text-center text-xs tabular-nums"
      onFocus={() => {
        focused.current = true
        onFocus()
      }}
      onChange={(event) => {
        setDraft(event.target.value)
        const parsed = Number(event.target.value)
        if (event.target.value !== '' && Number.isFinite(parsed)) onChange(parsed)
      }}
      onBlur={() => {
        focused.current = false
        setDraft(String(rounded))
        onCommit()
      }}
    />
  )
}
