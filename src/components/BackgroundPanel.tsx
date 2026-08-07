import { AlertTriangle, Eraser, Loader2 } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import type { PhotoSpec } from '@/core/specs'
import { cn } from '@/lib/utils'

export type CleanupStatus = 'idle' | 'running' | 'ready' | 'failed'

interface BackgroundPanelProps {
  spec: PhotoSpec
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  status: CleanupStatus
  /** Edge softness, 0-1, mapped to a feather radius. */
  feather: number
  onFeatherChange: (value: number) => void
  onCommit: () => void
  /** Segmenter's own confidence, when it reported one. */
  quality: number | null
}

export function BackgroundPanel({
  spec,
  enabled,
  onEnabledChange,
  status,
  feather,
  onFeatherChange,
  onCommit,
  quality,
}: BackgroundPanelProps) {
  const lowQuality = quality !== null && quality < 0.5

  return (
    <section aria-labelledby="background-heading" className="space-y-3">
      <h2 id="background-heading" className="eyebrow">
        Background
      </h2>

      <div className="glass-card flex items-start gap-2.5 rounded-xl px-3 py-2.5">
        {status === 'running' ? (
          <Loader2
            className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
            aria-hidden
          />
        ) : (
          <Eraser className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <Label htmlFor="bg-cleanup" className="text-xs">
            Background cleanup
          </Label>
          <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
            Replaces the wall behind you with {spec.background.label.toLowerCase()}.
          </p>
        </div>
        <Switch
          id="bg-cleanup"
          checked={enabled}
          disabled={status === 'running'}
          onCheckedChange={(next) => {
            onEnabledChange(next)
            onCommit()
          }}
        />
      </div>

      {/*
        This warning is not boilerplate and is deliberately not hidden behind a
        tooltip. Several authorities — the US State Department among them —
        prohibit digitally altered photographs outright. Presenting background
        replacement as a clean fix would lead people to submit an application
        that gets rejected for a reason the tool caused.

        It is therefore explicitly exempt from the frosted, low-contrast
        treatment the rest of the panel uses: solid warn-tinted fill, a heavy
        left rule, a bold lead sentence, and `role="note"` so a screen reader
        announces it as a distinct passage rather than a stray paragraph. If a
        future restyle makes this quieter, that is a regression.
      */}
      <div
        role="note"
        className={cn(
          'flex items-start gap-2.5 rounded-xl border border-warn-edge border-l-4 border-l-warn',
          'bg-warn-wash px-3 py-3 text-warn',
        )}
      >
        <AlertTriangle className="mt-px size-4 shrink-0" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="text-xs leading-snug font-bold">
            Some authorities reject digitally altered photos.
          </p>
          <p className="text-[11px] leading-relaxed font-medium">
            Reshooting against a plain wall is always safer than editing one in. Use this
            only if you cannot retake the photo.
          </p>
        </div>
      </div>

      {enabled && (
        <>
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="feather" className="text-xs">
                Edge softness
              </Label>
              <span className="numeric text-[11px] font-medium">
                {Math.round(feather * 100)}
              </span>
            </div>
            <Slider
              id="feather"
              min={0}
              max={1}
              step={0.01}
              value={[feather]}
              onValueChange={([next]) => next !== undefined && onFeatherChange(next)}
              onValueCommit={onCommit}
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              Hair is where cut-outs look fake. Raise this until the edge stops looking
              cut with scissors, then stop.
            </p>
          </div>

          {status === 'failed' && (
            <p
              role="status"
              className="flex items-start gap-2.5 rounded-xl border border-fail-edge bg-fail-wash px-3 py-2.5 text-[11px] leading-relaxed font-medium text-fail"
            >
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                The subject could not be separated from the background. Retake the photo
                against a plainer wall with more contrast between you and it.
              </span>
            </p>
          )}

          {status === 'ready' && lowQuality && (
            <p
              role="status"
              className="flex items-start gap-2.5 rounded-xl border border-warn-edge bg-warn-wash px-3 py-2.5 text-[11px] leading-relaxed font-medium text-warn"
            >
              <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
              <span>
                The cut-out is low confidence — check the edges around your hair and
                shoulders closely before printing.
              </span>
            </p>
          )}
        </>
      )}
    </section>
  )
}
