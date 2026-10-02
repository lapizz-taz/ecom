import { CameraOff, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'

interface DetectedBarcode { rawValue: string }
interface BarcodeDetectorLike { detect(source: CanvasImageSource): Promise<DetectedBarcode[]> }
type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike

/**
 * Reads barcodes with the device camera. Uses the browser's built-in
 * BarcodeDetector (Chrome / Android) and falls back to ZXing elsewhere.
 * Repeated reads of the same code within a short window are ignored.
 */
export function CameraScanner({ onScan, onClose }: { onScan: (code: string) => void; onClose: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const last = useRef<{ code: string; at: number }>({ code: '', at: 0 })
  const [error, setError] = useState<string | null>(null)
  const onScanRef = useRef(onScan)
  onScanRef.current = onScan

  useEffect(() => {
    let stopped = false
    let stream: MediaStream | null = null
    let timer: number | undefined
    let zxingControls: { stop: () => void } | null = null

    const emit = (raw: string) => {
      const code = raw.trim()
      const now = Date.now()
      if (!code || (code === last.current.code && now - last.current.at < 2500)) return
      last.current = { code, at: now }
      onScanRef.current(code)
    }

    const start = async () => {
      const Detector = (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
      try {
        if (Detector) {
          stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false })
          if (stopped || !videoRef.current) return
          videoRef.current.srcObject = stream
          await videoRef.current.play()
          const detector = new Detector({ formats: ['code_128', 'code_39', 'qr_code', 'ean_13', 'ean_8', 'upc_a'] })
          const tick = async () => {
            if (stopped || !videoRef.current) return
            try {
              const found = await detector.detect(videoRef.current)
              if (found[0]?.rawValue) emit(found[0].rawValue)
            } catch { /* frame not ready */ }
            timer = window.setTimeout(tick, 180)
          }
          void tick()
        } else {
          const { BrowserMultiFormatReader } = await import('@zxing/browser')
          if (stopped || !videoRef.current) return
          const reader = new BrowserMultiFormatReader()
          zxingControls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
            if (result) emit(result.getText())
          })
        }
      } catch (e) {
        setError((e as Error).name === 'NotAllowedError'
          ? 'Camera permission was denied. Allow camera access in the browser settings, or use a USB scanner.'
          : 'No camera available. Use a USB / Bluetooth scanner or type the code.')
      }
    }
    void start()
    return () => {
      stopped = true
      if (timer) window.clearTimeout(timer)
      zxingControls?.stop()
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  return (
    <div className="relative overflow-hidden rounded-2xl bg-black">
      {error ? (
        <div className="flex aspect-video flex-col items-center justify-center gap-2 p-6 text-center text-sm text-white/80">
          <CameraOff className="size-6" /> {error}
        </div>
      ) : (
        <>
          <video ref={videoRef} className="aspect-video w-full object-cover" muted playsInline />
          <div className="pointer-events-none absolute inset-x-[12%] top-1/2 h-24 -translate-y-1/2 rounded-xl border-2 border-brand/90 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          <p className="absolute inset-x-0 bottom-3 text-center text-xs text-white/80">Point the camera at the label barcode</p>
        </>
      )}
      <Button type="button" size="icon-sm" variant="secondary" className="absolute top-3 right-3 rounded-full" onClick={onClose} aria-label="Close camera">
        <X />
      </Button>
    </div>
  )
}
