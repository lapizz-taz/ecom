import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { Card } from '@/components/ui/card'
import { cn } from '@/lib/utils'

export function StatCard({ label, value, hint, icon, to, tone, className }: {
  label: string
  value: ReactNode
  hint?: ReactNode
  icon?: ReactNode
  to?: string
  tone?: 'default' | 'positive' | 'negative' | 'warning'
  className?: string
}) {
  const body = (
    <Card className={cn('gap-1.5 px-4 py-3.5 transition-colors', to && 'hover:bg-muted/40', className)}>
      <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
        <span className="truncate">{label}</span>
        {icon && <span className="text-muted-foreground/70 [&_svg]:size-4">{icon}</span>}
      </div>
      <div className={cn('text-xl font-semibold tabular-nums sm:text-2xl',
        tone === 'positive' && 'text-emerald-600', tone === 'negative' && 'text-red-600', tone === 'warning' && 'text-amber-600')}>
        {value}
      </div>
      {hint && <div className="truncate text-xs text-muted-foreground">{hint}</div>}
    </Card>
  )
  return to ? <Link to={to} className="block">{body}</Link> : body
}
