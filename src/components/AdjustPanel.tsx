import { RotateCcw, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { NEUTRAL_ADJUSTMENTS, type Adjustments } from '@/core/enhance'
import { cn } from '@/lib/utils'

interface AdjustPanelProps {
  adjustments: Adjustments
  onChange: (next: Adjustments) => void
  onCommit: () => void
  autoWhiteBalance: boolean
  onAutoWhiteBalanceChange: (enabled: boolean) => void
  /** How strong the detected colour cast is, for the hint text. */
  castStrength: number | null
}

const CONTROLS: Array<{ key: keyof Adjustments; label: string }> = [
  { key: 'exposure', label: 'Exposure' },
  { key: 'contrast', label: 'Contrast' },
  { key: 'shadows', label: 'Shadows' },
  { key: 'highlights', label: 'Highlights' },
  { key: 'temperature', label: 'Warmth' },
  { key: 'saturation', label: 'Saturation' },
]

export function AdjustPanel({
  adjustments,
  onChange,
  onCommit,
  autoWhiteBalance,
  onAutoWhiteBalanceChange,
  castStrength,
}: AdjustPanelProps) {
  const touched = CONTROLS.some((c) => adjustments[c.key] !== 0)
  const notableCast = castStrength !== null && castStrength > 6

  return (
    <section aria-labelledby="adjust-heading" className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id="adjust-heading" className="eyebrow">
          Colour &amp; light
        </h2>
        {touched && (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              onChange(NEUTRAL_ADJUSTMENTS)
              onCommit()
            }}
          >
            <RotateCcw className="size-3" aria-hidden />
            Reset all
          </Button>
        )}
      </div>

      <div
        className={cn(
          'glass-card flex items-start gap-2.5 rounded-xl px-3 py-2.5',
          notableCast && !autoWhiteBalance && 'border-warn-edge bg-warn-wash',
        )}
      >
        <Sparkles
          className={cn(
            'mt-0.5 size-4 shrink-0',
            notableCast && !autoWhiteBalance ? 'text-warn' : 'text-muted-foreground',
          )}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <Label htmlFor="awb" className="text-xs">
            Auto white balance
          </Label>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            {castStrength === null
              ? 'Neutralises a colour cast using the background corners as the reference.'
              : notableCast
                ? 'The wall behind you has a colour cast. Correcting it is the usual difference between a pass and a fail on the background rule.'
                : 'The background is already close to neutral.'}
          </p>
        </div>
        <Switch
          id="awb"
          checked={autoWhiteBalance}
          onCheckedChange={(next) => {
            onAutoWhiteBalanceChange(next)
            onCommit()
          }}
        />
      </div>

      <div className="space-y-3">
        {CONTROLS.map(({ key, label }) => (
          <div key={key} className="space-y-1.5">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={key} className="text-xs">
                {label}
              </Label>
              <span
                className={cn(
                  'numeric text-[11px]',
                  adjustments[key] === 0
                    ? 'text-muted-foreground'
                    : 'font-semibold text-foreground',
                )}
              >
                {adjustments[key] > 0 ? '+' : ''}
                {Math.round(adjustments[key] * 100)}
              </span>
            </div>
            <Slider
              id={key}
              min={-1}
              max={1}
              step={0.01}
              value={[adjustments[key]]}
              onValueChange={([next]) =>
                next !== undefined && onChange({ ...adjustments, [key]: next })
              }
              onValueCommit={onCommit}
            />
          </div>
        ))}
      </div>

      <p className="rounded-xl border border-border/70 px-3 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
        Adjustments affect colour and brightness only. Never reshape or retouch facial
        features — <strong className="font-semibold text-foreground">every authority
        rejects an altered face.</strong>
      </p>
    </section>
  )
}
