import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bell, CheckCheck, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { usePlatform } from '@/features/platform/platform-context'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { listNotifications, markNotificationsRead, type PlatformNotification } from '@/services/support-center'

const DOT: Record<PlatformNotification['severity'], string> = { INFO: 'bg-sky-500', WARN: 'bg-amber-500', CRITICAL: 'bg-red-500' }

/** The employee's own alerts (tickets, incidents, automation rules) and approvals waiting for them. */
export function NotificationsBell() {
  const { me, refresh } = usePlatform()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const list = useQuery({ queryKey: ['platform-notifications'], enabled: open, queryFn: () => listNotifications(30) })
  const read = useMutation({
    mutationFn: (ids?: number[]) => markNotificationsRead(ids),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['platform-notifications'] }); refresh() },
  })
  const unread = me?.unread_notifications ?? 0
  const approvals = me?.pending_approvals ?? 0
  const total = unread + approvals
  const go = (n: PlatformNotification) => {
    if (!n.read) read.mutate([n.id])
    setOpen(false)
    if (n.link) navigate(n.link)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Notifications${total ? ` (${total})` : ''}`} className="relative">
          <Bell />
          {total > 0 && <Badge variant="destructive" className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px]">{total > 99 ? '99+' : total}</Badge>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <p className="text-sm font-medium">Notifications</p>
          {unread > 0 && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => read.mutate(undefined)}><CheckCheck /> Mark all read</Button>}
        </div>
        {approvals > 0 && (
          <button type="button" onClick={() => { setOpen(false); navigate('/super-admin/security?tab=approvals') }}
            className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-sm hover:bg-muted/50">
            <ShieldCheck className="size-4 text-amber-500" /> {approvals} approval{approvals === 1 ? '' : 's'} waiting for you
          </button>
        )}
        <div className="max-h-96 overflow-y-auto">
          {!list.data ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">{list.error ? (list.error as Error).message : 'Loading…'}</p>
            : list.data.items.length === 0 ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">Nothing yet.</p>
              : list.data.items.map((n) => (
                <button key={n.id} type="button" onClick={() => go(n)}
                  className={cn('flex w-full gap-2 border-b px-3 py-2 text-left last:border-0 hover:bg-muted/50', n.read && 'opacity-60')}>
                  <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', n.read ? 'bg-muted-foreground/30' : DOT[n.severity])} />
                  <span className="min-w-0">
                    <span className="block text-sm">{n.title}</span>
                    {n.body && <span className="line-clamp-2 block text-xs text-muted-foreground">{n.body}</span>}
                    <span className="block text-[11px] text-muted-foreground">{n.merchant && `#${n.merchant.number} ${n.merchant.name} · `}{timeAgo(n.created_at)}</span>
                  </span>
                </button>
              ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
