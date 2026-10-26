import { useQuery } from '@tanstack/react-query'
import { MessagesSquare, PlugZap } from 'lucide-react'
import { useCallback, useState } from 'react'
import { Link } from 'react-router'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { useAuth } from '@/features/auth/auth-context'
import { ConversationList } from '@/features/inbox/conversation-list'
import { CustomerPanel } from '@/features/inbox/customer-panel'
import { MessagingTabs } from '@/features/inbox/messaging-tabs'
import { OrderDraftDialog } from '@/features/inbox/order-draft'
import { Thread } from '@/features/inbox/thread'
import { PlatformIcon } from '@/features/inbox/ui'
import { useUrlState } from '@/hooks/use-url-state'
import { cn } from '@/lib/utils'
import { type InboxFilters, inboxOverview } from '@/services/inbox'

export default function InboxPage() {
  const { can } = useAuth()
  const [state, update] = useUrlState({
    c: '', status: 'OPEN', platform: '', kind: 'MESSAGE', label: '', assigned: '', unread: '', starred: '', awaiting: '', orders: '', tagged: '', sort: '',
  })
  const [orderDraft, setOrderDraft] = useState(false)
  const [panel, setPanel] = useState(true)
  const [mobilePanel, setMobilePanel] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const clearDraft = useCallback(() => setDraft(null), [])
  const overview = useQuery({ queryKey: ['inbox-overview'], queryFn: inboxOverview, refetchInterval: 20_000 })

  const filters: InboxFilters = {
    status: state.status as InboxFilters['status'], platform: state.platform as InboxFilters['platform'], kind: state.kind as InboxFilters['kind'],
    label: state.label, assigned: state.assigned as InboxFilters['assigned'], unread: state.unread === '1', starred: state.starred === '1',
    awaiting: state.awaiting === '1', has_order: state.orders === '1', tagged: state.tagged === '1', sort: state.sort as InboxFilters['sort'],
  }
  const setFilters = (f: InboxFilters) => update({
    status: f.status ?? 'OPEN', platform: f.platform ?? '', kind: f.kind ?? 'MESSAGE', label: f.label ?? '', assigned: f.assigned ?? '',
    unread: f.unread ? '1' : '', starred: f.starred ? '1' : '', awaiting: f.awaiting ? '1' : '', orders: f.has_order ? '1' : '',
    tagged: f.tagged ? '1' : '', sort: f.sort ?? '',
  }, { resetPage: false })
  const open = (id: string) => update({ c: id }, { resetPage: false })
  const sendDraft = (text: string) => { setDraft(text); setMobilePanel(false) }

  if (overview.isLoading) return <LoadingState />
  if (overview.error) return <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
  const channels = overview.data!.channels.filter((c) => c.status !== 'DISCONNECTED')

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <MessagingTabs unread={overview.data!.counts.unread} comments={overview.data!.comments?.awaiting} />
        <div className="hidden items-center gap-2 md:flex">
          {channels.map((c) => (
            <span key={c.id} className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs', c.status === 'FAILED' && 'border-destructive/50 text-destructive')} title={c.status_error ?? undefined}>
              <PlatformIcon platform={c.platform} className="size-3.5" /> {c.name}
            </span>
          ))}
        </div>
      </div>

      {channels.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
          <span className="flex gap-2">
            <PlatformIcon platform="FACEBOOK" className="size-7" /><PlatformIcon platform="INSTAGRAM" className="size-7" /><PlatformIcon platform="WHATSAPP" className="size-7" />
          </span>
          <h2 className="text-base font-semibold">Bring every customer message into one inbox</h2>
          <p className="max-w-md text-sm text-muted-foreground">
            Connect your Facebook Page, Instagram account and WhatsApp number. Messages, and comments on your posts and ads, arrive here; reply, send products and create orders without leaving the chat.
          </p>
          {can('inbox.manage') && <Button asChild><Link to="/admin/inbox/channels" className="gap-1.5"><PlugZap /> Connect a channel</Link></Button>}
        </div>
      ) : (
        // Ends at the screen's bottom edge: header, page padding, the tabs row and its gap above (+ the panel's frame and border on lg).
        <div className="grid h-[calc(100dvh-7.75rem)] min-h-[480px] overflow-hidden sm:h-[calc(100dvh-9.25rem)] lg:h-[calc(100dvh-10.25rem-2px)] rounded-xl border bg-card lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[320px_minmax(0,1fr)_auto]">
          <aside className={cn('min-h-0 border-r', state.c && 'hidden lg:block')}>
            <ConversationList overview={overview.data} selected={state.c || null} onSelect={open} filters={filters} onFilters={setFilters} />
          </aside>
          <section className={cn('min-w-0 min-h-0', !state.c && 'hidden lg:block')}>
            {state.c ? (
              <Thread id={state.c} onBack={() => update({ c: '' }, { resetPage: false })} draft={draft} onDraft={clearDraft}
                onInsert={sendDraft} onOrderDraft={() => setOrderDraft(true)}
                onTogglePanel={() => (window.matchMedia('(min-width: 1280px)').matches ? setPanel((p) => !p) : setMobilePanel(true))} />
            ) : (
              <div className="flex h-full flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
                <MessagesSquare className="size-8" /> Pick a conversation
              </div>
            )}
          </section>
          {state.c && panel && (
            <aside className="hidden min-h-0 w-80 border-l xl:block">
              <CustomerPanel id={state.c} onDraft={sendDraft} onOpen={open} onOrderDraft={() => setOrderDraft(true)} />
            </aside>
          )}
        </div>
      )}

      <Sheet open={mobilePanel && !!state.c} onOpenChange={setMobilePanel}>
        <SheetContent side="right" className="w-full p-0 sm:max-w-sm">
          <SheetTitle className="sr-only">Customer</SheetTitle>
          {state.c && <CustomerPanel id={state.c} onDraft={sendDraft} onOpen={(id) => { open(id); setMobilePanel(false) }} onClose={() => setMobilePanel(false)}
            onOrderDraft={() => { setMobilePanel(false); setOrderDraft(true) }} />}
        </SheetContent>
      </Sheet>
      {state.c && <OrderDraftDialog conversationId={state.c} open={orderDraft} onOpenChange={setOrderDraft} />}
    </div>
  )
}
