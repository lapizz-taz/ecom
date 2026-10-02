import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Filter, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { formatDateTime, timeAgo } from '@/lib/format'
import { ORDER_STATUS, ORDER_STATUS_FILTERS, PAYMENT_METHOD, PAYMENT_STATUS, RISK_LEVEL } from '@/lib/status'
import { cn } from '@/lib/utils'
import { bulkTransition, exportOrders, type OrderFilters, searchOrders, statusCounts } from '@/services/orders'
import type { OrderListItem, OrderStatus } from '@/types/domain'

const PAGE_SIZE = 25
const BULK_TARGETS: OrderStatus[] = ['CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED', 'CANCELLED']

export default function OrdersPage() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
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

  const tabCount = (statuses: OrderStatus[]) =>
    statuses.length ? statuses.reduce((s, st) => s + (counts.data?.[st] ?? 0), 0) : Object.values(counts.data ?? {}).reduce((a, b) => a + b, 0)
  const activeFilters = ['payment_status', 'risk_level', 'source', 'district', 'date_from', 'date_to'].filter((k) => state[k as keyof typeof state]).length

  const columns: Column<OrderListItem>[] = [
    {
      key: 'order', header: 'Order', primary: true,
      cell: (o) => (
        <div className="flex items-center gap-2">
          <span className="font-medium">{o.order_number}</span>
          {o.source === 'ADMIN' && <Badge variant="outline" className="text-[10px]">Manual</Badge>}
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

      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
        {ORDER_STATUS_FILTERS.map((t) => (
          <button key={t.key} type="button" onClick={() => { setSelected(new Set()); update({ tab: t.key }) }}
            className={cn('flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm', state.tab === t.key ? 'bg-foreground text-background' : 'hover:bg-muted')}>
            {t.label}
            {counts.data && <span className={cn('text-xs tabular-nums', state.tab === t.key ? 'opacity-70' : 'text-muted-foreground')}>{tabCount(t.statuses)}</span>}
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
        {selected.size > 0 && can('orders.status') && (
          <div className="flex items-center gap-2 rounded-md border bg-card px-2 py-1">
            <span className="text-sm">{selected.size} selected</span>
            <Select value="" onValueChange={(v) => setBulkTarget(v as OrderStatus)}>
              <SelectTrigger size="sm" className="w-40"><SelectValue placeholder="Change status…" /></SelectTrigger>
              <SelectContent>{BULK_TARGETS.filter((s) => s !== 'CANCELLED' || can('orders.cancel')).map((s) => <SelectItem key={s} value={s}>{ORDER_STATUS[s].label}</SelectItem>)}</SelectContent>
            </Select>
            <Button variant="ghost" size="sm" onClick={() => setSelected(new Set())}>Clear</Button>
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
        selected={can('orders.status') || can('orders.export') ? selected : undefined}
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
    </div>
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
