import { Link, useLocation } from 'react-router'
import { useAuth } from '@/features/auth/auth-context'
import { cn } from '@/lib/utils'

/** Messaging: inbox, comments, auto replies and the connected channels. */
export function MessagingTabs({ unread, comments }: { unread?: number; comments?: number }) {
  const { can } = useAuth()
  const { pathname } = useLocation()
  const tabs = [
    { to: '/admin/inbox', label: 'Inbox', show: can('inbox.view'), badge: unread },
    { to: '/admin/inbox/comments', label: 'Comments', show: can('inbox.view'), badge: comments },
    { to: '/admin/inbox/auto-replies', label: 'Auto Replies', show: can('inbox.view') },
    { to: '/admin/inbox/channels', label: 'Channels', show: can('inbox.view') },
  ].filter((t) => t.show)
  return (
    <nav className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5 [scrollbar-width:none]" aria-label="Messaging">
      {tabs.map((t) => {
        const on = pathname === t.to
        return (
          <Link key={t.to} to={t.to} aria-current={on ? 'page' : undefined}
            className={cn('inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:text-foreground sm:px-3', on && 'bg-background text-foreground shadow-xs')}>
            {t.label}
            {!!t.badge && <span className="rounded-full bg-primary px-1.5 text-[10px] text-primary-foreground tabular-nums">{t.badge}</span>}
          </Link>
        )
      })}
    </nav>
  )
}
