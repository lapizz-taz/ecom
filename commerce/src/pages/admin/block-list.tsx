import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Ban, Plus, Unlock } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatNumber } from '@/lib/format'
import { addBlock, type BlockKind, type BlockRow, liftBlock, listBlocks } from '@/services/order-tools'

const PAGE_SIZE = 25
const KINDS: Record<BlockKind, string> = { PHONE: 'Phone number', IP: 'IP address', ADDRESS: 'Address' }
const STATE_BADGE = { PERMANENT: 'danger', TEMPORARY: 'warning', EXPIRED: 'neutral', LIFTED: 'neutral' } as const
const DURATIONS = [
  { value: 'permanent', label: 'Permanent' },
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
]

/** Phones, IP addresses and addresses that can't place orders online. */
export default function BlockListPage() {
  const { can } = useAuth()
  const manage = can('orders.block')
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ status: 'active', kind: '', q: '', page: '1' })
  const page = Number(state.page) || 1
  const list = useQuery({
    queryKey: ['blocks', state],
    placeholderData: keepPreviousData,
    queryFn: () => listBlocks({ status: state.status, kind: state.kind as BlockKind | '', q: state.q, page, pageSize: PAGE_SIZE }),
  })
  const [adding, setAdding] = useState(false)
  const [lifting, setLifting] = useState<BlockRow | null>(null)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['blocks'] })
  const lift = useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => liftBlock(id, reason), onSuccess: () => { toast.success('Unblocked'); refresh() } })

  const columns: Column<BlockRow>[] = [
    {
      key: 'value', header: 'Blocked', primary: true,
      cell: (b) => (
        <div>
          <p className="font-mono text-sm">{b.value}</p>
          <p className="text-xs text-muted-foreground">{KINDS[b.kind]}{b.customer_name ? ` · ${b.customer_name}` : ''}</p>
        </div>
      ),
    },
    { key: 'reason', header: 'Reason', cell: (b) => <span className="line-clamp-2 max-w-72 text-sm">{b.reason}</span> },
    {
      key: 'state', header: 'Type', cell: (b) => (
        <span>
          <Badge variant={STATE_BADGE[b.state]}>{b.state.toLowerCase()}</Badge>
          {b.expires_at && b.state === 'TEMPORARY' && <span className="block text-xs text-muted-foreground">until {formatDateTime(b.expires_at)}</span>}
        </span>
      ),
    },
    {
      key: 'history', header: 'Order history', hideOnMobile: true,
      cell: (b) => (
        <span className="text-xs tabular-nums">
          {formatNumber(b.orders)} orders · <span className="text-emerald-600">{formatNumber(b.delivered)} delivered</span>
          <br />{formatNumber(b.returned)} returned · {formatNumber(b.cancelled)} cancelled
        </span>
      ),
    },
    {
      key: 'added', header: 'Added', hideOnMobile: true,
      cell: (b) => (
        <span className="text-xs">
          {formatDateTime(b.created_at)}<br /><span className="text-muted-foreground">by {b.created_by_name ?? 'system'}</span>
          {b.source_order_id && <><br /><Link to={`/admin/orders/${b.source_order_id}`} className="text-muted-foreground hover:underline">from {b.source_order_number}</Link></>}
          {b.lifted_at && <><br /><span className="text-muted-foreground">lifted {formatDateTime(b.lifted_at)} by {b.lifted_by_name}</span></>}
        </span>
      ),
    },
    {
      key: 'actions', header: '', align: 'right',
      cell: (b) => manage && b.is_active ? <Button size="sm" variant="outline" onClick={() => setLifting(b)}><Unlock /> Unblock</Button> : null,
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader title="Order Block List"
        description="Phone numbers, IP addresses and addresses that can't order online. Staff can still take an order by hand after speaking to the customer."
        actions={manage && <Button size="sm" onClick={() => setAdding(true)}><Plus /> Block</Button>} />
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={state.status} onValueChange={(v) => update({ status: v, page: '1' })}>
          <TabsList>
            <TabsTrigger value="active">Active</TabsTrigger>
            <TabsTrigger value="expired">Expired</TabsTrigger>
            <TabsTrigger value="lifted">Unblocked</TabsTrigger>
            <TabsTrigger value="all">All</TabsTrigger>
          </TabsList>
        </Tabs>
        <Select value={state.kind || 'all'} onValueChange={(v) => update({ kind: v === 'all' ? '' : v, page: '1' })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Everything</SelectItem>
            {Object.entries(KINDS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}
          </SelectContent>
        </Select>
        <SearchInput value={state.q} onChange={(q) => update({ q, page: '1' })} placeholder="Phone, IP, address or reason" />
      </div>
      <DataTable columns={columns} rows={list.data?.items} rowKey={(b) => b.id} loading={list.isFetching} error={list.error} onRetry={() => list.refetch()}
        empty={<EmptyState icon={<Ban className="size-5" />} title="Nobody is blocked" description="Block a phone number, IP address or address that keeps ordering and refusing parcels." />} />
      <Pagination page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onPage={(p) => update({ page: String(p) })} />
      <AddBlockDialog open={adding} onOpenChange={setAdding} onAdded={refresh} />
      <ConfirmDialog open={!!lifting} onOpenChange={(o) => !o && setLifting(null)} title={`Unblock ${lifting?.value}?`} reason reasonLabel="Why (optional)"
        description="They can order online again straight away." confirmLabel="Unblock"
        onConfirm={(reason) => lift.mutateAsync({ id: lifting!.id, reason }).then(() => setLifting(null))} />
    </div>
  )
}

function AddBlockDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (o: boolean) => void; onAdded: () => void }) {
  const [kind, setKind] = useState<BlockKind>('PHONE')
  const [value, setValue] = useState('')
  const [reason, setReason] = useState('')
  const [duration, setDuration] = useState('permanent')
  const add = useMutation({
    meta: { silent: true },
    mutationFn: () => addBlock({
      kind, value: value.trim(), reason: reason.trim(),
      expiresAt: duration === 'permanent' ? null : new Date(Date.now() + Number(duration) * 86_400_000).toISOString(),
    }),
    onSuccess: () => { toast.success('Blocked'); setValue(''); setReason(''); onAdded(); onOpenChange(false) },
  })
  return (
    <FormDialog open={open} onOpenChange={(o) => { if (!o) add.reset(); onOpenChange(o) }} title="Block from ordering online"
      description="Online orders matching this are refused at checkout with the message set under Settings → Fraud & Advance."
      submitLabel="Block" destructive onSubmit={() => add.mutate()} busy={add.isPending} disabled={!value.trim() || reason.trim().length < 3}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="What to block" htmlFor="bl-kind">
          <Select value={kind} onValueChange={(v) => setKind(v as BlockKind)}>
            <SelectTrigger id="bl-kind" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(KINDS).map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="For how long" htmlFor="bl-duration">
          <Select value={duration} onValueChange={setDuration}>
            <SelectTrigger id="bl-duration" className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{DURATIONS.map((d) => <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
      </div>
      <Field label={KINDS[kind]} htmlFor="bl-value" required
        hint={kind === 'ADDRESS' ? 'Any order whose address contains this text is refused (at least 8 characters).' : kind === 'IP' ? 'Shown on orders placed from the website.' : undefined}>
        <Input id="bl-value" className="font-mono" value={value} onChange={(e) => setValue(e.target.value)}
          placeholder={kind === 'PHONE' ? '01XXXXXXXXX' : kind === 'IP' ? '203.0.113.9' : 'House 12, Road 7, …'} />
      </Field>
      <Field label="Reason" htmlFor="bl-reason" required>
        <Textarea id="bl-reason" rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Refused 3 parcels in September" />
      </Field>
      {add.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{(add.error as Error).message.replace(/^[A-Z_]+: /, '')}</p>}
    </FormDialog>
  )
}
