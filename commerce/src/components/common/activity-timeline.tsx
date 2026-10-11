import { Search } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { formatDateTime, initials, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'

export interface ActivityItem {
  id: string | number
  /** Who did it; empty means the system. */
  actor?: string | null
  /** What happened, written to follow the actor ("approved the order"). */
  action: ReactNode
  at: string
  icon?: ReactNode
  tone?: 'default' | 'success' | 'warning' | 'danger'
  /** A note, message or detail shown in a soft box under the line. */
  body?: ReactNode
  /** Plain text used by the search box. */
  text?: string
}

const TONE = {
  default: 'bg-card text-muted-foreground',
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-600',
}

/**
 * Activity log: one line per event with who did it and when, joined by a thin
 * rail; details sit in a soft box underneath. Searchable when long.
 */
export function ActivityTimeline({ items, searchable, empty = 'Nothing has happened yet.', className }: {
  items: ActivityItem[]
  searchable?: boolean
  empty?: ReactNode
  className?: string
}) {
  const [q, setQ] = useState('')
  const term = q.trim().toLowerCase()
  const shown = term ? items.filter((i) => `${i.actor ?? 'system'} ${i.text ?? ''}`.toLowerCase().includes(term)) : items
  return (
    <div className={cn('space-y-3', className)}>
      {searchable && items.length > 5 && (
        <label className="flex h-9 items-center gap-2 rounded-[10px] border bg-card px-3 text-sm shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15">
          <Search className="size-4 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search activity by person or event" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" />
        </label>
      )}
      {shown.length === 0 ? <p className="py-4 text-sm text-muted-foreground">{term ? 'Nothing matches.' : empty}</p> : (
        <ol className="relative">
          {shown.map((i, n) => (
            <li key={i.id} className="relative flex gap-3 pb-4 last:pb-0">
              {n < shown.length - 1 && <span aria-hidden className="absolute top-7 bottom-0 left-[13px] w-px bg-border" />}
              <span className={cn('relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full border shadow-xs [&_svg]:size-3.5', TONE[i.tone ?? 'default'])}>
                {i.icon ?? <span className="size-1.5 rounded-full bg-current" />}
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm leading-6">
                  <span className="inline-flex items-center gap-1.5 font-medium">
                    <span className="flex size-5 items-center justify-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground">{initials(i.actor || 'System')}</span>
                    {i.actor || 'System'}
                  </span>
                  <span className="text-muted-foreground">{i.action}</span>
                  <span className="text-xs text-muted-foreground" title={formatDateTime(i.at)}>· {timeAgo(i.at)}</span>
                </p>
                {i.body && <div className="mt-1.5 rounded-xl border bg-muted/40 px-3 py-2 text-[13px] text-foreground/85">{i.body}</div>}
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
