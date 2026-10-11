import { Eye, LogOut } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { endSupportSession } from '@/services/support-center'
import type { MyAccess } from '@/types/domain'

const BACK = '/super-admin/support?tab=sessions'

function remaining(until: string): string {
  const s = Math.max(0, Math.round((new Date(until).getTime() - Date.now()) / 1000))
  const m = Math.floor(s / 60)
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Shown on every merchant page while a platform employee looks at the business
 * through a support session: read-only, counting down, with a way out. When the
 * time runs out the database stops the access by itself; this only takes the
 * employee back to the panel.
 */
export function SupportViewBanner({ access }: { access: MyAccess }) {
  const session = access.support_session!
  const [, tick] = useState(0)
  const [ending, setEnding] = useState(false)
  useEffect(() => {
    const t = window.setInterval(() => {
      tick((n) => n + 1)
      if (new Date(session.expires_at).getTime() <= Date.now()) window.location.assign(BACK)
    }, 1000)
    return () => window.clearInterval(t)
  }, [session.expires_at])
  const end = async () => {
    setEnding(true)
    try { await endSupportSession() } finally { window.location.assign(BACK) }
  }
  return (
    <div role="status" className="no-print sticky top-0 z-40 flex h-10 items-center gap-x-3 overflow-hidden bg-amber-500 px-3 text-xs font-medium text-black sm:px-5">
      <Eye className="size-4" />
      <span className="truncate">Support view of <b>{access.merchant?.name ?? 'this business'}</b> · read-only · ends in <span className="tabular-nums">{remaining(session.expires_at)}</span></span>
      <span className="hidden max-w-md truncate font-normal md:inline">Reason: {session.reason}</span>
      <Button size="sm" variant="outline" className="ml-auto h-7 border-black/30 bg-transparent text-black hover:bg-black/10" disabled={ending} onClick={end}>
        <LogOut /> End and go back
      </Button>
    </div>
  )
}
