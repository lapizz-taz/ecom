import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plug, Plus, RefreshCw, Wallet } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatDateTime, formatMoney } from '@/lib/format'
import { SHIPMENT_STATUS } from '@/lib/status'
import {
  codReceivable, type CourierRow, listCouriers, listShipments, saveCourier, settleCod, type ShipmentRow, syncAllShipments, syncShipment,
  testCourierConnection,
} from '@/services/couriers'
import type { CodReceivableItem } from '@/types/domain'

const PROVIDERS = [
  { value: 'manual', label: 'Manual (no API)' },
  { value: 'steadfast', label: 'Steadfast (API)' },
]

export default function CouriersPage() {
  const [state, update] = useUrlState({ tab: 'shipments' })
  return (
    <div className="space-y-4">
      <PageHeader title="Couriers" description="Courier accounts, parcels in transit and cash on delivery still held by couriers." />
      <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
        <TabsList>
          <TabsTrigger value="shipments">Shipments</TabsTrigger>
          <TabsTrigger value="cod">COD receivable</TabsTrigger>
          <TabsTrigger value="couriers">Couriers</TabsTrigger>
        </TabsList>
        <TabsContent value="shipments"><Shipments /></TabsContent>
        <TabsContent value="cod"><CodReceivable /></TabsContent>
        <TabsContent value="couriers"><CourierList /></TabsContent>
      </Tabs>
    </div>
  )
}

function Shipments() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'shipments', courier: '', status: '', q: '', page: '1' })
  const page = Number(state.page) || 1
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const shipments = useQuery({
    queryKey: ['shipments', state],
    placeholderData: keepPreviousData,
    queryFn: () => listShipments({ courierId: state.courier || undefined, status: state.status as never, q: state.q, page, pageSize: 25 }),
  })
  const sync = useMutation({
    mutationFn: async (id?: string) => { if (id) await syncShipment(id); else await syncAllShipments(state.courier || undefined) },
    onSuccess: () => { toast.success('Synced with courier'); void queryClient.invalidateQueries({ queryKey: ['shipments'] }) },
  })
  const columns: Column<ShipmentRow>[] = [
    { key: 'order', header: 'Order', primary: true, cell: (s) => <Link to={`/admin/orders/${s.orders?.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{s.orders?.order_number}</Link> },
    { key: 'customer', header: 'Customer', cell: (s) => s.orders?.customer_name },
    { key: 'courier', header: 'Courier', cell: (s) => <span>{s.couriers?.name}<span className="block font-mono text-xs text-muted-foreground">{s.tracking_number ?? '—'}</span></span> },
    { key: 'status', header: 'Status', cell: (s) => <StatusBadge value={s.status} map={SHIPMENT_STATUS} /> },
    { key: 'cod', header: 'COD', align: 'right', cell: (s) => <Money value={s.cod_amount} /> },
    { key: 'cost', header: 'Charge', align: 'right', hideOnMobile: true, cell: (s) => <Money value={s.shipping_cost} muted /> },
    { key: 'date', header: 'Booked', hideOnMobile: true, cell: (s) => formatDate(s.created_at) },
    {
      key: 'sync', header: '', align: 'right',
      cell: (s) => s.couriers?.provider !== 'manual' && can('shipments.manage') ? (
        <Button size="icon-sm" variant="ghost" aria-label="Sync status" onClick={(e) => { e.stopPropagation(); sync.mutate(s.id) }}><RefreshCw /></Button>
      ) : null,
    },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Tracking number" />
        <Select value={state.courier || 'all'} onValueChange={(v) => update({ courier: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All couriers</SelectItem>{(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={state.status || 'all'} onValueChange={(v) => update({ status: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All statuses</SelectItem>{Object.entries(SHIPMENT_STATUS).map(([k, v]) => <SelectItem key={k} value={k}>{v.label}</SelectItem>)}</SelectContent>
        </Select>
        {can('shipments.manage') && <Button size="sm" variant="outline" className="ml-auto" onClick={() => sync.mutate(undefined)} disabled={sync.isPending}>{sync.isPending ? <Spinner /> : <RefreshCw />} Sync API couriers</Button>}
      </div>
      <DataTable columns={columns} rows={shipments.data?.items} rowKey={(s) => s.id} loading={shipments.isFetching} error={shipments.error}
        onRetry={() => shipments.refetch()} rowHref={(s) => `/admin/orders/${s.order_id}`} empty={<EmptyState title="No shipments" />}
        footer={<Pagination page={page} pageSize={25} total={shipments.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />
    </div>
  )
}

function CodReceivable() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [courierId, setCourierId] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const items = useQuery({ queryKey: ['cod-receivable', courierId], queryFn: () => codReceivable(courierId || undefined) })
  const total = (items.data ?? []).reduce((s, i) => s + Number(i.due), 0)
  const selectedTotal = (items.data ?? []).filter((i) => selected.has(i.shipment_id)).reduce((s, i) => s + Number(i.due), 0)
  const settle = useMutation({
    mutationFn: (reference: string) => settleCod([...selected], reference),
    onSuccess: (r) => {
      toast.success(`${r.settled} parcel(s) settled · ${formatMoney(r.amount)}`)
      setSelected(new Set())
      void queryClient.invalidateQueries({ queryKey: ['cod-receivable'] })
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
  })
  const columns: Column<CodReceivableItem>[] = [
    { key: 'order', header: 'Order', primary: true, cell: (i) => <Link to={`/admin/orders/${i.order_id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{i.order_number}</Link> },
    { key: 'customer', header: 'Customer', cell: (i) => i.customer_name },
    { key: 'courier', header: 'Courier', cell: (i) => <span>{i.courier_name}<span className="block font-mono text-xs text-muted-foreground">{i.tracking_number}</span></span> },
    { key: 'delivered', header: 'Delivered', cell: (i) => formatDateTime(i.delivered_at) },
    { key: 'due', header: 'COD due', align: 'right', cell: (i) => <Money value={i.due} className="font-medium" /> },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={courierId || 'all'} onValueChange={(v) => { setCourierId(v === 'all' ? '' : v); setSelected(new Set()) }}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="all">All couriers</SelectItem>{(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
        </Select>
        <span className="text-sm text-muted-foreground">Outstanding: <strong className="text-foreground">{formatMoney(total)}</strong></span>
        {selected.size > 0 && can('payments.record') && (
          <Button size="sm" className="ml-auto" onClick={() => setConfirming(true)}><Wallet /> Mark {selected.size} paid out ({formatMoney(selectedTotal)})</Button>
        )}
      </div>
      <DataTable columns={columns} rows={items.data} rowKey={(i) => i.shipment_id} loading={items.isLoading} error={items.error}
        selected={can('payments.record') ? selected : undefined} onSelectedChange={setSelected}
        empty={<EmptyState title="Nothing outstanding" description="Delivered parcels whose cash hasn't been paid out by the courier appear here." />} />
      <ConfirmDialog open={confirming} onOpenChange={setConfirming} title="Record courier payout"
        description={`Records ${formatMoney(selectedTotal)} of COD as received for ${selected.size} order(s).`} reason reasonLabel="Payout reference (optional)"
        confirmLabel="Record payout" onConfirm={(ref) => settle.mutateAsync(ref)} />
    </div>
  )
}

function CourierList() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const [editing, setEditing] = useState<Partial<CourierRow> | null>(null)
  const save = useMutation({
    mutationFn: () => saveCourier({
      id: editing?.id, name: editing?.name ?? '', provider: editing?.provider ?? 'manual', api_enabled: editing?.api_enabled ?? false,
      tracking_url_template: editing?.tracking_url_template || null, phone: editing?.phone || null, notes: editing?.notes || null,
      default_shipping_cost: editing?.default_shipping_cost ?? null, is_active: editing?.is_active ?? true,
    }),
    onSuccess: () => { toast.success('Courier saved'); setEditing(null); void queryClient.invalidateQueries({ queryKey: ['couriers'] }) },
  })
  const test = useMutation({
    mutationFn: testCourierConnection,
    onSuccess: (r) => { (r.ok ? toast.success : toast.error)(r.message); void queryClient.invalidateQueries({ queryKey: ['couriers'] }) },
  })
  return (
    <Card>
      <CardContent className="space-y-3">
        {can('couriers.manage') && <Button size="sm" onClick={() => setEditing({ provider: 'manual', is_active: true })}><Plus /> Add courier</Button>}
        <ul className="divide-y">
          {(couriers.data ?? []).map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div>
                <p className="flex items-center gap-2 font-medium">{c.name}
                  {!c.is_active && <Badge variant="neutral">inactive</Badge>}
                  {c.api_enabled && <Badge variant={c.api_status === 'CONNECTED' ? 'success' : c.api_status === 'ERROR' ? 'danger' : 'neutral'}>API {c.api_status.toLowerCase().replace('_', ' ')}</Badge>}
                </p>
                <p className="text-xs text-muted-foreground">{PROVIDERS.find((p) => p.value === c.provider)?.label ?? c.provider}{c.phone ? ` · ${c.phone}` : ''}{c.default_shipping_cost != null ? ` · default charge ${formatMoney(c.default_shipping_cost)}` : ''}</p>
              </div>
              {can('couriers.manage') && (
                <div className="flex gap-1">
                  {c.api_enabled && <Button size="sm" variant="outline" onClick={() => test.mutate(c.id)} disabled={test.isPending}><Plug /> Test API</Button>}
                  <Button size="icon-sm" variant="ghost" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}><Pencil /></Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
      <Dialog open={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.id ? 'Edit courier' : 'New courier'}</DialogTitle>
            <DialogDescription>API keys are never stored here — set them as edge function secrets (e.g. STEADFAST_API_KEY).</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="cr-name" required><Input id="cr-name" value={editing?.name ?? ''} onChange={(e) => setEditing((c) => ({ ...c, name: e.target.value }))} /></Field>
            <Field label="Integration">
              <Select value={editing?.provider ?? 'manual'} onValueChange={(v) => setEditing((c) => ({ ...c, provider: v, api_enabled: v !== 'manual' && (c?.api_enabled ?? false) }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{PROVIDERS.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Tracking URL" htmlFor="cr-url" hint="Use {tracking} as placeholder" className="sm:col-span-2">
              <Input id="cr-url" value={editing?.tracking_url_template ?? ''} onChange={(e) => setEditing((c) => ({ ...c, tracking_url_template: e.target.value }))} placeholder="https://courier.example/track/{tracking}" />
            </Field>
            <Field label="Phone" htmlFor="cr-phone"><Input id="cr-phone" value={editing?.phone ?? ''} onChange={(e) => setEditing((c) => ({ ...c, phone: e.target.value }))} /></Field>
            <Field label="Default charge" htmlFor="cr-cost"><Input id="cr-cost" type="number" min={0} value={editing?.default_shipping_cost ?? ''} onChange={(e) => setEditing((c) => ({ ...c, default_shipping_cost: e.target.value === '' ? null : Number(e.target.value) }))} /></Field>
            <Field label="Notes" htmlFor="cr-notes" className="sm:col-span-2"><Textarea id="cr-notes" rows={2} value={editing?.notes ?? ''} onChange={(e) => setEditing((c) => ({ ...c, notes: e.target.value }))} /></Field>
            {editing?.provider !== 'manual' && <label className="flex items-center gap-2 text-sm"><Switch checked={editing?.api_enabled ?? false} onCheckedChange={(v) => setEditing((c) => ({ ...c, api_enabled: v }))} /> Use API</label>}
            <label className="flex items-center gap-2 text-sm"><Switch checked={editing?.is_active ?? true} onCheckedChange={(v) => setEditing((c) => ({ ...c, is_active: v }))} /> Active</label>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            <Button onClick={() => save.mutate()} disabled={!editing?.name || save.isPending}>{save.isPending && <Spinner />} Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  )
}
