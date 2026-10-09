import qrcode from 'qrcode-generator'
import { type CSSProperties, useMemo } from 'react'

/** QR code as crisp SVG (square modules print sharply on thermal printers). */
export function QrCode({ value, className, style }: { value: string; className?: string; style?: CSSProperties }) {
  const svg = useMemo(() => {
    if (!value) return null
    try {
      const qr = qrcode(0, 'M')
      qr.addData(value)
      qr.make()
      const n = qr.getModuleCount()
      let path = ''
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) path += `M${c} ${r}h1v1h-1z`
      return { n, path }
    } catch {
      return null
    }
  }, [value])
  if (!svg) return null
  return (
    <svg viewBox={`0 0 ${svg.n} ${svg.n}`} className={className} style={style} role="img" aria-label={`QR code ${value}`} shapeRendering="crispEdges">
      <path d={svg.path} fill="#000" />
    </svg>
  )
}
