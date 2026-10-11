import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Megaphone, X } from 'lucide-react'
import { Link } from 'react-router'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAuth } from '@/features/auth/auth-context'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ANNOUNCEMENT_KINDS, markAnnouncementRead, type MyAnnouncement, myAnnouncements } from '@/services/platform-ops'

export const KIND_LABEL = Object.fromEntries(ANNOUNCEMENT_KINDS.map((k) => [k.value, k.label])) as Record<string, string>
export const SEVERITY_VARIANT: Record<MyAnnouncement['severity'], BadgeVariant> = { INFO: 'neutral', WARN: 'warning', CRITICAL: 'danger' }

/** Announcements the platform team sent this business (refreshed every few minutes). */
export function useMyAnnouncements() {
  const { access } = useAuth()
  return useQuery({ queryKey: ['my-announcements'], queryFn: myAnnouncements, enabled: !!access, refetchInterval: 5 * 60_000, staleTime: 60_000 })
}

export function useMarkRead() {
  const queryClient = useQueryClient()
  return useMutation({
    meta: { silent: true },
    mutationFn: markAnnouncementRead,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['my-announcements'] }),
  })
}

export function AnnouncementLink({ link, className }: { link: string | null; className?: string }) {
  if (!link) return null
  const cls = cn('inline-flex items-center gap-1 text-xs font-medium text-brand hover:underline', className)
  return link.startsWith('/') ? <Link to={link} className={cls}>Open <ArrowRight className="size-3" /></Link>
    : <a href={link} target="_blank" rel="noreferrer noopener" className={cls}>Open <ArrowRight className="size-3" /></a>
}

/** Header button: unread messages from the platform team. */
export function AnnouncementsButton() {
  const q = useMyAnnouncements()
  const read = useMarkRead()
  const items = q.data?.items ?? []
  const unread = items.filter((i) => !i.read)
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={`Messages from the platform${unread.length ? ` (${unread.length} unread)` : ''}`}>
          <Megaphone />
          {unread.length > 0 && <span className="absolute top-1 right-1 min-w-4 rounded-full bg-brand px-1 text-[10px] leading-4 font-medium text-white">{unread.length > 9 ? '9+' : unread.length}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <p className="border-b px-4 py-2.5 text-sm font-medium">From the platform team</p>
        {items.length === 0 ? <p className="px-4 py-6 text-center text-xs text-muted-foreground">No messages.</p> : (
          <ul className="max-h-96 divide-y overflow-y-auto">
            {items.slice(0, 8).map((a) => (
              <li key={a.id} className={cn('space-y-1 px-4 py-3', !a.read && 'bg-muted/40')}>
                <div className="flex items-center gap-1.5">
                  {!a.read && <span className="size-1.5 rounded-full bg-brand" aria-label="Unread" />}
                  <p className="text-sm font-medium">{a.title}</p>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{a.body}</p>
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground/80">
                  <span>{KIND_LABEL[a.kind]} · {timeAgo(a.sent_at)}</span>
                  <AnnouncementLink link={a.link} />
                  {!a.read && <button type="button" className="ml-auto underline" onClick={() => read.mutate(a.id)}>Mark read</button>}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Link to="/admin/announcements" className="block border-t px-4 py-2.5 text-center text-xs font-medium text-brand hover:underline">All messages and preferences</Link>
      </PopoverContent>
    </Popover>
  )
}

/** A bar for the newest unread important or critical message, until someone reads it. */
export function AnnouncementBanner() {
  const q = useMyAnnouncements()
  const read = useMarkRead()
  const a = q.data?.items.find((i) => !i.read && i.severity !== 'INFO')
  if (!a) return null
  return (
    <div role="status" className={cn('no-print flex items-start gap-3 border-b px-4 py-2 text-sm',
      a.severity === 'CRITICAL' ? 'border-red-500/30 bg-red-500/10' : 'border-amber-500/30 bg-amber-500/10')}>
      <Megaphone className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{a.title} <Badge variant={SEVERITY_VARIANT[a.severity]} className="ml-1 align-middle text-[10px]">{KIND_LABEL[a.kind]}</Badge></p>
        <p className="line-clamp-2 text-xs text-muted-foreground">{a.body}</p>
        <AnnouncementLink link={a.link} className="mt-0.5" />
      </div>
      <Button size="icon" variant="ghost" className="size-7 shrink-0" aria-label="Mark as read" onClick={() => read.mutate(a.id)} disabled={read.isPending}><X /></Button>
    </div>
  )
}
