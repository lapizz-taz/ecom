import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Copy, KeyRound, RefreshCw, Webhook } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatMoney } from '@/lib/format'
import { SHIPMENT_STATUS, WEBHOOK_RESULT } from '@/lib/status'
import {
  courierWebhookUrl, type CourierRow, listCouriers, listWebhookEvents, retryWebhookEvent, setCourierWebhookSecret,
  type WebhookEventRow, type WebhookResult,
} from '@/services/couriers'

function StatusChange({ from, to, applied = true }: { from: string | null; to: string | null; applied?: boolean }) {
  if (!to) return <span className="text-muted-foreground">—</span>
  const label = (s: string | null) => (s ? SHIPMENT_STATUS[s as keyof typeof SHIPMENT_STATUS]?.label ?? s : '?')
  // Not applied: show what the courier said, not a change that never happened.
  if (!applied) return <span className="text-xs text-muted-foreground">Said: {label(to)}</span>
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      {from && from !== to && <><span className="text-muted-foreground">{label(from)}</span><ArrowRight className="size-3 text-muted-foreground" /></>}
      <span className="font-medium">{label(to)}</span>
    </span>
  )
}

/** Every courier callback: what it said, what it changed, and whether it worked. */
export function CourierWebhookLog() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ result: '', wcourier: '', wq: '', page: '1' })
  const page = Number(state.page) || 1
  const [open, setOpen] = useState<WebhookEventRow | null>(null)
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const events = useQuery({
    queryKey: ['courier-webhooks', state.result, state.wcourier, state.wq, page],
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    queryFn: () => listWebhookEvents({ result: state.result as WebhookResult, courierId: state.wcourier || undefined, q: state.wq, page, pageSize: 25 }),
  })
  const retry = useMutation({
    mutationFn: (id: string) => retryWebhookEvent(id),
    onSuccess: (r) => {
      ;(r?.status === 'processed' || r?.status === 'ignored' ? toast.success : toast.warning)(
        r?.status === 'processed' ? 'Applied' : r?.status === 'ignored' ? 'Received — nothing to change' : r?.status === 'unmatched' ? 'Still no matching parcel' : `Failed again: ${r?.error ?? ''}`)
      setOpen(null)
      void queryClient.invalidateQueries({ queryKey: ['courier-webhooks'] })
    },
  })

  const columns: Column<WebhookEventRow>[] = [
    {
      key: 'when', header: 'Received', primary: true,
      cell: (e) => (
        <span>
          <span className="block">{formatDateTime(e.received_at)}</span>
          <span className="text-xs text-muted-foreground">{e.couriers?.name ?? e.provider} · {e.event_type}</span>
        </span>
      ),
    },
    {
      key: 'parcel', header: 'Order / parcel',
      cell: (e) => (
        <span>
          {e.orders ? <Link to={`/admin/orders/${e.orders.id}`} className="block font-medium hover:underline" onClick={(ev) => ev.stopPropagation()}>{e.orders.order_number}</Link>
            : <span className="block text-muted-foreground">{e.order_ref ?? '—'}</span>}
          <span className="font-mono text-xs text-muted-foreground">{e.consignment_id ?? ''}</span>
        </span>
      ),
    },
    { key: 'status', header: 'Status', cell: (e) => <StatusChange from={e.previous_status} to={e.new_status} applied={e.result === 'PROCESSED'} /> },
    {
      key: 'result', header: 'Result',
      cell: (e) => (
        <span className="space-y-0.5">
          <StatusBadge value={e.result as WebhookResult} map={WEBHOOK_RESULT} />
          {(e.error || e.note) && <span className="block max-w-64 truncate text-xs text-muted-foreground" title={e.error ?? e.note ?? ''}>{e.error ?? e.note}</span>}
        </span>
      ),
    },
    {
      key: 'retry', header: 'Retries', align: 'right', hideOnMobile: true,
      cell: (e) => (
        <span className="text-xs text-muted-foreground">
          {e.attempts > 1 ? `${e.attempts} tries` : '1 try'}{e.duplicates > 0 ? ` · sent ${e.duplicates + 1}×` : ''}
          {e.next_retry_at && (e.result === 'FAILED' || e.result === 'UNMATCHED') && <span className="block">next {formatDateTime(e.next_retry_at)}</span>}
        </span>
      ),
    },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.wq} onChange={(wq) => update({ wq })} placeholder="Consignment or order" />
        <Select value={state.wcourier || 'all'} onValueChange={(v) => update({ wcourier: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All couriers</SelectItem>{(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={state.result || 'all'} onValueChange={(v) => update({ result: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All results</SelectItem>
            {(['PROCESSED', 'IGNORED', 'UNMATCHED', 'FAILED'] as const).map((k) => <SelectItem key={k} value={k}>{WEBHOOK_RESULT[k].label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <DataTable columns={columns} rows={events.data?.items} rowKey={(e) => e.id} loading={events.isFetching} error={events.error}
        onRetry={() => events.refetch()} onRowClick={setOpen}
        empty={<EmptyState icon={<Webhook className="size-5" />} title="No courier updates yet"
          description="Set up the webhook under Connections; each status change the courier sends appears here." />}
        footer={<Pagination page={page} pageSize={25} total={events.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />

      <Dialog open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="sm:max-w-2xl">
          {open && (
            <>
              <DialogHeader>
                <DialogTitle className="flex items-center gap-2">{open.couriers?.name ?? open.provider} · {open.event_type} <StatusBadge value={open.result as WebhookResult} map={WEBHOOK_RESULT} /></DialogTitle>
                <DialogDescription>Received {formatDateTime(open.received_at)}{open.occurred_at ? ` · happened ${formatDateTime(open.occurred_at)}` : ''}</DialogDescription>
              </DialogHeader>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                <dt className="text-muted-foreground">Parcel</dt><dd className="font-mono">{open.consignment_id ?? '—'}</dd>
                <dt className="text-muted-foreground">Order</dt><dd>{open.orders?.order_number ?? open.order_ref ?? '—'}</dd>
                <dt className="text-muted-foreground">Status</dt><dd><StatusChange from={open.previous_status} to={open.new_status} applied={open.result === 'PROCESSED'} /> {open.provider_status && <span className="text-xs text-muted-foreground">({open.provider_status})</span>}</dd>
                {Object.keys((open.charges as Record<string, number>) ?? {}).length > 0 && (
                  <><dt className="text-muted-foreground">Fees reported</dt>
                    <dd>{Object.entries(open.charges as Record<string, number>).map(([k, v]) => `${k.replace('_', ' ')} ${formatMoney(v)}`).join(' · ')}</dd></>
                )}
                <dt className="text-muted-foreground">Tries</dt><dd>{open.attempts}{open.duplicates ? ` · received ${open.duplicates + 1} times` : ''}</dd>
                {(open.error || open.note) && <><dt className="text-muted-foreground">{open.error ? 'Error' : 'Note'}</dt><dd className={open.error ? 'text-red-700' : ''}>{open.error ?? open.note}</dd></>}
              </dl>
              <pre className="max-h-64 overflow-auto rounded-lg bg-muted p-3 text-xs">{JSON.stringify(open.payload, null, 2)}</pre>
              {can('shipments.manage') && (open.result === 'FAILED' || open.result === 'UNMATCHED') && (
                <div className="flex justify-end">
                  <Button onClick={() => retry.mutate(open.id)} disabled={retry.isPending}>{retry.isPending ? <Spinner /> : <RefreshCw />} Try again now</Button>
                </div>
              )}
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

function randomSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

const copy = (text: string, what: string) => navigator.clipboard.writeText(text).then(() => toast.success(`${what} copied`))

/** Webhook URL and secret to paste into the courier's merchant panel. */
export function WebhookSetupDialog({ courier, provider, onClose, onSaved }: {
  courier: CourierRow
  provider: 'pathao' | 'steadfast'
  onClose: () => void
  onSaved: () => void
}) {
  const [secret, setSecret] = useState(randomSecret)
  const hint = (courier.config as { webhook_secret_hint?: string } | null)?.webhook_secret_hint
  const url = `${courierWebhookUrl(courier.id)}&provider=${provider}`
  const save = useMutation({
    mutationFn: () => setCourierWebhookSecret(courier.id, secret.trim()),
    onSuccess: () => { toast.success('Webhook secret saved'); onSaved(); onClose() },
  })
  const name = provider === 'pathao' ? 'Pathao' : 'Steadfast'
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={`${name} webhook`} submitLabel="Save secret" busy={save.isPending}
      disabled={secret.trim().length < 16} onSubmit={() => save.mutate()}
      description={provider === 'pathao'
        ? 'In the Pathao merchant panel → Developers → Webhook, add this callback URL and the same secret. Pathao then sends every status change here and orders update on their own.'
        : 'In the Steadfast portal → API → Webhook, set this callback URL and use the secret as the Bearer token.'}>
      <Field label="Callback URL">
        <div className="flex gap-2">
          <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" variant="outline" size="icon" aria-label="Copy URL" onClick={() => void copy(url, 'URL')}><Copy /></Button>
        </div>
      </Field>
      <Field label={hint ? `New secret (current one ends ${hint.slice(-4)})` : 'Secret'} hint={provider === 'pathao'
        ? 'Sent by Pathao in the X-PATHAO-Signature header. If Pathao gives you a secret instead, paste theirs here.'
        : 'Sent by Steadfast as "Authorization: Bearer …".'}>
        <div className="flex gap-2">
          <Input value={secret} onChange={(e) => setSecret(e.target.value)} className="font-mono text-xs" autoComplete="off" spellCheck={false} />
          <Button type="button" variant="outline" size="icon" aria-label="Copy secret" onClick={() => void copy(secret, 'Secret')}><Copy /></Button>
          <Button type="button" variant="ghost" size="icon" aria-label="New random secret" onClick={() => setSecret(randomSecret())}><KeyRound /></Button>
        </div>
      </Field>
      <p className="text-xs text-muted-foreground">The secret is stored encrypted on the server and never shown again after you save it. Copy it into the courier panel first.</p>
    </FormDialog>
  )
}
