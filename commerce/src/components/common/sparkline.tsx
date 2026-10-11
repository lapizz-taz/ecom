import { useId } from 'react'
import { cn } from '@/lib/utils'

/**
 * A tiny trend line for KPI cards (plain SVG, no chart library). Values are
 * drawn left to right; a flat series draws a flat line.
 */
export function Sparkline({ values, className, tone = 'brand' }: { values: number[]; className?: string; tone?: 'brand' | 'positive' | 'negative' | 'muted' }) {
  const id = useId()
  // Nothing to show yet (a new store): no line rather than a flat one.
  if (values.length < 2 || values.every((v) => !v)) return null
  const w = 100
  const h = 32
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - ((v - min) / span) * (h - 6)] as const)
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)}`).join(' ')
  const area = `${line} L${w},${h} L0,${h} Z`
  const color = tone === 'positive' ? 'text-emerald-500' : tone === 'negative' ? 'text-red-500' : tone === 'muted' ? 'text-muted-foreground' : 'text-brand'
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={cn('h-8 w-full overflow-visible', color, className)} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.18" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  )
}
