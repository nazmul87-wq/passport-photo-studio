import { useCallback, useEffect, useRef, useState } from 'react'
import { Camera, CircleDot, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { loadImageFile, type LoadedImage } from '@/lib/loadImage'

interface CameraCaptureProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCapture: (image: LoadedImage) => void
  onError: (message: string) => void
}

/**
 * Take the photo directly instead of hunting for one in the camera roll.
 *
 * The preview is mirrored so framing yourself feels like a mirror, but the
 * captured frame is NOT — a flipped passport photo is a rejected one.
 */
export function CameraCapture({ open, onOpenChange, onCapture, onError }: CameraCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [ready, setReady] = useState(false)

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    setReady(false)
  }, [])

  useEffect(() => {
    if (!open) {
      stop()
      return
    }

    let cancelled = false
    navigator.mediaDevices
      ?.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      .then((stream) => {
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          void videoRef.current.play()
        }
        setReady(true)
      })
      .catch((err: unknown) => {
        onError(
          err instanceof DOMException && err.name === 'NotAllowedError'
            ? 'Camera access was blocked. Allow it in your browser settings, or choose a photo file instead.'
            : 'No camera is available. Choose a photo file instead.',
        )
        onOpenChange(false)
      })

    return () => {
      cancelled = true
      stop()
    }
  }, [open, stop, onError, onOpenChange])

  const capture = useCallback(async () => {
    const video = videoRef.current
    if (!video || !video.videoWidth) return

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // Drawn unmirrored: only the on-screen preview is flipped.
    ctx.drawImage(video, 0, 0)

    canvas.toBlob(
      (blob) => {
        if (!blob) {
          onError('The camera frame could not be captured.')
          return
        }
        void loadImageFile(new File([blob], 'camera.png', { type: 'image/png' }))
          .then((loaded) => {
            onCapture(loaded)
            onOpenChange(false)
          })
          .catch(() => onError('The camera frame could not be read.'))
      },
      'image/png',
    )
  }, [onCapture, onError, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Take a photo</DialogTitle>
        </DialogHeader>

        <div className="relative overflow-hidden rounded-lg bg-stage">
          <video
            ref={videoRef}
            playsInline
            muted
            className="block max-h-[60vh] w-full -scale-x-100 object-contain"
          />
          {/* A loose oval guide: close enough to frame by, not so precise that
              anyone mistakes it for the actual crop. */}
          <svg
            className="pointer-events-none absolute inset-0 h-full w-full"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
            aria-hidden
          >
            <ellipse
              cx="50"
              cy="44"
              rx="19"
              ry="30"
              fill="none"
              stroke="rgba(255,255,255,0.6)"
              strokeWidth="0.4"
              strokeDasharray="2 2"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        </div>

        <p className="text-xs text-muted-foreground">
          Face the camera straight on, shoulders in frame, plain wall behind you, even
          light and no flash.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            <X className="size-4" aria-hidden />
            Cancel
          </Button>
          <Button disabled={!ready} onClick={() => void capture()}>
            <CircleDot className="size-4" aria-hidden />
            Capture
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export { Camera as CameraIcon }
