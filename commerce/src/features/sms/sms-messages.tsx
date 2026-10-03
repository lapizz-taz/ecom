import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { type Column, DataTable } from '@/components/common/data-table'
import { Money } from '@/components/common/money'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime } from '@/lib/format'
import { MESSAGE_STATUS, SMS_DELIVERY } from '@/lib/status'
import { type DeliveryStatus, listSmsMessages, type MessageStatus, retryMessage, type SmsMessageRow } from '@/services/sms'
import { providerName } from './sms-provider'
import { eventLabel, SMS_EVENTS } from './sms-text'

const phone = (to: string) => (to.startsWith('880') ? `0${to.slice(3)}` : to)

function Delivery({ m }: { m: SmsMessageRow }) {
  if (m.status !== 'SENT' || !m.delivery_status) return null
  const d = m.delivery_status as DeliveryStatus
  return (
    <span className={`block text-xs ${d === 'FAILED' ? 'text-red-600' : d === 'DELIVERED' ? 'text-emerald-600' : 'text-muted-foreground'}`}>
      {SMS_DELIVERY[d]}
    </span>
  )
}

/** Every SMS: who it went to, why, what happened and what it cost. */
export function SmsMessagesTab() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ status: '', event: '', q: '', page: '1' })
  const page = Number(state.page) || 1
  const [open, setOpen] = useState<SmsMessageRow | null>(null)
  const messages = useQuery({
    queryKey: ['sms-messages', state.status, state.event, state.q, page],
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    queryFn: () => listSmsMessages({ status: state.status as MessageStatus, event: state.event, q: state.q, page, pageSize: 25 }),
  })
  const retry = useMutation({
    mutationFn: (id: string) => retryMessage(id),
    onSuccess: () => {
      toast.success('Queued to send again')
      setOpen(null)
      void queryClient.invalidateQueries({ queryKey: ['sms-messages'] })
    },
  })

  const columns: Column<SmsMessageRow>[] = [
    {
      key: 'when', header: 'Sent', primary: true,
      cell: (m) => (
        <span>
          <span className="block">{formatDateTime(m.sent_at ?? m.created_at)}</span>
          <span className="text-xs text-muted-foreground">{eventLabel(m.event)}</span>
        </span>
      ),
    },
    {
      key: 'to', header: 'To',
      cell: (m) => (
        <span>
          <span className="block font-mono text-xs">{phone(m.recipient)}</span>
          {m.orders && <Link to={`/admin/orders/${m.orders.id}`} className="text-xs font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{m.orders.order_number}</Link>}
        </span>
      ),
    },
    { key: 'text', header: 'Message', hideOnMobile: true, cell: (m) => <span className="line-clamp-2 max-w-md text-xs text-muted-foreground">{m.body}</span> },
    {
      key: 'status', header: 'Status',
      cell: (m) => (
        <span className="space-y-0.5">
          <StatusBadge value={m.status} map={MESSAGE_STATUS} />
          <Delivery m={m} />
          {m.error && <span className="block max-w-56 truncate text-xs text-red-600" title={m.error}>{m.error}</span>}
        </span>
      ),
    },
    {
      key: 'cost', header: 'Cost', align: 'right',
      cell: (m) => (
        <span className="text-xs">
          {m.status === 'SENT' && m.cost !== null ? <Money value={m.cost} /> : <span className="text-muted-foreground">—</span>}
          <span className="block text-muted-foreground">{m.segments ?? 0} SMS{m.encoding === 'UNICODE' ? ' · Unicode' : ''}</span>
        </span>
      ),
    },
  ]

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Phone or order number" />
        <Select value={state.status || 'all'} onValueChange={(v) => update({ status: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All statuses</SelectItem>
            {(Object.keys(MESSAGE_STATUS) as MessageStatus[]).map((k) => <SelectItem key={k} value={k}>{MESSAGE_STATUS[k].label}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={state.event || 'all'} onValueChange={(v) => update({ event: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All messages</SelectItem>
            {SMS_EVENTS.map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}
            <SelectItem value="TEST">Test messages</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <DataTable columns={columns} rows={messages.data?.items} rowKey={(m) => m.id} loading={messages.isFetching} error={messages.error}
        onRetry={() => messages.refetch()} onRowClick={setOpen}
        empty={<EmptyState icon={<MessageSquare className="size-5" />} title="No messages" description="Messages appear here as soon as an automation sends one." />}
        footer={<Pagination page={page} pageSize={25} total={messages.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-lg">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">{eventLabel(open.event)} <StatusBadge value={open.status} map={MESSAGE_STATUS} /></DialogTitle>
                <DialogDescription>To {phone(open.recipient)} · queued {formatDateTime(open.created_at)}</DialogDescription>
              </DialogHeader>
              <p className="rounded-lg bg-muted p-3 text-sm whitespace-pre-wrap">{open.body}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                {open.orders && <><dt className="text-muted-foreground">Order</dt><dd><Link to={`/admin/orders/${open.orders.id}`} className="font-medium hover:underline">{open.orders.order_number}</Link></dd></>}
                <dt className="text-muted-foreground">Size</dt><dd>{open.segments ?? 0} SMS · {open.encoding === 'UNICODE' ? 'Unicode' : 'GSM'}</dd>
                {open.status === 'SENT' && (
                  <>
                    <dt className="text-muted-foreground">Sent</dt><dd>{formatDateTime(open.sent_at)} via {providerName(open.provider)}</dd>
                    <dt className="text-muted-foreground">Delivery</dt>
                    <dd>{SMS_DELIVERY[(open.delivery_status ?? 'UNKNOWN') as DeliveryStatus]}{open.delivered_at ? ` · ${formatDateTime(open.delivered_at)}` : ''}</dd>
                    <dt className="text-muted-foreground">Cost</dt>
                    <dd><Money value={open.cost ?? 0} /> <span className="text-xs text-muted-foreground">{open.cost_source === 'PROVIDER' ? 'charged by the provider' : 'estimated'}</span></dd>
                  </>
                )}
                {open.provider_message_id && <><dt className="text-muted-foreground">Provider id</dt><dd className="font-mono text-xs">{open.provider_message_id}</dd></>}
                <dt className="text-muted-foreground">Tries</dt><dd>{open.attempts}</dd>
                {open.error && <><dt className="text-muted-foreground">Error</dt><dd className="text-red-700">{open.error}</dd></>}
              </dl>
              {can('sms.manage') && (open.status === 'FAILED' || open.status === 'SKIPPED') && (
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
