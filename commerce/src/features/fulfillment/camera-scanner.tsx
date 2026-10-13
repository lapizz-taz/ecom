import { CameraOff, Flashlight, FlashlightOff, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorLike { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = (new (options?: { formats?: string[] }) => BarcodeDetectorLike) & { getSupportedFormats?: () => Promise<string[]> }

/** What shipping labels carry: tracking and invoice barcodes, and QR codes. Fewer formats = faster reads. */
const FORMATS = ['code_128', 'qr_code', 'code_39', 'ean_13']
/** The part of the frame inside the guide box (as a share of width and height): only that is read. */
const BAND = { x: 0.08, y: 0.3, w: 0.84, h: 0.4 }

type TorchTrack = Omit<MediaStreamTrack, 'getCapabilities'> & { getCapabilities?: () => { torch?: boolean } }

/**
 * Reads barcodes with the device camera, as fast as the phone allows:
 * the browser's BarcodeDetector (Chrome / Android) on the guide band of every
 * frame, ZXing elsewhere (iPhone) with no pause between attempts. Turns the
 * torch on where the camera has one. The same code read again within 2.5 s
 * is ignored.
 */
export type TorchState = { supported: boolean; on: boolean }

/**
 * `torchOn` lets the page drive the flashlight (a button next to "Camera");
 * `onTorchState` reports whether this camera has one and whether it is on.
 */
export function CameraScanner({ onScan, onClose, torchOn, onTorchState }: {
  onScan: (code: string) => void
  onClose: () => void
  torchOn?: boolean
  onTorchState?: (state: TorchState) => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const trackRef = useRef<TorchTrack | null>(null)
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const [error, setError] = useState<string | null>(null)
  const [torch, setTorchState] = useState<TorchState>({ supported: false, on: false })
  const [flash, setFlash] = useState(0)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan
  const reportRef = useRef(onTorchState)
  reportRef.current = onTorchState
  const wantTorch = useRef(Boolean(torchOn))
  wantTorch.current = Boolean(torchOn)
  const setTorch = (next: TorchState) => { setTorchState(next); reportRef.current?.(next) }
  const applyRef = useRef<((on: boolean) => Promise<void>) | null>(null)

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let frame: number | undefined
    let zxingControls: { stop: () => void } | null = null

    const emit = (raw: string) => {
      const code = raw.trim()
      const now = Date.now()
      if (!code || (code === last.current.code && now - last.current.at < 2500)) return
      last.current = { code, at: now }
      setFlash((n) => n + 1)
      navigator.vibrate?.(35)
      onScanRef.current(code)
    }

    const start = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        })
        if (stopped || !videoRef.current) { stream.getTracks().forEach((t) => t.stop()); return }
        const track = stream.getVideoTracks()[0] as TorchTrack | undefined
        trackRef.current = track ?? null
        // Continuous focus where the camera allows it (labels are read up close).
        await track?.applyConstraints({ advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet] }).catch(() => undefined)
        const hasTorch = Boolean(track?.getCapabilities?.().torch)
        setTorch({ supported: hasTorch, on: false })
        // The page asked for the light before the camera was ready.
        if (hasTorch && wantTorch.current) await applyTorch(true)
        const video = videoRef.current
        video.srcObject = stream
        await video.play()

        const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
        const supported = Detector?.getSupportedFormats ? await Detector.getSupportedFormats().catch(() => []) : FORMATS
        const formats = FORMATS.filter((f) => supported.includes(f))
        if (Detector && formats.length) {
          const detector = new Detector({ formats })
          const canvas = document.createElement('canvas')
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          let busy = false
          const tick = () => {
            if (stopped) return
            frame = requestAnimationFrame(tick)
            if (busy || video.readyState < 2 || !ctx) return
            busy = true
            const vw = video.videoWidth
            const vh = video.videoHeight
            canvas.width = Math.round(vw * BAND.w)
            canvas.height = Math.round(vh * BAND.h)
            ctx.drawImage(video, vw * BAND.x, vh * BAND.y, canvas.width, canvas.height, 0, 0, canvas.width, canvas.height)
            detector.detect(canvas)
              .then((found) => { if (found[0]?.rawValue) emit(found[0].rawValue) })
              .catch(() => undefined)
              .finally(() => { busy = false })
          }
          tick()
        } else {
          const [{ BrowserMultiFormatReader }, { BarcodeFormat, DecodeHintType }] = await Promise.all([import('@zxing/browser'), import('@zxing/library')])
          if (stopped || !stream) return
          const hints = new Map<(typeof DecodeHintType)[keyof typeof DecodeHintType], unknown>([
            [DecodeHintType.POSSIBLE_FORMATS, [BarcodeFormat.CODE_128, BarcodeFormat.QR_CODE, BarcodeFormat.CODE_39, BarcodeFormat.EAN_13]],
          ])
          // The default waits 500 ms between attempts; labels are read on the next frame instead.
          const reader = new BrowserMultiFormatReader(hints, { delayBetweenScanAttempts: 40, delayBetweenScanSuccess: 300 })
          zxingControls = await reader.decodeFromStream(stream, video, (result) => {
            if (result) emit(result.getText())
          })
        }
      } catch (e) {
        setError((e as Error).name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access in the browser settings, or use a USB scanner.'
          : 'No camera available. Use a USB / Bluetooth scanner or type the code.')
      }
    }
    const applyTorch = async (on: boolean) => {
      const track = trackRef.current
      if (!track) return
      try {
        await track.applyConstraints({ advanced: [{ torch: on } as MediaTrackConstraintSet] })
        setTorch({ supported: true, on })
      } catch {
        setTorch({ supported: false, on: false })
      }
    }
    applyRef.current = applyTorch
    void start()
    return () => {
      stopped = true
      if (frame) cancelAnimationFrame(frame)
      zxingControls?.stop()
      stream?.getTracks().forEach((t) => t.stop())
      trackRef.current = null
    }
  }, [])

  // The page's flashlight button.
  useEffect(() => {
    if (torchOn === undefined || !torch.supported || torchOn === torch.on) return
    void applyRef.current?.(torchOn)
  }, [torchOn, torch.supported, torch.on])

  const toggleTorch = () => void applyRef.current?.(!torch.on)

  return (
    <div className="relative overflow-hidden rounded-2xl bg-black">
      {error ? (
        <div className="flex aspect-video flex-col items-center justify-center gap-2 p-6 text-center text-sm text-white/80">
          <CameraOff className="size-6" /> {error}
        </div>
      ) : (
        <>
          <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
          <div key={flash} className={cn('pointer-events-none absolute inset-x-[8%] top-[30%] h-[40%] rounded-xl border-2 border-brand/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]',
            flash > 0 && 'animate-[scan-hit_0.35s_ease-out]')} />
          <p className="absolute inset-x-0 bottom-3 text-center text-xs text-white/80">Hold the label barcode inside the box</p>
        </>
      )}
      <div className="absolute top-3 right-3 flex gap-2">
        {torch.supported && !error && (
          <Button type="button" size="icon-sm" variant="secondary" className={cn('rounded-full', torch.on && 'bg-amber-300 text-black hover:bg-amber-200')}
            onClick={toggleTorch} aria-pressed={torch.on} aria-label={torch.on ? 'Turn torch off' : 'Turn torch on'}>
            {torch.on ? <FlashlightOff /> : <Flashlight />}
          </Button>
        )}
        <Button type="button" size="icon-sm" variant="secondary" className="rounded-full" onClick={onClose} aria-label="Close camera">
          <X />
        </Button>
      </div>
    </div>
  )
}
