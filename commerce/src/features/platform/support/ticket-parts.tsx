import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowUpCircle, Eye, Lock, MessageSquare, Send, StickyNote } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { usePlatform } from '@/features/platform/platform-context'
import { MerchantPicker } from '@/features/platform/services/merchant-picker'
import { StartSessionDialog } from '@/features/platform/support/start-session-dialog'
import { formatDateTime, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import type { MerchantRef } from '@/services/platform'
import {
  createTicket, endSupportSession, escalateTicket, getTicket, noteTicket, type PlatformTicket, replyTicket, type SupportSession, TICKET_PRIORITY,
  type TicketEvent, type TicketPriority, type TicketStatus, updateTicket,
} from '@/services/support-center'

const TICKET_STATUS: Record<TicketStatus, { label: string; variant: 'info' | 'warning' | 'success' | 'neutral' }> = {
  OPEN: { label: 'Open', variant: 'info' },
  IN_PROGRESS: { label: 'In progress', variant: 'warning' },
  RESOLVED: { label: 'Resolved', variant: 'success' },
  CLOSED: { label: 'Closed', variant: 'neutral' },
}
const PRIORITIES = Object.keys(TICKET_PRIORITY) as TicketPriority[]

/** "in 3h", "2h late" — how long until (or since) a due time. */
function dueLabel(at: string | null): string {
  if (!at) return '—'
  const minutes = Math.round((new Date(at).getTime() - Date.now()) / 60_000)
  const abs = Math.abs(minutes)
  const span = abs < 60 ? `${abs}m` : abs < 48 * 60 ? `${Math.round(abs / 60)}h` : `${Math.round(abs / 1440)}d`
  return minutes >= 0 ? `in ${span}` : `${span} late`
}

const open = (t: { status: TicketStatus }) => t.status === 'OPEN' || t.status === 'IN_PROGRESS'

export function TicketsTable({ rows, onOpen, showMerchant = true }: { rows: PlatformTicket[]; onOpen: (id: string) => void; showMerchant?: boolean }) {
  if (rows.length === 0) return <EmptyState icon={<MessageSquare />} title="No tickets here" description="Nothing matches these filters." />
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-16">#</TableHead><TableHead>Ticket</TableHead><TableHead>Priority</TableHead><TableHead>Status</TableHead>
            <TableHead>Assigned</TableHead><TableHead>Due</TableHead><TableHead>Last activity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((t) => (
            <TableRow key={t.id} className="cursor-pointer" onClick={() => onOpen(t.id)}>
              <TableCell className="text-xs text-muted-foreground">{t.number}</TableCell>
              <TableCell className="max-w-80">
                <p className="flex items-center gap-1.5 truncate font-medium">
                  {t.internal && <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Internal" />}
                  {t.escalation_level > 0 && <ArrowUpCircle className="size-3.5 shrink-0 text-amber-500" aria-label={`Escalated level ${t.escalation_level}`} />}
                  <span className="truncate">{t.subject}</span>
                </p>
                <p className="truncate text-xs text-muted-foreground">
                  {showMerchant && <>#{t.merchant.number} {t.merchant.name} · </>}{t.reporter?.platform ? 'opened by platform' : t.reporter?.name ?? 'merchant'}
                </p>
              </TableCell>
              <TableCell><Badge variant={TICKET_PRIORITY[t.priority].variant}>{TICKET_PRIORITY[t.priority].label}</Badge></TableCell>
              <TableCell>
                <Badge variant={TICKET_STATUS[t.status].variant}>{TICKET_STATUS[t.status].label}</Badge>
                {open(t) && t.last_reply_from !== 'PLATFORM' && <p className="mt-0.5 text-[11px] text-amber-500">Waiting on us</p>}
              </TableCell>
              <TableCell className="text-xs">{t.assigned?.name ?? <span className="text-muted-foreground">Nobody</span>}</TableCell>
              <TableCell className={cn('text-xs whitespace-nowrap', t.overdue && 'font-medium text-red-500')}>
                {open(t) ? dueLabel(t.due_at) : t.resolved_at ? `done ${timeAgo(t.resolved_at)}` : '—'}
              </TableCell>
              <TableCell className="text-xs whitespace-nowrap text-muted-foreground">{timeAgo(t.last_reply_at ?? t.created_at)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export function NewTicketDialog({ merchant, onClose, onCreated }: { merchant?: MerchantRef | null; onClose: () => void; onCreated: (id: string) => void }) {
  const [picked, setPicked] = useState<MerchantRef | null>(merchant ?? null)
  const [form, setForm] = useState({ subject: '', body: '', priority: 'NORMAL' as TicketPriority, internal: false, category: 'GENERAL' })
  const create = useMutation({
    meta: { silent: true },
    mutationFn: () => createTicket({ merchant: picked!.id, subject: form.subject.trim(), body: form.body.trim(), priority: form.priority, internal: form.internal, category: form.category }),
    onSuccess: (t) => { toast.success(`Ticket #${t.number} opened`); onCreated(t.id); onClose() },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Open a ticket" submitLabel="Open ticket" busy={create.isPending}
      disabled={!picked || form.subject.trim().length < 3 || form.body.trim().length < 5} onSubmit={() => create.mutate()}
      description="For a phone call, a problem you noticed, or work the team needs to do for a merchant.">
      <div className="grid gap-3">
        {!merchant && <Field label="Merchant" required><MerchantPicker value={picked} onChange={setPicked} /></Field>}
        <Field label="Title" required><Input value={form.subject} maxLength={140} onChange={(e) => setForm((f) => ({ ...f, subject: e.target.value }))} /></Field>
        <Field label="What happened" required><Textarea rows={4} value={form.body} onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Priority">
            <Select value={form.priority} onValueChange={(v) => setForm((f) => ({ ...f, priority: v as TicketPriority }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{TICKET_PRIORITY[p].label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Area">
            <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {[['GENERAL', 'General'], ['ONBOARDING', 'Onboarding'], ['BILLING', 'Billing'], ['INTEGRATION', 'Integrations'], ['ORDERS', 'Orders'],
                  ['COURIER', 'Courier'], ['SMS', 'SMS'], ['PBX', 'PBX']].map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        </div>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox className="mt-0.5" checked={form.internal} onCheckedChange={(v) => setForm((f) => ({ ...f, internal: v === true }))} />
          <span>Internal — the merchant does not see this ticket<span className="block text-xs text-muted-foreground">Otherwise it appears in their bug reports and they can reply.</span></span>
        </label>
        {create.error && <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-500" role="alert">{create.error.message}</p>}
      </div>
    </FormDialog>
  )
}

const EVENT_TEXT: Record<TicketEvent['kind'], (e: TicketEvent) => string> = {
  CREATED: (e) => `Opened by ${e.data.by === 'PLATFORM' ? 'the platform team' : 'the merchant'} (${String(e.data.priority ?? '').toLowerCase()})`,
  NOTE: () => 'Internal note',
  ASSIGNED: (e) => (e.data.to ? `Assigned to ${String(e.data.to_email ?? 'someone')}` : 'Unassigned'),
  STATUS: (e) => `Status ${String(e.data.from).toLowerCase().replace('_', ' ')} → ${String(e.data.to).toLowerCase().replace('_', ' ')}`,
  PRIORITY: (e) => `Priority ${String(e.data.from).toLowerCase()} → ${String(e.data.to).toLowerCase()}`,
  DUE: (e) => `Due time changed to ${formatDateTime(String(e.data.to))}`,
  ESCALATED: (e) => `Escalated to level ${String(e.data.level)}${e.data.automatic ? ' (automation rule)' : ''} · priority ${String(e.data.priority_to).toLowerCase()}`,
  REPLY: () => 'Replied to the merchant',
  MERCHANT_REPLY: () => 'Merchant replied',
  SESSION: (e) => `Opened a ${String(e.data.minutes)}-minute customer view`,
}

export function SessionsTable({ rows, canManage, onChanged, showMerchant = true }: { rows: SupportSession[]; canManage: boolean; onChanged: () => void; showMerchant?: boolean }) {
  const { me } = usePlatform()
  const [ending, setEnding] = useState<SupportSession | null>(null)
  if (rows.length === 0) return <EmptyState icon={<Eye />} title="No customer-view sessions" description="Sessions you or your team open appear here, with who, why and for how long." />
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {showMerchant && <TableHead>Merchant</TableHead>}<TableHead>Employee</TableHead><TableHead>Reason</TableHead><TableHead>Started</TableHead>
            <TableHead>Length</TableHead><TableHead>Status</TableHead><TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((s) => (
            <TableRow key={s.id}>
              {showMerchant && <TableCell className="text-xs"><Link className="underline" to={`/super-admin/merchants/${s.merchant.id}`}>#{s.merchant.number} {s.merchant.name}</Link></TableCell>}
              <TableCell className="text-xs">{s.staff?.name ?? '—'}</TableCell>
              <TableCell className="max-w-72 text-xs">
                <p className="line-clamp-2">{s.reason}</p>
                {s.ticket && <p className="text-muted-foreground">Ticket #{s.ticket.number}</p>}
              </TableCell>
              <TableCell className="text-xs whitespace-nowrap">{formatDateTime(s.started_at)}</TableCell>
              <TableCell className="text-xs whitespace-nowrap">{s.minutes} min{s.status === 'ACTIVE' && <span className="text-muted-foreground"> · ends {dueLabel(s.expires_at)}</span>}</TableCell>
              <TableCell>
                <Badge variant={s.status === 'ACTIVE' ? 'success' : s.status === 'EXPIRED' ? 'neutral' : 'info'}>{s.status.toLowerCase()}</Badge>
                {s.end_reason && s.status !== 'ACTIVE' && s.end_reason !== 'Expired' && <p className="mt-0.5 max-w-40 truncate text-[11px] text-muted-foreground">{s.end_reason}</p>}
              </TableCell>
              <TableCell className="text-right">
                {s.status === 'ACTIVE' && s.staff?.user_id === me?.user_id && <Button size="sm" variant="outline" onClick={() => window.location.assign('/admin')}>Open</Button>}
                {s.status === 'ACTIVE' && (canManage || s.staff?.user_id === me?.user_id) && <Button size="sm" variant="ghost" onClick={() => setEnding(s)}>End</Button>}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <ConfirmDialog open={!!ending} onOpenChange={(o) => !o && setEnding(null)} title="End this customer view?" confirmLabel="End session"
        reason reasonRequired={ending?.staff?.user_id !== me?.user_id}
        description={ending?.staff?.user_id === me?.user_id ? 'Your read-only access to the merchant ends now.' : `Ends ${ending?.staff?.name ?? 'their'}'s access now. Say why — it is logged.`}
        onConfirm={async (reason) => {
          try { await endSupportSession(ending!.id, reason || undefined); toast.success('Session ended'); onChanged() } catch (e) { toast.error((e as Error).message); throw e }
        }} />
    </div>
  )
}

export function TicketSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const { me } = usePlatform()
  const q = useQuery({ queryKey: ['platform-ticket', id], enabled: !!id, queryFn: () => getTicket(id!) })
  const [text, setText] = useState('')
  const [mode, setMode] = useState<'reply' | 'note'>('reply')
  const [dialog, setDialog] = useState<'escalate' | 'view' | null>(null)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform-ticket', id] })
    void queryClient.invalidateQueries({ queryKey: ['platform-tickets'] })
  }
  const send = useMutation({
    mutationFn: () => (mode === 'reply' && !q.data?.internal ? replyTicket(id!, text.trim()) : noteTicket(id!, text.trim())),
    onSuccess: () => { setText(''); refresh() },
  })
  const update = useMutation({
    mutationFn: (p: Parameters<typeof updateTicket>[1]) => updateTicket(id!, p),
    onSuccess: () => { toast.success('Updated'); refresh() },
  })
  const t = q.data
  const noteOnly = t?.internal || mode === 'note'
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="flex w-full flex-col gap-0 p-0 sm:max-w-2xl">
        {q.error ? <div className="p-6"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div> : !t ? <LoadingState /> : (
          <>
            <SheetHeader className="border-b">
              <SheetTitle className="flex items-center gap-2 pr-6">
                {t.internal && <Lock className="size-4 text-muted-foreground" />}#{t.number} {t.subject}
              </SheetTitle>
              <SheetDescription>
                <Link className="underline" to={`/super-admin/merchants/${t.merchant.id}`}>#{t.merchant.number} {t.merchant.name}</Link>
                {' · '}{t.reporter?.platform ? `opened by ${t.reporter.name}` : `from ${t.reporter?.name ?? 'the merchant'}`} · {formatDateTime(t.created_at)}
              </SheetDescription>
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Badge variant={TICKET_STATUS[t.status].variant}>{TICKET_STATUS[t.status].label}</Badge>
                <Badge variant={TICKET_PRIORITY[t.priority].variant}>{TICKET_PRIORITY[t.priority].label}</Badge>
                {t.internal && <Badge variant="neutral">Internal</Badge>}
                {t.escalation_level > 0 && <Badge variant="warning">Escalated · level {t.escalation_level}</Badge>}
                {open(t) && <span className={cn('text-xs', t.overdue ? 'font-medium text-red-500' : 'text-muted-foreground')}>Due {dueLabel(t.due_at)}</span>}
                {open(t) && !t.first_response_at && !t.internal && <span className={cn('text-xs', new Date(t.response_due_at) < new Date() ? 'text-red-500' : 'text-muted-foreground')}>· first reply {dueLabel(t.response_due_at)}</span>}
              </div>
              {t.can.edit && (
                <div className="flex flex-wrap gap-2 pt-2">
                  <Select value={t.status} onValueChange={(v) => update.mutate({ status: v as TicketStatus })}>
                    <SelectTrigger size="sm" className="w-36" aria-label="Status"><SelectValue /></SelectTrigger>
                    <SelectContent>{(Object.keys(TICKET_STATUS) as TicketStatus[]).map((s) => <SelectItem key={s} value={s}>{TICKET_STATUS[s].label}</SelectItem>)}</SelectContent>
                  </Select>
                  <Select value={t.priority} onValueChange={(v) => update.mutate({ priority: v as TicketPriority })}>
                    <SelectTrigger size="sm" className="w-28" aria-label="Priority"><SelectValue /></SelectTrigger>
                    <SelectContent>{PRIORITIES.map((p) => <SelectItem key={p} value={p}>{TICKET_PRIORITY[p].label}</SelectItem>)}</SelectContent>
                  </Select>
                  <Select value={t.assigned?.user_id ?? 'none'} onValueChange={(v) => update.mutate({ assigned_to: v === 'none' ? null : v })}>
                    <SelectTrigger size="sm" className="w-44" aria-label="Assigned to"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">Nobody</SelectItem>
                      {t.assignable.filter((a) => t.can.manage || a.user_id === me?.user_id || a.user_id === t.assigned?.user_id).map((a) =>
                        <SelectItem key={a.user_id} value={a.user_id}>{a.user_id === me?.user_id ? `Me (${a.name})` : a.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  {open(t) && t.escalation_level < 5 && <Button size="sm" variant="outline" onClick={() => setDialog('escalate')}><ArrowUpCircle /> Escalate</Button>}
                  {t.can.view_as && <Button size="sm" variant="outline" onClick={() => setDialog('view')}><Eye /> View as merchant</Button>}
                </div>
              )}
            </SheetHeader>
            <Tabs defaultValue="conversation" className="flex min-h-0 flex-1 flex-col">
              <TabsList className="mx-4 mt-3 w-fit">
                <TabsTrigger value="conversation">Conversation</TabsTrigger>
                <TabsTrigger value="history">History ({t.events.length})</TabsTrigger>
                <TabsTrigger value="context">Merchant & logs{t.logs.length > 0 && ` (${t.logs.length})`}</TabsTrigger>
              </TabsList>
              <TabsContent value="conversation" className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                <div className="rounded-lg bg-muted/50 p-3 text-sm whitespace-pre-wrap">{t.body}</div>
                {(t.context.page || t.context.browser) && (
                  <dl className="grid grid-cols-[70px_1fr] gap-x-2 gap-y-1 text-xs text-muted-foreground">
                    {t.context.page && <><dt>Page</dt><dd className="truncate font-mono">{t.context.page}</dd></>}
                    {t.context.browser && <><dt>Browser</dt><dd className="line-clamp-2">{t.context.browser}</dd></>}
                  </dl>
                )}
                {t.messages.map((m) => (
                  <div key={m.id} className={cn('flex', m.from === 'PLATFORM' ? 'justify-end' : 'justify-start')}>
                    <div className={cn('max-w-[85%] rounded-xl px-3 py-2 text-sm', m.from === 'PLATFORM' ? 'bg-brand text-brand-foreground' : 'bg-muted')}>
                      <p className="mb-0.5 text-[11px] opacity-75">{m.author ?? 'Unknown'}{m.from === 'PLATFORM' && m.label && ` · shown as "${m.label}"`} · {timeAgo(m.created_at)}</p>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                    </div>
                  </div>
                ))}
                {t.events.filter((e) => e.kind === 'NOTE').map((e) => (
                  <div key={e.id} className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm">
                    <p className="mb-0.5 flex items-center gap-1 text-[11px] text-amber-600"><StickyNote className="size-3" /> Internal note · {e.actor ?? 'system'} · {timeAgo(e.created_at)}</p>
                    <p className="whitespace-pre-wrap">{e.body}</p>
                  </div>
                ))}
              </TabsContent>
              <TabsContent value="history" className="min-h-0 flex-1 overflow-y-auto p-4">
                <ol className="space-y-2 border-l pl-4">
                  {t.events.map((e) => (
                    <li key={e.id} className="text-sm">
                      <p>{EVENT_TEXT[e.kind](e)}</p>
                      {e.body && e.kind !== 'NOTE' && <p className="line-clamp-2 text-xs text-muted-foreground">{e.body}</p>}
                      {e.kind === 'NOTE' && <p className="text-xs whitespace-pre-wrap text-muted-foreground">{e.body}</p>}
                      <p className="text-[11px] text-muted-foreground">{e.actor ?? 'system'} · {formatDateTime(e.created_at)}</p>
                    </li>
                  ))}
                </ol>
              </TabsContent>
              <TabsContent value="context" className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm">
                <div className="grid grid-cols-2 gap-2 rounded-lg border p-3 text-xs">
                  <span className="text-muted-foreground">Account</span><span>{t.merchant_detail.status.toLowerCase()} · access {t.merchant_detail.access_mode.toLowerCase().replace('_', ' ')}</span>
                  <span className="text-muted-foreground">Plan</span><span>{t.merchant_detail.plan ? `${t.merchant_detail.plan.name} (${t.merchant_detail.plan.status.toLowerCase()})` : 'none'}</span>
                  <span className="text-muted-foreground">Owner</span><span className="truncate">{t.merchant_detail.owner_email ?? '—'}{t.merchant_detail.phone && ` · ${t.merchant_detail.phone}`}</span>
                  <span className="text-muted-foreground">Account manager</span><span>{t.merchant_detail.account_manager ?? '—'}</span>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Errors and warnings on their account (7 days before the ticket)</p>
                  {t.logs.length === 0 ? <p className="text-xs text-muted-foreground">None recorded.</p> : t.logs.map((l) => (
                    <div key={l.id} className="flex items-start gap-2 border-b py-1.5 text-xs last:border-0">
                      <AlertTriangle className={cn('mt-0.5 size-3.5 shrink-0', l.level === 'ERROR' ? 'text-red-500' : 'text-amber-500')} />
                      <div className="min-w-0">
                        <p className="line-clamp-2">{l.message}</p>
                        <p className="text-muted-foreground">{l.category.toLowerCase()} · {l.source} · ×{l.occurrences} · {timeAgo(l.last_seen_at)}{l.resolved && ' · resolved'}</p>
                      </div>
                    </div>
                  ))}
                </div>
                {t.other_open.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Their other open tickets</p>
                    {t.other_open.map((o) => <p key={o.id} className="text-xs">#{o.number} {o.subject} · {TICKET_PRIORITY[o.priority].label.toLowerCase()}</p>)}
                  </div>
                )}
                {t.sessions.length > 0 && (
                  <div>
                    <p className="mb-1 text-xs font-medium text-muted-foreground">Customer-view sessions around this ticket</p>
                    {t.sessions.map((s) => <p key={s.id} className="text-xs">{s.staff?.name} · {formatDateTime(s.started_at)} · {s.minutes} min · {s.status.toLowerCase()}</p>)}
                  </div>
                )}
              </TabsContent>
            </Tabs>
            {t.can.edit && (
              <form className="space-y-2 border-t p-4" onSubmit={(e) => { e.preventDefault(); if (text.trim()) send.mutate() }}>
                {!t.internal && (
                  <div className="flex gap-1 text-xs">
                    <button type="button" onClick={() => setMode('reply')} className={cn('rounded px-2 py-1', mode === 'reply' ? 'bg-muted font-medium' : 'text-muted-foreground')}>Reply to merchant</button>
                    <button type="button" onClick={() => setMode('note')} className={cn('rounded px-2 py-1', mode === 'note' ? 'bg-amber-500/15 font-medium text-amber-600' : 'text-muted-foreground')}>Internal note</button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} className={cn(noteOnly && 'border-amber-500/40')}
                    placeholder={noteOnly ? 'Only the platform team sees notes' : 'The merchant sees this reply'} />
                  <Button type="submit" size="icon" disabled={!text.trim() || send.isPending} aria-label={noteOnly ? 'Add note' : 'Send reply'}>
                    {send.isPending ? <Spinner /> : noteOnly ? <StickyNote /> : <Send />}
                  </Button>
                </div>
              </form>
            )}
            <ConfirmDialog open={dialog === 'escalate'} onOpenChange={(o) => !o && setDialog(null)} title={`Escalate #${t.number}?`} confirmLabel="Escalate"
              reason reasonRequired reasonLabel="Why"
              description="Raises the priority one step, moves the due time accordingly and alerts the support managers."
              onConfirm={async (reason) => {
                try { await escalateTicket(t.id, reason); toast.success('Escalated'); refresh() } catch (e) { toast.error((e as Error).message); throw e }
              }} />
            {dialog === 'view' && <StartSessionDialog merchant={t.merchant} ticket={{ id: t.id, number: t.number }} onClose={() => setDialog(null)} />}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}
