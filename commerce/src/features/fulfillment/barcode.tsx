import JsBarcode from 'jsbarcode'
import { type CSSProperties, useEffect, useRef } from 'react'

/** Code 128 barcode as crisp SVG (prints sharply on thermal printers). */
export function Barcode({ value, height = 48, barWidth = 1.8, className, style }: {
  value: string
  height?: number
  barWidth?: number
  className?: string
  style?: CSSProperties
}) {
  const ref = useRef<SVGSVGElement>(null)
  useEffect(() => {
    if (!ref.current || !value) return
    try {
      JsBarcode(ref.current, value, {
        format: 'CODE128', height, width: barWidth, displayValue: false, margin: 0, background: 'transparent', lineColor: '#000',
      })
    } catch {
      ref.current.replaceChildren()
    }
  }, [value, height, barWidth])
  return <svg ref={ref} className={className} style={style} role="img" aria-label={`Barcode ${value}`} preserveAspectRatio="none" />
}
