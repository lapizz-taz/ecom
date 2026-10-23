import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, CheckCheck, Mail, MessageCircle, MessageSquare, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { type Column, DataTable } from '@/components/common/data-table'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime } from '@/lib/format'
import { MESSAGE_STATUS } from '@/lib/status'
import { toast } from '@/lib/toast'
import { listMessageLogs, type MessageChannel, type MessageLog, retryMessage } from '@/services/messaging'
import { EVENT_INFO, type MessageEvent } from './shared'

const PROVIDER: Record<string, string> = { smtp: 'your mailbox', fullfilio: 'Fullfilio email service', meta: 'WhatsApp (Meta)' }
const phone = (to: string) => (to.startsWith('880') ? `0${to.slice(3)}` : to)
const what = (l: MessageLog) => (l.purpose === 'TEST' ? 'Test message' : l.event ? EVENT_INFO[l.event as MessageEvent]?.title ?? l.event : '—')
/** WhatsApp's receipts for a sent message: delivered to the phone, read, or not delivered after all. */
function Receipt({ log }: { log: MessageLog }) {
  if (log.channel !== 'WHATSAPP' || log.status !== 'SENT') return null
  if (log.delivery_status === 'READ') return <span className="flex items-center gap-1 text-xs text-sky-600"><CheckCheck className="size-3.5" /> Read</span>
  if (log.delivery_status === 'DELIVERED') return <span className="flex items-center gap-1 text-xs text-muted-foreground"><CheckCheck className="size-3.5" /> Delivered</span>
  if (log.delivery_status === 'FAILED') return <span className="text-xs text-red-600">Not delivered</span>
  return <span className="flex items-center gap-1 text-xs text-muted-foreground"><Check className="size-3.5" /> Sent</span>
}

/** The SMS that went instead of a WhatsApp message (WhatsApp → Setup → Send an SMS when WhatsApp can't). */
function SentBySms({ log }: { log: MessageLog }) {
  if (!log.fallback) return null
  const sent = log.fallback.status === 'SENT'
  return (
    <span className={`flex items-center gap-1 text-xs ${sent ? 'text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground'}`}>
      <MessageSquare className="size-3.5" /> {sent ? 'Sent by SMS instead' : log.fallback.status === 'FAILED' ? 'SMS instead failed' : 'Going by SMS instead'}
    </span>
  )
}

/** The email as the customer got it (before sending, the log holds the template). */
const renderedEmail = (l: MessageLog) => l.purpose === 'TEST' || (l.data as { rendered?: boolean } | null)?.rendered === true

/** Every email or WhatsApp message: to whom, why, what happened. */
export function MessageLogTab({ channel }: { channel: MessageChannel }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ status: '', q: '' })
  const [open, setOpen] = useState<MessageLog | null>(null)
  const logs = useQuery({
    queryKey: ['message-logs', channel, state.status, state.q],
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    queryFn: () => listMessageLogs(channel, { status: state.status, search: state.q }),
  })
  const retry = useMutation({
    mutationFn: (id: string) => retryMessage(id),
    onSuccess: () => {
      toast.success('Queued to send again')
      setOpen(null)
      void queryClient.invalidateQueries({ queryKey: ['message-logs', channel] })
    },
  })
  const Icon = channel === 'EMAIL' ? Mail : MessageCircle

  const columns: Column<MessageLog>[] = [
    {
      key: 'when', header: 'When', primary: true,
      cell: (l) => (
        <span>
          <span className="block">{formatDateTime(l.sent_at ?? l.created_at)}</span>
          <span className="text-xs text-muted-foreground">{what(l)}</span>
        </span>
      ),
    },
    {
      key: 'to', header: 'To',
      cell: (l) => (
        <span>
          <span className="block max-w-56 truncate text-xs">{channel === 'EMAIL' ? l.recipient : phone(l.recipient)}</span>
          {l.orders && <Link to={`/admin/orders/${l.orders.id}`} className="text-xs font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{l.orders.order_number}</Link>}
        </span>
      ),
    },
    {
      key: 'text', header: channel === 'EMAIL' ? 'Subject' : 'Message', hideOnMobile: true,
      cell: (l) => <span className="line-clamp-2 max-w-md text-xs text-muted-foreground">{channel === 'EMAIL' ? (renderedEmail(l) ? l.subject : what(l)) : l.body}</span>,
    },
    {
      key: 'status', header: 'Status',
      cell: (l) => (
        <span className="space-y-0.5">
          {l.channel === 'WHATSAPP' && l.status === 'SENT' ? <Receipt log={l} /> : <StatusBadge value={l.status} map={MESSAGE_STATUS} />}
          {l.error && <span className="block max-w-56 truncate text-xs text-red-600" title={l.error}>{l.error}</span>}
          <SentBySms log={l} />
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder={channel === 'EMAIL' ? 'Email address' : 'Phone number'} />
        <Select value={state.status || 'all'} onValueChange={(v) => update({ status: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {Object.entries(MESSAGE_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <DataTable columns={columns} rows={logs.data} rowKey={(l) => l.id} loading={logs.isFetching} error={logs.error} onRetry={() => logs.refetch()} onRowClick={setOpen}
        empty={<EmptyState icon={<Icon className="size-5" />} title="Nothing sent yet" description="Messages appear here as soon as one is sent." />} />

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-2xl">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">{what(open)} <StatusBadge value={open.status} map={MESSAGE_STATUS} /></DialogTitle>
                <DialogDescription>To {channel === 'EMAIL' ? open.recipient : phone(open.recipient)} · {formatDateTime(open.created_at)}</DialogDescription>
              </DialogHeader>
              {channel === 'EMAIL' ? (
                renderedEmail(open) ? (
                  <div className="space-y-2">
                    <p className="text-sm"><span className="text-muted-foreground">Subject:</span> {open.subject}</p>
                    {/* The email as sent, in a sandbox: no scripts, no access to this page. */}
                    <iframe title="Email" sandbox="" srcDoc={open.body} className="h-96 w-full rounded-lg border bg-white" />
                  </div>
                ) : <p className="rounded-lg bg-muted p-3 text-sm text-muted-foreground">The email is written from its template when it is sent.</p>
              ) : <p className="rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap">{open.body}</p>}
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                {open.orders && <><dt className="text-muted-foreground">Order</dt><dd><Link to={`/admin/orders/${open.orders.id}`} className="font-medium hover:underline">{open.orders.order_number}</Link></dd></>}
                {open.status === 'SENT' && <><dt className="text-muted-foreground">Sent</dt><dd>{formatDateTime(open.sent_at)}{open.provider ? ` via ${PROVIDER[open.provider] ?? open.provider}` : ''}</dd></>}
                {open.delivered_at && <><dt className="text-muted-foreground">Delivered</dt><dd>{formatDateTime(open.delivered_at)}</dd></>}
                {open.read_at && <><dt className="text-muted-foreground">Read</dt><dd>{formatDateTime(open.read_at)}</dd></>}
                {open.fallback && <><dt className="text-muted-foreground">Instead</dt><dd><SentBySms log={open} /></dd></>}
                <dt className="text-muted-foreground">Tries</dt><dd>{open.attempts}</dd>
                {open.error && <><dt className="text-muted-foreground">Problem</dt><dd className="text-red-700">{open.error}</dd></>}
              </dl>
              {can('notifications.manage') && open.purpose !== 'TEST' && !open.fallback && (open.status === 'FAILED' || open.status === 'SKIPPED') && (
                <div className="flex justify-end">
                  <Button onClick={() => retry.mutate(open.id)} disabled={retry.isPending}>{retry.isPending ? <Spinner /> : <RefreshCw />} Send again</Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
