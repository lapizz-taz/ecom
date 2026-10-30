import { ArrowDownRight, ArrowUpRight } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { Sparkline } from './sparkline'

/**
 * KPI card: label, value, an optional change against the previous period and
 * an optional sparkline of the recent trend.
 */
export function StatCard({ label, value, hint, icon, to, onClick, tone, className, trend, delta, invertDelta }: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  to?: string
  /** Opens something in place (a dialog) instead of a page. */
  onClick?: () => void
  tone?: 'default' | 'positive' | 'negative' | 'warning'
  className?: string
  /** Recent values, oldest first, drawn as a small line. */
  trend?: number[]
  /** Percentage change against the previous period. */
  delta?: number | null
  /** A rise is bad (returns, cancellations): show it red. */
  invertDelta?: boolean
}) {
  const good = delta == null ? null : invertDelta ? delta <= 0 : delta >= 0
  const body = (
    <Card className={cn('h-full gap-2 px-4 py-4 transition-[border-color,box-shadow]', (to || onClick) && 'hover:border-foreground/15 hover:shadow-sm', className)}>
      {/* min-h keeps the value on the same line in cards with and without an icon */}
      <div className="flex min-h-7 items-center justify-between gap-2">
        <span className="truncate text-[13px] text-muted-foreground">{label}</span>
        {icon && <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground [&_svg]:size-3.5">{icon}</span>}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-3">
        <div className="min-w-0">
          <div className={cn('truncate text-xl leading-none font-semibold tracking-[-0.02em] tabular-nums sm:text-[22px]',
            tone === 'positive' && 'text-emerald-600', tone === 'negative' && 'text-red-600', tone === 'warning' && 'text-amber-600')}>
            {value}
          </div>
          {(delta != null || hint) && (
            <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {delta != null && Number.isFinite(delta) && (
                <span className={cn('inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-px font-medium tabular-nums',
                  good ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700')}>
                  {delta >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}
                  {Math.abs(delta) >= 1000 ? '999+' : Math.abs(delta).toFixed(Math.abs(delta) < 10 ? 1 : 0)}%
                </span>
              )}
              {hint && <span className="truncate">{hint}</span>}
            </div>
          )}
        </div>
        {trend && trend.length > 1 && (
          <Sparkline values={trend} className="h-7 w-full shrink-0 sm:h-8 sm:w-24" tone={good === false ? 'negative' : 'brand'} />
        )}
      </div>
    </Card>
  )
  if (to) return <Link to={to} className="block h-full">{body}</Link>
  return onClick ? <button type="button" onClick={onClick} className="block h-full w-full rounded-xl text-left">{body}</button> : body
}

/** Percentage change from `previous` to `current` (null when there is nothing to compare with). */
export function percentChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous === 0) return null
  return ((current - previous) / Math.abs(previous)) * 100
}
