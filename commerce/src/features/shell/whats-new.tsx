import { Sparkles } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { RELEASES as ALL } from '@/features/support/releases'

const RELEASES = ALL.slice(0, 6)

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
        <Link to="/admin/updates" className="block border-t px-4 py-2.5 text-center text-xs font-medium text-brand hover:underline">All updates</Link>
      </PopoverContent>
    </Popover>
  )
}
