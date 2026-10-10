import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bug, Lightbulb, MessageSquare, Plus, Send, Star } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useLocation, useSearchParams } from 'react-router'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useStaffDirectory } from '@/hooks/use-staff-directory'
import { formatDateTime, timeAgo, titleCase } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  BUG_CATEGORIES, createTicket, FEEDBACK_CATEGORIES, listTickets, PRIORITIES, replyTicket, type Ticket, TICKET_STATUS, type TicketKind,
  ticketMessages, type TicketStatus, updateTicket,
} from '@/services/support'

const PRIORITY_VARIANT = { LOW: 'neutral', NORMAL: 'neutral', HIGH: 'warning', URGENT: 'danger' } as const

export default function SupportTicketsPage() {
  const kind: TicketKind = useLocation().pathname.includes('feedback') ? 'FEEDBACK' : 'BUG'
  const { access, can } = useAuth()
  const support = can('support.manage')
  const [params, setParams] = useSearchParams()
  const [scope, setScope] = useState<'mine' | 'all'>('mine')
  const [status, setStatus] = useState<'active' | TicketStatus | 'all'>('active')
  const [selected, setSelected] = useState<string | null>(null)
  const creating = params.get('new') === '1'
  const q = useQuery({ queryKey: ['tickets', kind, scope], queryFn: () => listTickets(kind, scope, access!.user_id), enabled: !!access })
  const rows = useMemo(() => (q.data ?? []).filter((t) => status === 'all' || (status === 'active' ? ['OPEN', 'IN_PROGRESS'].includes(t.status) : t.status === status)), [q.data, status])
  const current = q.data?.find((t) => t.id === selected) ?? null
  const counts = (s: TicketStatus) => (q.data ?? []).filter((t) => t.status === s).length
  const isBug = kind === 'BUG'
  const categories = isBug ? BUG_CATEGORIES : FEEDBACK_CATEGORIES

  return (
    <div className="space-y-4">
      <PageHeader title={isBug ? 'My Bug Reports' : 'My Feedback'}
        description={isBug ? 'Problems you reported and what happened to them. The team replies here.' : 'Ideas and suggestions you shared, with replies from the team.'}
        actions={<Button onClick={() => setParams({ new: '1' })}><Plus /> {isBug ? 'Report a bug' : 'Share feedback'}</Button>} />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="Open" value={counts('OPEN')} />
        <StatCard label="In progress" value={counts('IN_PROGRESS')} />
        <StatCard label="Resolved" value={counts('RESOLVED')} tone="positive" />
        <StatCard label="Closed" value={counts('CLOSED')} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {support && (
          <Tabs value={scope} onValueChange={(v) => setScope(v as typeof scope)}>
            <TabsList><TabsTrigger value="mine">Mine</TabsTrigger><TabsTrigger value="all">Everyone's</TabsTrigger></TabsList>
          </Tabs>
        )}
        <Tabs value={status} onValueChange={(v) => setStatus(v as typeof status)}>
          <TabsList>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="RESOLVED">Resolved</TabsTrigger>
            <TabsTrigger value="CLOSED">Closed</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !rows.length ? (
        <EmptyState icon={isBug ? <Bug /> : <Lightbulb />} title={isBug ? 'No bug reports here' : 'No feedback here'}
          description={isBug ? 'Found something broken? Report it — the page you are on is attached automatically.' : 'Tell us what would make your work easier.'}
          action={<Button variant="outline" onClick={() => setParams({ new: '1' })}><Plus /> {isBug ? 'Report a bug' : 'Share feedback'}</Button>} />
      ) : (
        <div className="grid gap-2">
          {rows.map((t) => (
            <Card key={t.id} role="button" tabIndex={0} onClick={() => setSelected(t.id)} onKeyDown={(e) => e.key === 'Enter' && setSelected(t.id)}
              className="cursor-pointer flex-row items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
              <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-lg', isBug ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600')}>
                {isBug ? <Bug className="size-4" /> : <Lightbulb className="size-4" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium"><span className="text-muted-foreground">#{t.number}</span> {t.subject}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {categories.find((c) => c.value === t.category)?.label ?? titleCase(t.category)} · {timeAgo(t.created_at)}
                  {t.replies > 0 && <> · <MessageSquare className="inline size-3" /> {t.replies}</>}
                </p>
              </div>
              {t.rating && <span className="hidden items-center gap-0.5 text-xs text-amber-500 sm:flex">{t.rating}<Star className="size-3 fill-current" /></span>}
              {isBug && t.priority !== 'NORMAL' && <Badge variant={PRIORITY_VARIANT[t.priority as keyof typeof PRIORITY_VARIANT]}>{titleCase(t.priority)}</Badge>}
              <Badge variant={TICKET_STATUS[t.status as TicketStatus].variant}>{TICKET_STATUS[t.status as TicketStatus].label}</Badge>
            </Card>
          ))}
        </div>
      )}

      <NewTicketDialog kind={kind} open={creating} onOpenChange={(o) => !o && setParams({})} onCreated={(t) => { setParams({}); setSelected(t.id) }} />
      <TicketSheet ticket={current} support={support} onOpenChange={(o) => !o && setSelected(null)} />
    </div>
  )
}

function NewTicketDialog({ kind, open, onOpenChange, onCreated }: { kind: TicketKind; open: boolean; onOpenChange: (o: boolean) => void; onCreated: (t: Ticket) => void }) {
  const queryClient = useQueryClient()
  const isBug = kind === 'BUG'
  const [category, setCategory] = useState('GENERAL')
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [priority, setPriority] = useState('NORMAL')
  const [rating, setRating] = useState<number | null>(null)
  useEffect(() => { if (open) { setCategory(isBug ? 'GENERAL' : 'FEATURE'); setSubject(''); setBody(''); setPriority('NORMAL'); setRating(null) } }, [open, isBug])
  const send = useMutation({
    mutationFn: () => createTicket({ kind, category, subject: subject.trim(), body: body.trim(), rating, priority, context: { browser: navigator.userAgent, screen: `${window.innerWidth}×${window.innerHeight}` } }),
    onSuccess: (t) => {
      toast.success(isBug ? `Bug #${t.number} reported` : `Thanks! Feedback #${t.number} sent`)
      void queryClient.invalidateQueries({ queryKey: ['tickets'] })
      onCreated(t)
    },
  })
  const cats = isBug ? BUG_CATEGORIES : FEEDBACK_CATEGORIES
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={isBug ? 'Report a bug' : 'Share feedback'} submitLabel={isBug ? 'Send report' : 'Send feedback'}
      description={isBug ? 'Say what you did, what you expected and what happened instead. Your browser and screen size are attached.' : 'Ideas, wishes and praise all help.'}
      onSubmit={() => send.mutate()} busy={send.isPending} disabled={subject.trim().length < 3 || body.trim().length < 5}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Area">
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{cats.map((c) => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {isBug ? (
          <Field label="How urgent?">
            <Select value={priority} onValueChange={setPriority}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="LOW">Low — small annoyance</SelectItem>
                <SelectItem value="NORMAL">Normal</SelectItem>
                <SelectItem value="HIGH">High — slows my work</SelectItem>
                <SelectItem value="URGENT">Urgent — I can't work</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        ) : (
          <Field label="How happy are you with the system?">
            <div className="flex h-9 items-center gap-1">
              {[1, 2, 3, 4, 5].map((n) => (
                <button key={n} type="button" onClick={() => setRating(rating === n ? null : n)} aria-label={`${n} star${n > 1 ? 's' : ''}`}
                  className={cn('text-muted-foreground/40 transition-colors hover:text-amber-500', rating && n <= rating && 'text-amber-500')}>
                  <Star className={cn('size-6', rating && n <= rating && 'fill-current')} />
                </button>
              ))}
            </div>
          </Field>
        )}
      </div>
      <Field label="Title" htmlFor="t-subject" required>
        <Input id="t-subject" maxLength={140} value={subject} onChange={(e) => setSubject(e.target.value)}
          placeholder={isBug ? 'e.g. Pathao booking shows "Store not found"' : 'e.g. Send SMS to selected orders'} />
      </Field>
      <Field label={isBug ? 'What happened?' : 'Tell us more'} htmlFor="t-body" required>
        <Textarea id="t-body" rows={5} maxLength={4000} value={body} onChange={(e) => setBody(e.target.value)}
          placeholder={isBug ? '1. Opened order ISO-10233\n2. Pressed Book with Pathao\n3. Got an error…' : ''} />
      </Field>
    </FormDialog>
  )
}

function TicketSheet({ ticket: t, support, onOpenChange }: { ticket: Ticket | null; support: boolean; onOpenChange: (o: boolean) => void }) {
  const { access } = useAuth()
  const { nameOf } = useStaffDirectory()
  const queryClient = useQueryClient()
  const [reply, setReply] = useState('')
  const msgs = useQuery({ queryKey: ['ticket-messages', t?.id], queryFn: () => ticketMessages(t!.id), enabled: !!t, refetchInterval: 30_000 })
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tickets'] })
    void queryClient.invalidateQueries({ queryKey: ['ticket-messages', t?.id] })
  }
  const send = useMutation({ mutationFn: () => replyTicket(t!.id, reply.trim()), onSuccess: () => { setReply(''); refresh() } })
  const update = useMutation({ mutationFn: (p: { status?: TicketStatus; priority?: string }) => updateTicket(t!.id, p), onSuccess: () => { toast.success('Updated'); refresh() } })
  const mine = t?.created_by === access?.user_id
  const ctx = (t?.context ?? {}) as Record<string, string>
  return (
    <Sheet open={!!t} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-lg">
        {t && (
          <>
            <SheetHeader className="border-b">
              <SheetTitle className="pr-6">#{t.number} {t.subject}</SheetTitle>
              <SheetDescription>{nameOf(t.created_by)} · {formatDateTime(t.created_at)}</SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant={TICKET_STATUS[t.status as TicketStatus].variant}>{TICKET_STATUS[t.status as TicketStatus].label}</Badge>
                {t.kind === 'BUG' && <Badge variant={PRIORITY_VARIANT[t.priority as keyof typeof PRIORITY_VARIANT]}>{titleCase(t.priority)} priority</Badge>}
                {t.rating && <Badge variant="warning">{t.rating} <Star className="fill-current" /></Badge>}
              </div>
            </SheetHeader>
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              <div className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">{t.body}</div>
              {(ctx.page || ctx.browser) && (
                <dl className="grid grid-cols-[70px_1fr] gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  {ctx.page && <><dt>Page</dt><dd className="truncate font-mono">{ctx.page}</dd></>}
                  {ctx.screen && <><dt>Screen</dt><dd>{ctx.screen}</dd></>}
                  {ctx.browser && <><dt>Browser</dt><dd className="line-clamp-2">{ctx.browser}</dd></>}
                </dl>
              )}
              {msgs.isLoading ? <LoadingState /> : (msgs.data ?? []).map((m) => (
                <div key={m.id} className={cn('flex', m.author_id === access?.user_id ? 'justify-end' : 'justify-start')}>
                  <div className={cn('max-w-[85%] rounded-xl px-3 py-2 text-sm', m.author_id === access?.user_id ? 'bg-brand text-brand-foreground' : 'bg-muted')}>
                    <p className="mb-0.5 text-[11px] opacity-75">{nameOf(m.author_id)}{m.is_support && ' · Support'} · {timeAgo(m.created_at)}</p>
                    <p className="whitespace-pre-wrap">{m.body}</p>
                  </div>
                </div>
              ))}
            </div>
            <div className="space-y-2 border-t p-4">
              {support && (
                <div className="flex flex-wrap gap-2">
                  <Select value={t.status} onValueChange={(v) => update.mutate({ status: v as TicketStatus })}>
                    <SelectTrigger className="h-8 w-36" aria-label="Status"><SelectValue /></SelectTrigger>
                    <SelectContent>{(Object.keys(TICKET_STATUS) as TicketStatus[]).map((s) => <SelectItem key={s} value={s}>{TICKET_STATUS[s].label}</SelectItem>)}</SelectContent>
                  </Select>
                  {t.kind === 'BUG' && (
                    <Select value={t.priority} onValueChange={(v) => update.mutate({ priority: v })}>
                      <SelectTrigger className="h-8 w-32" aria-label="Priority"><SelectValue /></SelectTrigger>
                      <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{titleCase(p)}</SelectItem>)}</SelectContent>
                    </Select>
                  )}
                </div>
              )}
              <form className="flex items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (reply.trim()) send.mutate() }}>
                <Textarea rows={2} value={reply} onChange={(e) => setReply(e.target.value)} placeholder={mine && ['RESOLVED', 'CLOSED'].includes(t.status) ? 'Writing again reopens it' : 'Write a reply…'} />
                <Button type="submit" size="icon" disabled={!reply.trim() || send.isPending} aria-label="Send reply">{send.isPending ? <Spinner /> : <Send />}</Button>
              </form>
              {mine && !support && t.status !== 'CLOSED' && (
                <Button variant="ghost" size="sm" disabled={update.isPending} onClick={() => update.mutate({ status: 'CLOSED' })}>Close — it's sorted</Button>
              )}
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
