import { Copy, PackageCheck, PhoneCall, Printer, Tag, Truck, Wallet } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { FulfillmentSummary } from '@/types/domain'

const CHIPS: Array<{ key: keyof FulfillmentSummary; tab: string; label: string; icon: typeof Truck; alert?: boolean }> = [
  { key: 'to_confirm', tab: 'pending', label: 'To confirm', icon: PhoneCall },
  { key: 'advance_pending', tab: 'pending', label: 'Advance pending', icon: Wallet },
  { key: 'to_print', tab: 'to_print', label: 'To print', icon: Printer },
  { key: 'printed', tab: 'processing', label: 'Printed', icon: Tag },
  { key: 'ready_to_ship', tab: 'ready', label: 'Ready to ship', icon: PackageCheck },
  { key: 'shipped_today', tab: 'shipped', label: 'Shipped today', icon: Truck },
  { key: 'duplicates', tab: 'duplicates', label: 'Duplicates', icon: Copy, alert: true },
]

/** Today's fulfilment pipeline at a glance; each chip opens its list. */
export function FulfillmentBar({ summary, active, onSelect }: {
  summary: FulfillmentSummary | undefined
  active: string
  onSelect: (tab: string) => void
}) {
  return (
    <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
      {CHIPS.map((c) => {
        const value = summary?.[c.key] ?? 0
        const highlight = c.alert && value > 0
        return (
          <button key={c.key} type="button" onClick={() => onSelect(c.tab)}
            className={cn('flex shrink-0 items-center gap-2 rounded-full border bg-card px-3.5 py-1.5 text-sm shadow-xs transition-colors hover:border-foreground/25',
              active === c.tab && 'border-foreground/40',
              highlight && 'border-amber-300 bg-amber-50 text-amber-950')}>
            <c.icon className={cn('size-3.5 text-muted-foreground', highlight && 'text-amber-700')} />
            <span className="text-muted-foreground">{c.label}</span>
            <span className="font-semibold tabular-nums">{summary ? value : '–'}</span>
          </button>
        )
      })}
    </div>
  )
}
