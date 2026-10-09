import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

/** Recent changes to the admin, newest first. */
const RELEASES = [
  { date: '2026-10-09', title: 'New menu, quick search and light mode', body: 'Web Orders and Approved Orders have their own menus with live counts. Ctrl+K finds orders, phones, consignment IDs, invoices, customers and SKUs. Choose light, dark or system colours.' },
  { date: '2026-10-09', title: 'BD Courier fraud check', body: 'Settings → Fraud & Advance connects a BD Courier API key: parcels per courier and fraud reports from other merchants, checked when the customer types their number.' },
  { date: '2026-10-08', title: 'SMS automations', body: 'Order, shipping and payment messages with conditions, delivery reports and SMS cost in finance.' },
  { date: '2026-10-07', title: 'Courier webhooks and statements', body: 'Pathao status updates arrive by webhook, every event is logged, and courier statements are checked against your own records.' },
]

const KEY = 'admin-whats-new-seen'

function lastSeen(): string {
  try {
    return localStorage.getItem(KEY) ?? ''
  } catch {
    return ''
  }
}

export function WhatsNew() {
  const [seen, setSeen] = useState(lastSeen)
  const unread = RELEASES.filter((r) => r.date > seen).length
  return (
    <Popover onOpenChange={(open) => {
      if (!open || !RELEASES.length) return
      try { localStorage.setItem(KEY, RELEASES[0].date) } catch { /* private mode */ }
      setSeen(RELEASES[0].date)
    }}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`What's new${unread ? ` (${unread} new)` : ''}`}>
          <Sparkles />
          {unread > 0 && <span className="absolute top-1.5 right-1.5 size-2 rounded-full bg-brand" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <p className="border-b px-4 py-2.5 text-sm font-medium">What's new</p>
        <ul className="max-h-96 divide-y overflow-y-auto">
          {RELEASES.map((r) => (
            <li key={r.title} className="px-4 py-3">
              <p className="text-sm font-medium">{r.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{r.body}</p>
              <p className="mt-1 text-[11px] text-muted-foreground/70">{r.date}</p>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  )
}
