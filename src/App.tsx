import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  Check,
  Download,
  Loader2,
  Moon,
  Redo2,
  RotateCcw,
  ScanFace,
  ShieldCheck,
  Sun,
  Undo2,
  X,
} from 'lucide-react'

import { AdjustPanel } from '@/components/AdjustPanel'
import { AlignStage, PIN_ORDER, PIN_STYLE } from '@/components/AlignStage'
import { BackgroundPanel, type CleanupStatus } from '@/components/BackgroundPanel'
import { CompliancePanel } from '@/components/CompliancePanel'
import { Dropzone } from '@/components/Dropzone'
import { LandmarkFields } from '@/components/LandmarkFields'
import { PhotoPreview } from '@/components/PhotoPreview'
import { SpecPicker, SpecSource } from '@/components/SpecPicker'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Slider } from '@/components/ui/slider'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'

import { detectFace } from '@/core/detect'
import { withDpi } from '@/core/encode'
import {
  autoWhiteBalance,
  NEUTRAL_ADJUSTMENTS,
  UNIT_GAINS,
  type Adjustments,
} from '@/core/enhance'
import { computeTransform } from '@/core/geometry'
import { renderFinalPhoto, type PhotoPipeline } from '@/core/pipeline'
import { PAPER_SIZES, planSheet, renderSheet } from '@/core/render'
import {
  compositeOnBackground,
  defaultFeatherPx,
  isPlausiblePersonMask,
  segmentPerson,
  type PersonMask,
} from '@/core/segment'
import { specPixelSize, specSizeLabel } from '@/core/specs'
import { formatMeasure, fromPx } from '@/core/units'
import { sampleBackground, validate, type BackgroundSample, type Finding } from '@/core/validate'
import { canvasToBlob, downloadBlob, type LoadedImage } from '@/lib/loadImage'
import { useTheme } from '@/lib/useTheme'
import { cn } from '@/lib/utils'
import { useEditor, type LandmarkKey } from '@/state/useEditor'

interface DetectionState {
  status: 'idle' | 'running' | 'done' | 'partial' | 'failed'
  message?: string
  confidence?: number
}

export default function App() {
  const editor = useEditor()
  const [theme, toggleTheme] = useTheme()
  const [activePin, setActivePin] = useState<LandmarkKey>('crown')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [adjustments, setAdjustments] = useState<Adjustments>(NEUTRAL_ADJUSTMENTS)
  const [awbEnabled, setAwbEnabled] = useState(false)
  const [background, setBackground] = useState<BackgroundSample | null>(null)
  const [sampling, setSampling] = useState(false)
  const [detection, setDetection] = useState<DetectionState>({ status: 'idle' })
  const [cleanupEnabled, setCleanupEnabled] = useState(false)
  const [cleanupStatus, setCleanupStatus] = useState<CleanupStatus>('idle')
  const [feather, setFeather] = useState(0.5)
  const [personMask, setPersonMask] = useState<PersonMask | null>(null)
  const [composited, setComposited] = useState<HTMLCanvasElement | null>(null)

  const { spec, paper, sheet, image, placement } = editor

  const gains = useMemo(
    () => (awbEnabled && background ? autoWhiteBalance(background) : UNIT_GAINS),
    [awbEnabled, background],
  )

  // The composite only counts when the toggle is on. Hoisted out of the
  // pipeline memo because the background sampler needs the same gated value and
  // must not reach into `pipeline` for it — see that effect for why.
  const activeComposite = cleanupEnabled ? composited : null

  const pipeline = useMemo<PhotoPipeline>(
    () => ({ adjustments, gains, composited: activeComposite }),
    [adjustments, gains, activeComposite],
  )

  const transform = useMemo(
    () => (placement ? computeTransform(spec, placement) : null),
    [spec, placement],
  )

  const layout = useMemo(() => planSheet(spec, paper, sheet), [spec, paper, sheet])

  const findings = useMemo<Finding[]>(() => {
    if (!image || !placement || !transform) return []
    return validate({
      spec,
      placement,
      transform,
      imageWidth: image.width,
      imageHeight: image.height,
      background: background ?? undefined,
      backgroundReplaced: Boolean(activeComposite),
    })
  }, [spec, placement, transform, image, background, activeComposite])

  /**
   * Background sampling is debounced and runs on its own offscreen canvas.
   * Reading pixels back out of the live preview would mean the preview's render
   * effect feeds state that re-renders the preview — cheap to write, and a
   * reliable way to lock the tab up.
   *
   * The composite is included, so the panel judges the pixels that will
   * actually be exported. Leaving it out had the panel reporting the original
   * wall while the export carried a clean one — precisely the preview/export
   * disagreement `renderFinalPhoto` exists to prevent.
   *
   * White balance is the deliberate exception, forced back to unit gains. Those
   * gains are *derived from this measurement*, so feeding a corrected
   * background back in would report success unconditionally and the check would
   * be worthless. The composite is not like that: it is an edit the user made,
   * and an examiner sees its result.
   *
   * That asymmetry is also why this builds its own pipeline rather than
   * spreading `pipeline` and overriding `gains`. `pipeline` carries the AWB
   * gains, which depend on `background`, which this effect sets — depending on
   * it here closes a render loop that re-samples forever.
   */
  const sampleCanvasRef = useRef<HTMLCanvasElement | null>(null)
  useEffect(() => {
    if (!image || !placement) {
      setBackground(null)
      return
    }
    setSampling(true)
    const timer = window.setTimeout(() => {
      const canvas = (sampleCanvasRef.current ??= document.createElement('canvas'))
      renderFinalPhoto(
        spec,
        image.bitmap,
        placement,
        { adjustments, gains: UNIT_GAINS, composited: activeComposite },
        canvas,
      )
      setBackground(sampleBackground(canvas, spec))
      setSampling(false)
    }, 140)
    return () => {
      window.clearTimeout(timer)
      setSampling(false)
    }
  }, [spec, image, placement, adjustments, activeComposite])

  /**
   * Segment the subject once per image, the first time cleanup is switched on.
   * Segmentation takes seconds, so it is not run speculatively on upload — a
   * user who never touches the toggle never pays for it.
   */
  useEffect(() => {
    if (!cleanupEnabled || !image || personMask) return
    // 'failed' must short-circuit too. Without it the effect re-fires the
    // moment it sets the failure state — the mask is still null and the toggle
    // is still on — and retries a multi-second inference forever.
    if (cleanupStatus === 'running' || cleanupStatus === 'failed') return
    let cancelled = false
    setCleanupStatus('running')
    void segmentPerson(image)
      .then((mask) => {
        if (cancelled) return
        // A mask can come back "successful" and still contain no subject —
        // the model reports full confidence on images it does not understand.
        // Compositing that yields a blank photo, so coverage is checked here
        // rather than trusting the reported quality.
        if (!mask || !isPlausiblePersonMask(mask)) {
          setCleanupStatus('failed')
          return
        }
        setPersonMask(mask)
        setCleanupStatus('ready')
      })
      .catch(() => {
        if (!cancelled) setCleanupStatus('failed')
      })
    return () => {
      cancelled = true
    }
  }, [cleanupEnabled, image, personMask, cleanupStatus])

  // Recomposite when the mask, the feather or the target colour changes. The
  // composite is at source resolution and feeds the crop, so it must exist
  // before renderPhoto runs — hence a canvas in state rather than a ref.
  useEffect(() => {
    if (!image || !personMask || !cleanupEnabled) {
      setComposited(null)
      return
    }
    const featherPx =
      feather * defaultFeatherPx(personMask.width, personMask.height) * 2
    setComposited(
      compositeOnBackground(image, personMask, spec.background, { featherPx }),
    )
  }, [image, personMask, cleanupEnabled, feather, spec.background])

  // A new photo invalidates every cached mask and composite.
  useEffect(() => {
    setPersonMask(null)
    setComposited(null)
    setCleanupStatus('idle')
    setCleanupEnabled(false)
  }, [image])

  // Undo/redo from the keyboard. The editor object is rebuilt on every render,
  // so it goes through a ref rather than the dependency array — otherwise the
  // listener is torn down and re-added on every pointer move during a drag.
  const editorRef = useRef(editor)
  editorRef.current = editor
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return
      event.preventDefault()
      if (event.shiftKey) editorRef.current.redo()
      else editorRef.current.undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  /**
   * Load a photo, then try to place the landmarks automatically.
   *
   * Detection is best-effort and never blocking: the image is shown with the
   * fallback placement immediately, and the pins snap into place when the model
   * finishes. If it fails — no face, no WebAssembly, model missing — the user
   * simply places the pins by hand, exactly as before, and is told why.
   */
  const handleLoad = useCallback(
    (loaded: LoadedImage) => {
      setError(null)
      setAdjustments(NEUTRAL_ADJUSTMENTS)
      setAwbEnabled(false)
      editor.setImage(loaded)
      setActivePin('crown')
      setDetection({ status: 'running' })

      void detectFace(loaded)
        .then((result) => {
          if (!result) {
            setDetection({
              status: 'failed',
              message: 'No face was found — place the three pins yourself.',
            })
            return
          }
          editor.setDetectedLandmarks(result.landmarks)
          editor.commitHistory()
          setDetection({
            status: result.source === 'detected' ? 'done' : 'partial',
            message: result.note,
            confidence: result.confidence,
          })
          // A crown that was estimated rather than measured is the one pin
          // worth looking at, so start the user there.
          setActivePin(result.source === 'detected' ? 'chin' : 'crown')
        })
        .catch(() => {
          setDetection({
            status: 'failed',
            message: 'Automatic detection is unavailable — place the pins yourself.',
          })
        })
    },
    [editor],
  )

  const applyFix = useCallback(
    (finding: Finding) => {
      if (!finding.fix || !placement) return
      editor.setPlacement(finding.fix.apply(placement))
      editor.commitHistory()
    },
    [editor, placement],
  )

  const exportImage = useCallback(
    async (kind: 'single' | 'sheet') => {
      if (!image || !placement) return
      setBusy(true)
      try {
        const photo = renderFinalPhoto(spec, image.bitmap, placement, pipeline)
        const canvas = kind === 'single' ? photo : renderSheet(spec, photo, paper, sheet).canvas
        const blob = await canvasToBlob(canvas, 'image/png')
        // Stamp the physical resolution so the print lands at true size rather
        // than being scaled to fit by the print dialog.
        const stamped = await withDpi(blob, spec.dpi)
        const suffix = kind === 'single' ? 'photo' : `sheet-${paper.id}`
        downloadBlob(stamped, `passport-${spec.id}-${suffix}.png`)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'The export failed.')
      } finally {
        setBusy(false)
      }
    },
    [image, placement, spec, paper, sheet, pipeline],
  )

  const ready = Boolean(image && placement && transform)
  const pixels = specPixelSize(spec)

  return (
    <div className="flex min-h-dvh flex-col lg:h-dvh lg:overflow-hidden">
      <a className="skip-link" href="#stage">
        Skip to the photo
      </a>

      <AppHeader
        theme={theme}
        onToggleTheme={toggleTheme}
        canUndo={editor.canUndo}
        canRedo={editor.canRedo}
        onUndo={editor.undo}
        onRedo={editor.redo}
      />

      {error && (
        <div
          role="alert"
          className="flex shrink-0 items-start gap-2 border-b border-fail-edge bg-fail-wash px-4 py-2.5 text-sm text-fail sm:px-6"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 leading-relaxed">{error}</span>
          <Button
            variant="ghost"
            size="icon-sm"
            className="-my-0.5 shrink-0 text-fail hover:bg-fail/10 hover:text-fail"
            onClick={() => setError(null)}
            aria-label="Dismiss this message"
          >
            <X className="size-4" aria-hidden />
          </Button>
        </div>
      )}

      {/*
        Inset app shell. The panels are floated off the edges with a gutter
        between them so the ambient ground stays visible around and between
        them — without that gap a frosted surface has nothing to be frosted
        over and just reads as an opaque box. Full-bleed below `lg`, where
        every pixel of width matters more than the effect does.
      */}
      <div
        className={cn(
          'grid flex-1 grid-cols-1 lg:min-h-0 lg:gap-3 lg:p-3',
          'lg:grid-cols-[19rem_minmax(0,1fr)_23rem] xl:grid-cols-[20.5rem_minmax(0,1fr)_25.5rem]',
          // Room for the fixed mobile action bar, so nothing is stranded under it.
          ready && 'pb-[8.75rem] lg:pb-0',
        )}
      >
        {/* Left rail: what we are making. */}
        <aside
          aria-label="Document specification"
          className="glass-panel glass-edge order-1 flex flex-col gap-5 border-b p-4 lg:min-h-0 lg:gap-6 lg:overflow-y-auto lg:rounded-2xl lg:border lg:p-5"
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-1 lg:gap-5">
            <section className="space-y-2">
              <Label className="text-[13px]">Country &amp; document</Label>
              <SpecPicker value={spec} onChange={editor.setSpec} />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {spec.documents.join(' · ')}
              </p>
            </section>

            <section className="space-y-2">
              <Label htmlFor="paper" className="text-[13px]">
                Print on
              </Label>
              <Select value={paper.id} onValueChange={editor.setPaper}>
                <SelectTrigger id="paper" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PAPER_SIZES.map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                {layout.count} photos per sheet ({layout.cols}×{layout.rows}
                {layout.rotated ? ', rotated' : ''})
              </p>
            </section>
          </div>

          {/*
            Pre-shoot guidance is only actionable before there is a photo. On a
            phone it steps aside once one is loaded, so the alignment stage is
            not pushed a screen and a half down the page by advice the user has
            already acted on.
          */}
          <div className={cn('space-y-5', image && 'hidden lg:block')}>
            <div className="h-px bg-border" />

            <section className="space-y-2.5">
              <h2 className="eyebrow">Before you shoot</h2>
              <ul className="space-y-2 text-xs leading-relaxed text-muted-foreground">
                {spec.notes?.map((note) => (
                  <li key={note} className="flex gap-2.5">
                    <span
                      aria-hidden
                      className="mt-[0.4rem] size-1.5 shrink-0 rounded-full bg-primary/45"
                    />
                    {note}
                  </li>
                ))}
              </ul>
            </section>

            <SpecSource spec={spec} />
          </div>
        </aside>

        {/* Centre: the alignment stage. Opaque, isolated, and never covered by
            a blurred surface — see .stage-surface. */}
        <main
          id="stage"
          className={cn(
            'relative order-2 min-h-[52svh] overflow-hidden border-b lg:min-h-0 lg:rounded-2xl lg:border lg:border-glass-border lg:shadow-[var(--shadow-panel)]',
            // Only the live stage takes the opaque, contained surface. With no
            // photo loaded there is nothing to keep colour-true, so the empty
            // state is allowed to sit on the ambient backdrop like everything
            // else.
            image ? 'stage-surface' : 'bg-stage/35',
          )}
        >
          {image && placement ? (
            <AlignStage
              spec={spec}
              image={image}
              placement={placement}
              activePin={activePin}
              onActivePinChange={setActivePin}
              onLandmarkChange={editor.setLandmark}
              onGestureEnd={editor.commitHistory}
            />
          ) : (
            <Dropzone onLoad={handleLoad} onError={setError} />
          )}
        </main>

        {/* Right rail: the result, why it does or does not pass, and the exit. */}
        <aside
          aria-label="Result and controls"
          className="glass-panel glass-edge order-3 flex flex-col lg:min-h-0 lg:overflow-y-auto lg:rounded-2xl lg:border"
        >
          {ready && image && placement && transform ? (
            <div className="flex flex-col gap-5 p-4 lg:p-5">
              <section aria-labelledby="final-photo-heading" className="space-y-2.5">
                <div className="flex items-baseline justify-between gap-2">
                  <h2 id="final-photo-heading" className="eyebrow">
                    Final photo
                  </h2>
                  <span className="numeric text-[11px] text-muted-foreground">
                    {pixels.width}×{pixels.height} px
                  </span>
                </div>

                {/* Glass frame, opaque mat, untouched pixels. Nothing may be
                    layered over the canvas: the compliance panel samples the
                    same render, so a tint would make both the user and the
                    validator judge a colour the export does not have. */}
                <div className="glass-card rounded-2xl p-2.5">
                  <div className="photo-mat overflow-hidden rounded-xl p-2 ring-1 ring-black/5 dark:ring-white/10">
                    <PhotoPreview
                      spec={spec}
                      image={image}
                      placement={placement}
                      pipeline={pipeline}
                    />
                  </div>
                  <div className="mt-2.5 flex items-center justify-between gap-2 px-1.5">
                    <span className="truncate text-[11px] font-medium text-muted-foreground">
                      {spec.country} · {specSizeLabel(spec)}
                    </span>
                    <span className="numeric shrink-0 text-[11px] text-muted-foreground">
                      {spec.dpi} DPI
                    </span>
                  </div>
                </div>
              </section>

              <CompliancePanel findings={findings} onApplyFix={applyFix} pending={sampling} />

              <Tabs defaultValue="align">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="align">Align</TabsTrigger>
                  <TabsTrigger value="adjust">Adjust</TabsTrigger>
                </TabsList>

                <TabsContent value="align" className="mt-4 space-y-5">
                  <DetectionStatus state={detection} />

                  <section aria-labelledby="pin-heading" className="space-y-2.5">
                    <h3 id="pin-heading" className="eyebrow">
                      Landmark on the photo
                    </h3>
                    <div className="grid grid-cols-3 gap-1.5">
                      {PIN_ORDER.map((key) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => setActivePin(key)}
                          aria-pressed={activePin === key}
                          className={cn(
                            'rounded-lg border px-2 py-2 text-[11px] font-semibold tracking-wide transition-colors',
                            activePin === key
                              ? 'border-primary/60 bg-primary/12 text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
                              : 'border-glass-border text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                          )}
                        >
                          <span
                            aria-hidden
                            className="mr-1.5 inline-block size-2 rounded-full align-middle ring-1 ring-black/20 dark:ring-white/25"
                            style={{ backgroundColor: PIN_STYLE[key].color }}
                          />
                          {PIN_STYLE[key].label}
                        </button>
                      ))}
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Drag on the photo, or focus it and use the arrow keys — Shift for
                      10px steps, <kbd className="numeric">[</kbd> and{' '}
                      <kbd className="numeric">]</kbd> to switch landmark.
                    </p>
                  </section>

                  <LandmarkFields
                    placement={placement}
                    imageWidth={image.width}
                    imageHeight={image.height}
                    activePin={activePin}
                    onActivePinChange={setActivePin}
                    onLandmarkChange={editor.setLandmark}
                    onCommit={editor.commitHistory}
                  />

                  <section aria-labelledby="framing-heading" className="space-y-4">
                    <h3 id="framing-heading" className="eyebrow">
                      Framing
                    </h3>
                    <SliderRow
                      id="head"
                      label="Head height"
                      value={placement.headHeight}
                      min={spec.head.min}
                      max={spec.head.max}
                      step={spec.unit === 'mm' ? 0.1 : 0.005}
                      display={formatMeasure(placement.headHeight, spec.unit)}
                      hint={`${formatMeasure(spec.head.min, spec.unit)} – ${formatMeasure(spec.head.max, spec.unit)}`}
                      onChange={editor.setHeadHeight}
                      onCommit={editor.commitHistory}
                    />
                    <SliderRow
                      id="eye"
                      label="Eyes above the bottom edge"
                      value={placement.eyeHeight}
                      min={spec.eye.min}
                      max={spec.eye.max}
                      step={spec.unit === 'mm' ? 0.1 : 0.005}
                      display={formatMeasure(placement.eyeHeight, spec.unit)}
                      hint={`${formatMeasure(spec.eye.min, spec.unit)} – ${formatMeasure(spec.eye.max, spec.unit)}`}
                      onChange={editor.setEyeHeight}
                      onCommit={editor.commitHistory}
                    />
                    <SliderRow
                      id="roll"
                      label="Level"
                      value={placement.rollAdjustDeg}
                      min={-15}
                      max={15}
                      step={0.1}
                      display={`${placement.rollAdjustDeg.toFixed(1)}°`}
                      hint={`Automatic levelling applied ${((-transform.autoAngle * 180) / Math.PI).toFixed(1)}°`}
                      onChange={editor.setRoll}
                      onCommit={editor.commitHistory}
                    />
                  </section>

                  <section aria-labelledby="measures-heading" className="space-y-2.5">
                    <h3 id="measures-heading" className="eyebrow">
                      Measurements
                    </h3>
                    <dl className="glass-card space-y-1.5 rounded-xl px-3 py-2.5">
                      <MeasureRow
                        label="Print resolution"
                        value={`${Math.round(transform.effectiveDpi)} DPI`}
                        tone={
                          transform.effectiveDpi >= spec.dpi
                            ? 'pass'
                            : transform.effectiveDpi >= 210
                              ? 'warn'
                              : 'fail'
                        }
                      />
                      {spec.headroom && (
                        <MeasureRow
                          label="Space above the head"
                          value={formatMeasure(
                            fromPx(transform.headroomPx, spec.unit, spec.dpi),
                            spec.unit,
                          )}
                        />
                      )}
                      <MeasureRow
                        label="Eye line in the head"
                        value={`${Math.round(transform.eyeRatio * 100)}% from the crown`}
                      />
                    </dl>
                  </section>
                </TabsContent>

                <TabsContent value="adjust" className="mt-4 space-y-5">
                  <AdjustPanel
                    adjustments={adjustments}
                    onChange={setAdjustments}
                    onCommit={editor.commitHistory}
                    autoWhiteBalance={awbEnabled}
                    onAutoWhiteBalanceChange={setAwbEnabled}
                    castStrength={background?.spread ?? null}
                  />

                  <div className="h-px bg-border" />

                  <BackgroundPanel
                    spec={spec}
                    enabled={cleanupEnabled}
                    onEnabledChange={(next) => {
                      // Switching it back on is the user asking to try again,
                      // which the 'failed' short-circuit would otherwise block.
                      if (next && cleanupStatus === 'failed') setCleanupStatus('idle')
                      setCleanupEnabled(next)
                    }}
                    status={cleanupStatus}
                    feather={feather}
                    onFeatherChange={setFeather}
                    onCommit={editor.commitHistory}
                    quality={personMask?.quality ?? null}
                  />
                </TabsContent>
              </Tabs>

              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Stamped at {spec.dpi} DPI. Print at 100% scale — if the print dialog offers
                “fit to page”, turn it off, or every photo comes out the wrong size.
              </p>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
              <div className="glass-card grid size-12 place-items-center rounded-2xl">
                <ScanFace className="size-5 text-muted-foreground" aria-hidden />
              </div>
              <p className="max-w-[30ch] text-[13px] leading-relaxed text-balance text-muted-foreground">
                Load a photo and the finished result appears here, checked against every
                rule in the spec.
              </p>
            </div>
          )}

          {ready && (
            <div className="action-bar fixed inset-x-0 bottom-0 z-40 mt-auto lg:sticky lg:inset-x-auto lg:z-10">
              <div className="mx-auto max-w-md space-y-2 p-3 sm:max-w-lg lg:max-w-none lg:p-4">
                <Button
                  className="h-11 w-full text-[13px] lg:h-10"
                  disabled={busy}
                  onClick={() => void exportImage('sheet')}
                >
                  {busy ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <Download className="size-4" aria-hidden />
                  )}
                  Download {layout.count}-photo sheet
                </Button>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    className="h-10 flex-1 text-[13px]"
                    disabled={busy}
                    onClick={() => void exportImage('single')}
                  >
                    Single photo
                  </Button>
                  <Button
                    variant="outline"
                    size="icon-lg"
                    onClick={() => editor.setImage(null)}
                    aria-label="Start over with a different photo"
                    title="Start over"
                  >
                    <RotateCcw className="size-4" aria-hidden />
                  </Button>
                </div>
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>
  )
}

interface AppHeaderProps {
  theme: string
  onToggleTheme: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
}

function AppHeader({
  theme,
  onToggleTheme,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
}: AppHeaderProps) {
  return (
    <header className="glass-panel sticky top-0 z-30 flex shrink-0 items-center gap-3 border-b px-3 py-2.5 shadow-[0_1px_0_var(--glass-highlight)_inset,0_8px_24px_-20px_rgb(0_0_0/0.5)] sm:px-5 lg:static">
      <div className="flex min-w-0 items-center gap-2.5">
        <div
          aria-hidden
          className="grid size-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-primary to-primary/70 text-primary-foreground shadow-[0_2px_8px_-2px_var(--primary),inset_0_1px_0_oklch(1_0_0/0.35)]"
        >
          <svg viewBox="0 0 24 24" className="size-[18px]" fill="none" aria-hidden>
            <rect
              x="3.5"
              y="2.5"
              width="17"
              height="19"
              rx="3"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <circle cx="12" cy="10" r="3.1" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M6.8 18.4c1-2.3 3-3.5 5.2-3.5s4.2 1.2 5.2 3.5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </div>
        <div className="min-w-0 leading-tight">
          <h1 className="truncate text-[15px] font-semibold tracking-[-0.01em]">
            Passport Photo Studio
          </h1>
          <p className="hidden text-[11px] text-muted-foreground sm:block">
            Compliant photo sheets, made in your browser
          </p>
        </div>
      </div>

      <p className="glass-card ml-2 hidden items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-medium text-muted-foreground md:inline-flex">
        <ShieldCheck className="size-3.5 text-pass" aria-hidden />
        Nothing leaves your device
      </p>

      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        <div className="glass-card flex items-center gap-0.5 rounded-xl p-0.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-[0.6rem]"
            onClick={onUndo}
            disabled={!canUndo}
            aria-label="Undo"
            title="Undo (Ctrl+Z)"
          >
            <Undo2 className="size-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-[0.6rem]"
            onClick={onRedo}
            disabled={!canRedo}
            aria-label="Redo"
            title="Redo (Ctrl+Shift+Z)"
          >
            <Redo2 className="size-4" aria-hidden />
          </Button>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="glass-card rounded-xl"
          onClick={onToggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? (
            <Sun className="size-4" aria-hidden />
          ) : (
            <Moon className="size-4" aria-hidden />
          )}
        </Button>
      </div>
    </header>
  )
}

/**
 * What the detector did, in one line.
 *
 * A 'partial' result is called out rather than hidden: the crown was estimated
 * instead of measured, and that is exactly the pin a user should glance at
 * before trusting the crop. Silently presenting an estimate as a measurement is
 * how someone ends up printing a sheet with the head 2 mm out.
 *
 * It is a live region because detection finishes several seconds after the
 * upload, long after focus has moved on. Without one, a screen-reader user is
 * never told that three pins just moved.
 */
function DetectionStatus({ state }: { state: DetectionState }) {
  const label =
    state.status === 'running'
      ? 'Finding the face…'
      : state.status === 'done'
        ? 'Landmarks placed automatically. Check them and nudge if needed.'
        : state.status === 'partial'
          ? (state.message ?? 'The top of the head was estimated — check the CROWN pin.')
          : (state.message ?? 'Place the three pins yourself.')

  const tone =
    state.status === 'done'
      ? 'border-pass-edge bg-pass-wash text-pass'
      : state.status === 'partial'
        ? 'border-warn-edge bg-warn-wash text-warn'
        : state.status === 'failed'
          ? 'border-border text-muted-foreground'
          : 'border-glass-border text-muted-foreground'

  const Icon =
    state.status === 'running' ? Loader2 : state.status === 'done' ? Check : AlertTriangle

  return (
    <div role="status" aria-live="polite" className="empty:hidden">
      {state.status !== 'idle' && (
        <p
          className={cn(
            'flex items-start gap-2 rounded-xl border px-3 py-2.5 text-[11px] leading-relaxed',
            tone,
          )}
        >
          <Icon
            className={cn(
              'mt-px size-3.5 shrink-0',
              state.status === 'running' && 'animate-spin',
            )}
            aria-hidden
          />
          <span>{label}</span>
        </p>
      )}
    </div>
  )
}

interface SliderRowProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  display: string
  hint: string
  onChange: (value: number) => void
  onCommit: () => void
}

function SliderRow({
  id,
  label,
  value,
  min,
  max,
  step,
  display,
  hint,
  onChange,
  onCommit,
}: SliderRowProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id} className="text-xs">
          {label}
        </Label>
        <span className="numeric text-xs font-medium">{display}</span>
      </div>
      <Slider
        id={id}
        min={min}
        max={max}
        step={step}
        value={[value]}
        onValueChange={([next]) => next !== undefined && onChange(next)}
        onValueCommit={onCommit}
      />
      <p className="text-[11px] text-muted-foreground">{hint}</p>
    </div>
  )
}

function MeasureRow({
  label,
  value,
  tone,
}: {
  label: string
  value: string
  tone?: 'pass' | 'warn' | 'fail'
}) {
  return (
    <div className="flex items-center justify-between gap-2 text-xs">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          'numeric font-medium',
          tone === 'pass' && 'text-pass',
          tone === 'warn' && 'text-warn',
          tone === 'fail' && 'text-fail',
        )}
      >
        {value}
      </dd>
    </div>
  )
}
