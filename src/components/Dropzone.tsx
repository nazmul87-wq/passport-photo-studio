import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, Clipboard, FolderOpen, ImageUp, Lock } from 'lucide-react'
import { CameraCapture } from '@/components/CameraCapture'
import { Button } from '@/components/ui/button'
import { firstImageFile, loadImageFile, type LoadedImage } from '@/lib/loadImage'
import { cn } from '@/lib/utils'

interface DropzoneProps {
  onLoad: (image: LoadedImage) => void
  onError: (message: string) => void
}

/**
 * Photo intake. Accepts a drop, a file picker, or a paste — a phone photo is
 * often already on the clipboard, and forcing it through a file dialog is a
 * pointless extra step.
 */
export function Dropzone({ onLoad, onError }: DropzoneProps) {
  const [over, setOver] = useState(false)
  const [cameraOpen, setCameraOpen] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const hasCamera = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia)

  const accept = useCallback(
    async (file: File | null) => {
      if (!file) return
      try {
        onLoad(await loadImageFile(file))
      } catch (error) {
        onError(error instanceof Error ? error.message : 'That image could not be read.')
      }
    },
    [onLoad, onError],
  )

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = firstImageFile(event.clipboardData?.items ?? null)
      if (file) {
        event.preventDefault()
        void accept(file)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [accept])

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        void accept(firstImageFile(e.dataTransfer.items))
      }}
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-5 p-5 text-center transition-colors sm:p-8',
        over && 'bg-primary/8',
      )}
    >
      <div
        className={cn(
          'glass-raised relative w-full max-w-lg overflow-hidden rounded-3xl px-6 py-10 transition-all sm:px-10 sm:py-12',
          over && 'scale-[1.01] border-primary/60 ring-2 ring-primary/40',
        )}
      >
        {/* Dashed intake outline sits inside the glass rather than around it,
            so the panel keeps a clean silhouette and still reads as a target. */}
        <div
          aria-hidden
          className={cn(
            'pointer-events-none absolute inset-3 rounded-[1.25rem] border-2 border-dashed transition-colors',
            over ? 'border-primary/70' : 'border-input/45',
          )}
        />

        <div className="relative flex flex-col items-center gap-6">
          <div
            aria-hidden
            className={cn(
              'grid size-16 place-items-center rounded-2xl transition-colors',
              'bg-gradient-to-br from-primary/18 to-primary/5 ring-1 ring-primary/25',
              'shadow-[inset_0_1px_0_var(--glass-highlight)]',
            )}
          >
            <ImageUp
              className={cn('size-7 transition-colors', over ? 'text-primary' : 'text-primary/80')}
            />
          </div>

          <div className="space-y-2">
            <h2 className="text-xl font-semibold tracking-[-0.015em] text-balance">
              Drop a portrait photo here
            </h2>
            <p className="mx-auto max-w-[34ch] text-[13px] leading-relaxed text-balance text-muted-foreground">
              Shoulders up, facing the camera, plain wall, even light, no flash.
            </p>
          </div>

          <div className="flex flex-col items-center gap-3.5">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button size="lg" className="h-11" onClick={() => inputRef.current?.click()}>
                <FolderOpen className="size-4" aria-hidden />
                Choose a photo
              </Button>
              {hasCamera && (
                <Button
                  size="lg"
                  variant="outline"
                  className="h-11"
                  onClick={() => setCameraOpen(true)}
                >
                  <Camera className="size-4" aria-hidden />
                  Use camera
                </Button>
              )}
            </div>
            <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <Clipboard className="size-3.5" aria-hidden />
              or press Ctrl/Cmd + V to paste
            </span>
          </div>
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="sr-only"
          onChange={(e) => {
            void accept(e.target.files?.[0] ?? null)
            e.target.value = ''
          }}
        />
      </div>

      <p className="inline-flex max-w-md items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
        <Lock className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>
          Your photo is processed entirely in this browser tab. It is never uploaded,
          stored, or sent anywhere.
        </span>
      </p>

      <CameraCapture
        open={cameraOpen}
        onOpenChange={setCameraOpen}
        onCapture={onLoad}
        onError={onError}
      />
    </div>
  )
}
