import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, Download, Filter, Layers, Plus, Printer, Truck } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Can } from '@/components/common/permission-gate'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { formatDateTime, timeAgo } from '@/lib/format'
import { ORDER_STATUS, ORDER_STATUS_FILTERS, PAYMENT_METHOD, PAYMENT_STATUS, RISK_LEVEL } from '@/lib/status'
import { cn } from '@/lib/utils'
import { bookShipments, listCouriers } from '@/services/couriers'
import { bulkTransition, exportOrders, fulfillmentSummary, type OrderFilters, searchOrders, statusCounts } from '@/services/orders'
import { Spinner } from '@/components/common/states'
import { FulfillmentBar } from '@/features/orders/fulfillment-bar'
import type { OrderListItem, OrderStatus } from '@/types/domain'

const PAGE_SIZE = 25
const BULK_TARGETS: OrderStatus[] = ['CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELLED']

export default function OrdersPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [bookOpen, setBookOpen] = useState(false)
  const [state, update] = useUrlState({
    tab: 'all', q: '', payment_status: '', risk_level: '', source: '', district: '', date_from: '', date_to: '', sort: 'created_at', dir: 'desc', page: '1',
  })
  const page = Number(state.page) || 1
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkTarget, setBulkTarget] = useState<OrderStatus | null>(null)
  const [exporting, setExporting] = useState(false)

  const tab = ORDER_STATUS_FILTERS.find((t) => t.key === state.tab) ?? ORDER_STATUS_FILTERS[0]
  const filters: OrderFilters = useMemo(() => ({
    q: state.q || undefined,
    statuses: tab.statuses,
    ...tab.extra,
    payment_status: state.payment_status || undefined,
    risk_level: state.risk_level || undefined,
    source: state.source || undefined,
    district: state.district || undefined,
    date_from: state.date_from || undefined,
    date_to: state.date_to || undefined,
  }), [state, tab])

  const orders = useQuery({
    queryKey: ['orders', 'list', filters, state.sort, state.dir, page],
    placeholderData: keepPreviousData,
    queryFn: () => searchOrders(filters, state.sort, state.dir as 'asc' | 'desc', PAGE_SIZE, (page - 1) * PAGE_SIZE),
  })
  const counts = useQuery({ queryKey: ['orders', 'counts'], queryFn: statusCounts, staleTime: 15_000 })
  const summary = useQuery({ queryKey: ['fulfillment-summary'], queryFn: fulfillmentSummary, staleTime: 15_000, refetchInterval: 60_000 })

  const bulk = useMutation({
    mutationFn: ({ to, note }: { to: OrderStatus; note: string }) => bulkTransition([...selected], to, note),
    onSuccess: (result) => {
      if (result.updated) toast.success(`${result.updated} order(s) updated`)
      for (const f of result.failed.slice(0, 3)) toast.error(`${f.order_number}: ${f.error.replace(/^[A-Z_]+: /, '')}`)
      setSelected(new Set())
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
    },
  })

  const exportCsv = async () => {
    setExporting(true)
    try {
      const rows = selected.size ? (orders.data?.items ?? []).filter((o) => selected.has(o.id)) : await exportOrders(filters)
      downloadCsv(`orders-${new Date().toISOString().slice(0, 10)}`, rows, [
        { header: 'Order', value: (o) => o.order_number },
        { header: 'Date', value: (o) => formatDateTime(o.created_at) },
        { header: 'Status', value: (o) => ORDER_STATUS[o.status].label },
        { header: 'Customer', value: (o) => o.customer_name },
        { header: 'Phone', value: (o) => o.customer_phone },
        { header: 'District', value: (o) => o.shipping_district },
        { header: 'Items', value: (o) => o.item_count },
        { header: 'Total', value: (o) => o.total_amount },
        { header: 'Paid', value: (o) => o.amount_paid },
        { header: 'COD due', value: (o) => o.cod_amount },
        { header: 'Payment method', value: (o) => PAYMENT_METHOD[o.payment_method] },
        { header: 'Payment status', value: (o) => PAYMENT_STATUS[o.payment_status].label },
        { header: 'Risk', value: (o) => o.risk_level ?? '' },
        { header: 'Courier', value: (o) => o.courier_name ?? '' },
        { header: 'Tracking', value: (o) => o.tracking_number ?? '' },
        { header: 'Source', value: (o) => o.source },
      ])
    } finally {
      setExporting(false)
    }
  }

  const tabCount = (t: (typeof ORDER_STATUS_FILTERS)[number]) => {
    if (t.key === 'to_print') return summary.data?.to_print ?? 0
    if (t.key === 'duplicates') return summary.data?.duplicates ?? 0
    return t.statuses.length ? t.statuses.reduce((s, st) => s + (counts.data?.[st] ?? 0), 0) : Object.values(counts.data ?? {}).reduce((a, b) => a + b, 0)
  }
  const activeFilters = ['payment_status', 'risk_level', 'source', 'district', 'date_from', 'date_to'].filter((k) => state[k as keyof typeof state]).length

  const columns: Column<OrderListItem>[] = [
    {
      key: 'order', header: 'Order', primary: true,
      cell: (o) => (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium">{o.order_number}</span>
          {o.source === 'ADMIN' && <Badge variant="outline" className="text-[10px]">Manual</Badge>}
          {o.label_printed_at && (
            <Badge variant="success" className="gap-0.5 text-[10px]" title={`Label printed ${formatDateTime(o.label_printed_at)}${o.label_print_count > 1 ? ` · ${o.label_print_count}×` : ''}`}>
              <Check className="size-3" /> Printed{o.label_print_count > 1 ? ` ${o.label_print_count}×` : ''}
            </Badge>
          )}
          {o.duplicate_status === 'SUSPECTED' && (
            <Badge variant="warning" className="gap-0.5 text-[10px]" title={`Possible duplicate of ${o.duplicate_of_number ?? 'another order'}`}><Copy className="size-3" /> Duplicate?</Badge>
          )}
          {o.merged_count > 0 && <Badge variant="info" className="gap-0.5 text-[10px]" title="Includes merged checkouts"><Layers className="size-3" /> +{o.merged_count} merged</Badge>}
          {o.merged_into_number && <Badge variant="neutral" className="text-[10px]">Merged into {o.merged_into_number}</Badge>}
        </div>
      ),
    },
    { key: 'date', header: 'Date', cell: (o) => <span title={formatDateTime(o.created_at)} className="text-muted-foreground">{timeAgo(o.created_at)}</span> },
    {
      key: 'customer', header: 'Customer',
      cell: (o) => <div className="max-w-48"><p className="truncate">{o.customer_name}</p><p className="text-xs text-muted-foreground">{o.customer_phone} · {o.shipping_district}</p></div>,
    },
    { key: 'status', header: 'Status', cell: (o) => <StatusBadge value={o.status} map={ORDER_STATUS} /> },
    { key: 'payment', header: 'Payment', cell: (o) => <StatusBadge value={o.payment_status} map={PAYMENT_STATUS} /> },
    { key: 'risk', header: 'Risk', cell: (o) => <StatusBadge value={o.risk_level} map={RISK_LEVEL} />, hideOnMobile: true },
    { key: 'courier', header: 'Courier', hideOnMobile: true, cell: (o) => o.courier_name ? <span className="text-xs">{o.courier_name}<br /><span className="text-muted-foreground">{o.tracking_number}</span></span> : <span className="text-muted-foreground">—</span> },
    {
      key: 'total', header: 'Total', align: 'right',
      cell: (o) => (
        <div>
          <Money value={o.total_amount} className="font-medium" />
          {Number(o.advance_required) > Number(o.amount_paid) && <p className="text-xs text-amber-600">Advance due</p>}
        </div>
      ),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Orders"
        actions={
          <>
            <Can permission="orders.export">
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting}><Download /> {selected.size ? `Export ${selected.size}` : 'Export'}</Button>
            </Can>
            <Can permission="orders.create"><Button size="sm" asChild><Link to="/admin/orders/new"><Plus /> New order</Link></Button></Can>
          </>
        }
      />

      <FulfillmentBar summary={summary.data} active={state.tab} onSelect={(tab) => { setSelected(new Set()); update({ tab }) }} />

      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {ORDER_STATUS_FILTERS.filter((t) => !t.hidden || state.tab === t.key).map((t) => (
          <button key={t.key} type="button" onClick={() => { setSelected(new Set()); update({ tab: t.key }) }}
            className={cn('flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm', state.tab === t.key ? 'bg-foreground text-background' : 'hover:bg-card')}>
            {t.label}
            {counts.data && <span className={cn('text-xs tabular-nums', state.tab === t.key ? 'opacity-70' : 'text-muted-foreground')}>{tabCount(t)}</span>}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Order #, phone, name, tracking, SKU, address" className="sm:w-96" />
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm"><Filter /> Filters{activeFilters > 0 && <Badge variant="secondary">{activeFilters}</Badge>}</Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="grid w-80 gap-3">
            <FilterSelect label="Payment" value={state.payment_status} onChange={(v) => update({ payment_status: v })}
              options={Object.entries(PAYMENT_STATUS).map(([k, v]) => ({ value: k, label: v.label }))} />
            <FilterSelect label="Risk level" value={state.risk_level} onChange={(v) => update({ risk_level: v })}
              options={Object.entries(RISK_LEVEL).map(([k, v]) => ({ value: k, label: v.label }))} />
            <FilterSelect label="Source" value={state.source} onChange={(v) => update({ source: v })}
              options={[{ value: 'STOREFRONT', label: 'Storefront' }, { value: 'ADMIN', label: 'Manual' }]} />
            <div className="grid gap-1"><span className="text-xs text-muted-foreground">District</span>
              <Input className="h-8" defaultValue={state.district} onBlur={(e) => update({ district: e.target.value.trim() })} placeholder="e.g. Dhaka" />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="grid gap-1"><span className="text-xs text-muted-foreground">From</span><Input type="date" className="h-8" value={state.date_from} onChange={(e) => update({ date_from: e.target.value })} /></div>
              <div className="grid gap-1"><span className="text-xs text-muted-foreground">To</span><Input type="date" className="h-8" value={state.date_to} onChange={(e) => update({ date_to: e.target.value })} /></div>
            </div>
            <Button variant="ghost" size="sm" onClick={() => update({ payment_status: '', risk_level: '', source: '', district: '', date_from: '', date_to: '' })}>Clear filters</Button>
          </PopoverContent>
        </Popover>
        <Select value={`${state.sort}:${state.dir}`} onValueChange={(v) => { const [sort, dir] = v.split(':'); update({ sort, dir }) }}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="created_at:desc">Newest first</SelectItem>
            <SelectItem value="created_at:asc">Oldest first</SelectItem>
            <SelectItem value="total_amount:desc">Highest value</SelectItem>
            <SelectItem value="total_amount:asc">Lowest value</SelectItem>
            <SelectItem value="status:asc">Status</SelectItem>
          </SelectContent>
        </Select>
        {selected.size > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 shadow-xs">
            <span className="text-sm font-medium">{selected.size} selected</span>
            {can('orders.fulfill') && (
              <Button size="sm" variant="outline" className="rounded-full" onClick={() => navigate(`/admin/labels?ids=${[...selected].join(',')}`)}><Printer /> Print labels</Button>
            )}
            {can('shipments.manage') && (
              <Button size="sm" variant="outline" className="rounded-full" onClick={() => setBookOpen(true)}><Truck /> Book courier</Button>
            )}
            {can('orders.status') && (
              <Select value="" onValueChange={(v) => setBulkTarget(v as OrderStatus)}>
                <SelectTrigger size="sm" className="w-40 rounded-full"><SelectValue placeholder="Change status…" /></SelectTrigger>
                <SelectContent>{BULK_TARGETS.filter((s) => s !== 'CANCELLED' || can('orders.cancel')).map((s) => <SelectItem key={s} value={s}>{ORDER_STATUS[s].label}</SelectItem>)}</SelectContent>
              </Select>
            )}
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={orders.data?.items}
        rowKey={(o) => o.id}
        loading={orders.isFetching}
        error={orders.error}
        onRetry={() => orders.refetch()}
        rowHref={(o) => `/admin/orders/${o.id}`}
        selected={can('orders.status') || can('orders.export') || can('orders.fulfill') ? selected : undefined}
        onSelectedChange={setSelected}
        empty={<EmptyState title="No orders match" description={state.q ? 'Try a different search.' : 'Orders will appear here as they come in.'} />}
        footer={<Pagination page={page} pageSize={PAGE_SIZE} total={orders.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />}
      />

      <ConfirmDialog
        open={bulkTarget !== null}
        onOpenChange={(o) => !o && setBulkTarget(null)}
        title={`Move ${selected.size} order(s) to ${bulkTarget ? ORDER_STATUS[bulkTarget].label : ''}?`}
        description="Each order is checked individually; orders that cannot move to this status are skipped and reported."
        reason
        reasonRequired={bulkTarget === 'CANCELLED'}
        reasonLabel={bulkTarget === 'CANCELLED' ? 'Cancellation reason' : 'Note (optional)'}
        destructive={bulkTarget === 'CANCELLED'}
        confirmLabel="Update orders"
        onConfirm={(note) => bulk.mutateAsync({ to: bulkTarget!, note })}
      />

      <BookCourierDialog open={bookOpen} onOpenChange={setBookOpen} orderIds={[...selected]}
        orderNumber={(id) => orders.data?.items.find((o) => o.id === id)?.order_number ?? id.slice(0, 8)}
        onDone={() => { setSelected(new Set()); void queryClient.invalidateQueries({ queryKey: ['orders'] }) }} />
    </div>
  )
}

/** Books the selected orders with a connected courier's API in one go. */
function BookCourierDialog({ open, onOpenChange, orderIds, orderNumber, onDone }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  orderIds: string[]
  orderNumber: (id: string) => string
  onDone: () => void
}) {
  const couriers = useQuery({ queryKey: ['couriers', 'active'], queryFn: () => listCouriers(true), enabled: open })
  const connected = (couriers.data ?? []).filter((c) => c.api_enabled)
  const [courierId, setCourierId] = useState('')
  const book = useMutation({
    mutationFn: () => bookShipments(orderIds, courierId || connected[0]?.id),
    onSuccess: (r) => {
      if (r.booked) toast.success(`${r.booked} parcel(s) booked`)
      for (const f of r.results.filter((x) => !x.ok).slice(0, 4)) toast.error(`${orderNumber(f.order_id)}: ${f.error}`)
      onDone()
      onOpenChange(false)
    },
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Book {orderIds.length} parcel{orderIds.length === 1 ? '' : 's'} with a courier</DialogTitle>
          <DialogDescription>Each order is sent to the courier's API; the tracking number is saved and printed on the label. Orders already booked are skipped.</DialogDescription>
        </DialogHeader>
        {couriers.isLoading ? <Spinner /> : connected.length === 0 ? (
          <p className="text-sm text-muted-foreground">No courier is connected yet. <Link to="/admin/couriers" className="underline">Connect Steadfast, Pathao or RedX</Link> first.</p>
        ) : (
          <Select value={courierId || connected[0].id} onValueChange={setCourierId}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{connected.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
          </Select>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => book.mutate()} disabled={!connected.length || book.isPending}>{book.isPending ? <Spinner /> : <Truck />} Book parcels</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ value: string; label: string }> }) {
  return (
    <div className="grid gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Select value={value || 'all'} onValueChange={(v) => onChange(v === 'all' ? '' : v)}>
        <SelectTrigger size="sm"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All</SelectItem>
          {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}
