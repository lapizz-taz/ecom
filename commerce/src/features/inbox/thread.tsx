import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertCircle, ArrowLeft, Check, CheckCheck, CircleCheck, Clock, Copy, ExternalLink, FileText, MapPin, MoreVertical, PanelRight, Pin, PinOff, Reply,
  Star, UserRound,
} from 'lucide-react'
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { toUserMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type Attachment, type ConversationStatus, inboxMarkRead, inboxStaff, type InboxMessage, type InboxThread, inboxThread, inboxUpdate, whatsappMedia } from '@/services/inbox'
import { ChatActions } from './chat-actions'
import { Composer } from './composer'
import { ChatAvatar, dayLabel, PLATFORM } from './ui'

const STATUS_LABEL: Record<ConversationStatus, string> = { OPEN: 'Open', FOLLOW_UP: 'Follow-up', DONE: 'Done' }

export function Thread({ id, onBack, onTogglePanel, draft, onDraft, onInsert, onOrderDraft }: {
  id: string
  onBack: () => void
  onTogglePanel: () => void
  draft: string | null
  onDraft: () => void
  /** Puts text into the message box (order status, invoice). */
  onInsert: (text: string) => void
  onOrderDraft: () => void
}) {
  const qc = useQueryClient()
  const thread = useQuery({ queryKey: ['inbox-thread', id], queryFn: () => inboxThread(id), refetchInterval: 5_000 })
  const staff = useQuery({ queryKey: ['inbox-staff'], queryFn: inboxStaff, staleTime: 5 * 60_000 })
  const [older, setOlder] = useState<InboxMessage[]>([])
  const [replyTo, setReplyTo] = useState<InboxMessage | null>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const pinnedToBottom = useRef(true)

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['inbox-thread', id] })
    void qc.invalidateQueries({ queryKey: ['inbox-list'] })
    void qc.invalidateQueries({ queryKey: ['inbox-overview'] })
  }
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof inboxUpdate>[1]) => inboxUpdate(id, patch),
    onSuccess: refresh,
    onError: (e) => toast.error(toUserMessage(e)),
  })

  useEffect(() => {
    setOlder([])
    setReplyTo(null)
    pinnedToBottom.current = true
  }, [id])
  const c = thread.data?.conversation
  // Opening a conversation marks it read.
  useEffect(() => {
    if (c && c.unread_count > 0) void inboxMarkRead(id).then(() => {
      void qc.invalidateQueries({ queryKey: ['inbox-list'] })
      void qc.invalidateQueries({ queryKey: ['inbox-overview'] })
    })
  }, [c, id, qc])

  const messages = [...older, ...(thread.data?.messages ?? [])]
  const last = messages.at(-1)?.id
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinnedToBottom.current) el.scrollTop = el.scrollHeight
  }, [last, id])

  const loadOlder = async () => {
    const first = messages[0]
    if (!first) return
    const el = scroller.current
    const before = el?.scrollHeight ?? 0
    const page = await inboxThread(id, first.created_at)
    setOlder((o) => [...page.messages, ...o])
    requestAnimationFrame(() => { if (el) el.scrollTop = el.scrollHeight - before })
  }

  if (thread.isLoading || !c) return <div className="flex h-full items-center justify-center"><Spinner /></div>
  if (thread.error) return <div className="p-6 text-sm text-destructive">{toUserMessage(thread.error)}</div>

  const hasMore = older.length ? true : thread.data!.has_more
  const outsideWindow = c.kind === 'MESSAGE' && c.last_customer_message_at
    && Date.now() - Date.parse(c.last_customer_message_at) > 24 * 3600_000
  const disabled = c.channel_status === 'DISCONNECTED' ? 'This channel is disconnected. Connect it again under Messaging → Channels to reply.' : null

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <header className="flex min-w-0 items-center gap-1.5 border-b px-2 py-2 sm:gap-2 sm:px-3">
        <Button size="icon-sm" variant="ghost" className="lg:hidden" onClick={onBack} aria-label="Back to conversations"><ArrowLeft /></Button>
        <ChatAvatar name={c.customer_name} src={c.customer_avatar} platform={c.platform} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{c.customer_name ?? c.customer_phone ?? 'Customer'}</p>
          <p className="truncate text-xs text-muted-foreground">
            {c.kind === 'COMMENT' ? 'Comment' : PLATFORM[c.platform].label} · {c.channel_name}
            {c.assigned_name && <> · <UserRound className="inline size-3" /> {c.assigned_name}</>}
          </p>
        </div>
        {c.status !== 'DONE' && (
          <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2 text-xs" onClick={() => update.mutate({ status: 'DONE' })} aria-label="Done"><CircleCheck className="size-4" /> <span className="hidden sm:inline">Done</span></Button>
        )}
        <Button size="icon-sm" variant="ghost" className="hidden sm:inline-flex" aria-label={c.starred ? 'Unstar' : 'Star'} onClick={() => update.mutate({ starred: !c.starred })}>
          <Star className={cn(c.starred && 'fill-amber-400 text-amber-400')} />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-8 gap-1.5 px-2 text-xs" aria-label={`Status: ${STATUS_LABEL[c.status]}`}>
              <span className={cn('size-2 rounded-full', c.status === 'OPEN' ? 'bg-emerald-500' : c.status === 'FOLLOW_UP' ? 'bg-amber-500' : 'bg-muted-foreground')} />
              <span className="hidden sm:inline">{STATUS_LABEL[c.status]}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={c.status} onValueChange={(v) => update.mutate({ status: v as ConversationStatus })}>
              {(Object.keys(STATUS_LABEL) as ConversationStatus[]).map((s) => <DropdownMenuRadioItem key={s} value={s}>{STATUS_LABEL[s]}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon-sm" variant="ghost" aria-label="More"><MoreVertical /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Assign to</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={c.assigned_to ?? ''} onValueChange={(v) => update.mutate({ assigned_to: v || null })}>
              <DropdownMenuRadioItem value="">Nobody</DropdownMenuRadioItem>
              {staff.data?.map((s) => <DropdownMenuRadioItem key={s.id} value={s.id}>{s.full_name ?? 'Staff'}</DropdownMenuRadioItem>)}
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => update.mutate({ unread: true })}>Mark as unread</DropdownMenuItem>
            <DropdownMenuItem className="sm:hidden" onClick={() => update.mutate({ starred: !c.starred })}>{c.starred ? 'Unstar' : 'Star'}</DropdownMenuItem>
            {c.post?.url && <DropdownMenuItem asChild><a href={c.post.url} target="_blank" rel="noreferrer">Open the post <ExternalLink className="ml-auto" /></a></DropdownMenuItem>}
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="icon-sm" variant="ghost" aria-label="Customer details" onClick={onTogglePanel}><PanelRight /></Button>
      </header>

      {thread.data!.pinned && (
        <button type="button" onClick={() => document.getElementById(`msg-${thread.data!.pinned!.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}
          className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-left text-xs">
          <Pin className="size-3.5 shrink-0" />
          <span className="font-medium">Pinned</span>
          <span className="line-clamp-1 flex-1 text-muted-foreground">{thread.data!.pinned.body}</span>
        </button>
      )}
      {c.kind === 'COMMENT' && (
        <div className="flex items-center gap-2 border-b bg-muted/40 px-4 py-2 text-xs">
          <span className="text-muted-foreground">Comment on</span>
          <span className="line-clamp-1 flex-1 font-medium">{c.post?.title || (c.post?.type === 'REELS' ? 'a Reel' : 'a post or ad')}</span>
          {c.post?.url && <a href={c.post.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline">Open <ExternalLink className="size-3" /></a>}
        </div>
      )}

      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
        onScroll={(e) => { const el = e.currentTarget; pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80 }}>
        {hasMore && (
          <div className="mb-4 flex justify-center"><Button size="sm" variant="outline" className="h-7 text-xs" onClick={loadOlder}>Load earlier messages</Button></div>
        )}
        <div className="space-y-1.5">
          {messages.map((m, i) => {
            const newDay = i === 0 || new Date(messages[i - 1].created_at).toDateString() !== new Date(m.created_at).toDateString()
            return (
              <Fragment key={m.id}>
                {newDay && <div className="my-4 flex justify-center"><span className="rounded-full bg-muted px-3 py-0.5 text-[11px] text-muted-foreground">{dayLabel(m.created_at)}</span></div>}
                <Bubble m={m} channelId={c.channel_id} pinned={c.pinned_message_id === m.id} customerName={c.customer_name}
                  onReply={() => setReplyTo(m)} onPin={() => update.mutate({ pinned_message_id: c.pinned_message_id === m.id ? null : m.id })} />
              </Fragment>
            )
          })}
        </div>
      </div>

      <ChatActions data={thread.data!} onInsert={onInsert} onOrderDraft={onOrderDraft} onTogglePanel={onTogglePanel} />
      <Composer conversationId={id} kind={c.kind} replyTo={replyTo} onClearReply={() => setReplyTo(null)} onSent={refresh} draft={draft} onDraft={onDraft}
        disabled={disabled ?? (outsideWindow && c.platform === 'WHATSAPP' ? 'More than 24 hours since the customer last wrote: WhatsApp only allows approved templates now. Ask them to message again.' : null)} />
      {outsideWindow && c.platform !== 'WHATSAPP' && !disabled && (
        <p className="border-t bg-muted/40 px-4 py-1.5 text-[11px] text-muted-foreground">
          <Clock className="mr-1 inline size-3" />More than 24 hours since the customer last wrote. Replies go as a human-agent message (allowed for 7 days).
        </p>
      )}
    </div>
  )
}

function Bubble({ m, channelId, pinned, customerName, onReply, onPin }: {
  m: InboxMessage; channelId: string; pinned: boolean; customerName: string | null; onReply: () => void; onPin: () => void
}) {
  const out = m.direction === 'OUT'
  const time = new Date(m.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return (
    <div id={`msg-${m.id}`} className={cn('group flex items-end gap-2', out ? 'justify-end' : 'justify-start')}>
      {out && <Actions onReply={onReply} onPin={onPin} pinned={pinned} body={m.body} />}
      <div className={cn('max-w-[78%] space-y-1 sm:max-w-[65%]')}>
        {m.reply_to && (
          <div className={cn('rounded-lg border-l-2 px-2.5 py-1 text-[11px] text-muted-foreground', out ? 'ml-auto border-primary/60 bg-primary/5' : 'border-muted-foreground/40 bg-muted/60')}>
            <span className="font-medium">{m.reply_to.direction === 'IN' ? (customerName ?? 'Customer') : 'You'}</span>
            <span className="line-clamp-2">{m.reply_to.body}</span>
          </div>
        )}
        <div className={cn('rounded-2xl px-3.5 py-2 text-sm', out ? 'rounded-br-md bg-primary text-primary-foreground' : 'rounded-bl-md bg-muted',
          m.status === 'FAILED' && 'bg-destructive/10 text-foreground ring-1 ring-destructive/40', pinned && 'ring-2 ring-amber-400/60')}>
          {m.attachments.length > 0 && <div className={cn('space-y-1.5', m.body && 'mb-1.5')}>{m.attachments.map((a, i) => <AttachmentView key={i} a={a} channelId={channelId} out={out} />)}</div>}
          {m.body && <p className="break-words whitespace-pre-wrap">{m.body}</p>}
        </div>
        <div className={cn('flex items-center gap-1 px-1 text-[10px] text-muted-foreground', out && 'justify-end')}>
          {out && m.sender_name && <span>{m.sender_name} ·</span>}
          {!out && m.sender_name && m.sender_name !== customerName && <span>{m.sender_name} ·</span>}
          <span>{time}</span>
          {out && <StatusTick status={m.status} />}
          {pinned && <Pin className="size-3" />}
        </div>
        {m.status === 'FAILED' && m.error && <p className="flex items-start gap-1 px-1 text-[11px] text-destructive"><AlertCircle className="mt-0.5 size-3 shrink-0" /> {m.error}</p>}
      </div>
      {!out && <Actions onReply={onReply} onPin={onPin} pinned={pinned} body={m.body} />}
    </div>
  )
}

function Actions({ onReply, onPin, pinned, body }: { onReply: () => void; onPin: () => void; pinned: boolean; body: string | null }) {
  return (
    <div className="mb-5 flex shrink-0 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      <Button size="icon-sm" variant="ghost" className="size-6" aria-label="Reply" onClick={onReply}><Reply className="size-3.5" /></Button>
      <Button size="icon-sm" variant="ghost" className="size-6" aria-label={pinned ? 'Unpin' : 'Pin'} onClick={onPin}>{pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}</Button>
      {body && <Button size="icon-sm" variant="ghost" className="size-6" aria-label="Copy" onClick={() => { void navigator.clipboard.writeText(body).then(() => toast.success('Copied')).catch(() => undefined) }}><Copy className="size-3.5" /></Button>}
    </div>
  )
}

function StatusTick({ status }: { status: InboxMessage['status'] }) {
  if (status === 'READ') return <CheckCheck className="size-3.5 text-sky-500" aria-label="Seen" />
  if (status === 'DELIVERED') return <CheckCheck className="size-3.5" aria-label="Delivered" />
  if (status === 'FAILED') return <AlertCircle className="size-3 text-destructive" aria-label="Not sent" />
  return <Check className="size-3.5" aria-label="Sent" />
}

/** WhatsApp files are fetched through the store's token when shown. */
function useMediaUrl(a: Attachment, channelId: string) {
  const q = useQuery({
    queryKey: ['wa-media', a.media_id], enabled: !a.url && !!a.media_id, staleTime: Infinity, retry: false,
    queryFn: async () => {
      const r = await whatsappMedia(channelId, a.media_id!)
      const bytes = Uint8Array.from(atob(r.data), (ch) => ch.charCodeAt(0))
      return URL.createObjectURL(new Blob([bytes], { type: r.mime }))
    },
  })
  return { url: a.url ?? q.data, loading: q.isLoading && !!a.media_id && !a.url, error: q.error }
}

function AttachmentView({ a, channelId, out }: { a: Attachment; channelId: string; out: boolean }) {
  const { url, loading, error } = useMediaUrl(a, channelId)
  if (a.type === 'location') {
    return <a href={`https://maps.google.com/?q=${a.lat},${a.lng}`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 underline"><MapPin className="size-3.5" /> Location</a>
  }
  if (loading) return <div className="flex h-24 w-40 items-center justify-center rounded-lg bg-background/40"><Spinner /></div>
  if (!url) {
    return <span className="inline-flex items-center gap-1.5 text-xs opacity-80"><FileText className="size-3.5" /> {a.name ?? a.type}{error ? ' (could not load)' : ''}</span>
  }
  if (a.type === 'image' || a.type === 'sticker') {
    return <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={a.name ?? ''} className={cn('max-h-64 rounded-lg object-cover', a.type === 'sticker' && 'max-h-28 bg-transparent')} loading="lazy" /></a>
  }
  if (a.type === 'audio') return <audio src={url} controls className="h-9 w-56 max-w-full" preload="none" />
  if (a.type === 'video') return <video src={url} controls className="max-h-64 rounded-lg" preload="metadata" />
  return (
    <a href={url} target="_blank" rel="noreferrer" className={cn('flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs underline-offset-2 hover:underline', out ? 'bg-primary-foreground/10' : 'bg-background/60')}>
      <FileText className="size-4 shrink-0" /> <span className="truncate">{a.name ?? 'File'}</span>
    </a>
  )
}

export type { InboxThread }
