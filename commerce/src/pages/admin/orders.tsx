import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlarmClock, Check, CheckCheck, ChevronDown, Copy, Download, ExternalLink, Layers, MessageCircle, PackageCheck, Pencil, Phone, Plus, Printer, ShieldAlert,
  ShoppingBag, Tag, Truck, Wallet,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Can } from '@/components/common/permission-gate'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { SuccessRateButton } from '@/features/orders/success-panel'
import { BookCourierDialog } from '@/features/orders/book-courier-dialog'
import { EMPTY_FILTERS, type FilterValues, filtersFromValues, OrderFilterButton } from '@/features/orders/order-filter-panel'
import { paidBadge } from '@/features/orders/order-source-card'
import { waNumber } from '@/features/storefront/whatsapp-confirm'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { formatDateTime, timeAgo, titleCase } from '@/lib/format'
import {
  NEEDS_REASON, ORDER_STAGES, ORDER_STATUS, type OrderStage, PAYMENT_METHOD, PAYMENT_STATUS, RISK_LEVEL, STAGE,
} from '@/lib/status'
import { cn } from '@/lib/utils'
import {
  approveOrders, bulkTransition, exportOrders, fulfillmentSummary, listCheckoutLeads, listReviewStatuses, type OrderFilters, orderFilterOptions,
  queueCounts, searchOrders, setOrderTags, setWebOrderStatus, updateCheckoutLead,
} from '@/services/orders'
import type { CheckoutLead, OrderListItem, OrderStatus, ReviewStatus } from '@/types/domain'

type View = 'all' | 'web' | 'approved'
const PAGE_SIZE = 25
const CLOSED: OrderStatus[] = ['CANCELLED', 'REJECTED_FRAUD']
const ALL_MOVES: Array<{ to: OrderStatus; label: string }> = [
  { to: 'READY_TO_SHIP', label: 'RTS' }, { to: 'SHIPPED', label: 'Shipped' }, { to: 'DELIVERED', label: 'Delivered' },
  { to: 'RETURNING', label: 'Return pending' }, { to: 'RETURNED', label: 'Returned' }, { to: 'LOST', label: 'Lost' },
  { to: 'PENDING_CANCEL', label: 'Pending cancel' }, { to: 'CANCELLED', label: 'Cancelled' },
]

const VIEW_META: Record<View, { title: string; description: string }> = {
  web: { title: 'Web orders', description: 'Call the customer, record what happened, then approve.' },
  approved: { title: 'Approved orders', description: 'From packing to delivery or return.' },
  all: { title: 'All orders', description: 'Search every order, approved or not.' },
}

function reportBatch(done: number, failed: Array<{ order_number: string; error: string }>, verb: string) {
  if (done) toast.success(`${done} order${done === 1 ? '' : 's'} ${verb}`)
  for (const f of failed.slice(0, 3)) toast.error(`${f.order_number}: ${f.error.replace(/^[A-Z_]+: /, '')}`)
  if (failed.length > 3) toast.error(`${failed.length - 3} more could not be ${verb}`)
}

export function OrdersPage({ view }: { view: View }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [state, update] = useUrlState({
    ...EMPTY_FILTERS,
    tab: view === 'web' ? 'PROCESSING' : view === 'approved' ? 'PENDING' : 'all', q: '', sort: 'created_at', dir: 'desc', page: '1', print: '', due: '', dupes: '', advance: '',
  })
  const filterValues = useMemo(() => Object.fromEntries(Object.keys(EMPTY_FILTERS).map((k) => [k, state[k as keyof FilterValues]])) as FilterValues, [state])
  const page = Number(state.page) || 1
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkTarget, setBulkTarget] = useState<OrderStatus | null>(null)
  const [approveIds, setApproveIds] = useState<string[] | null>(null)
  const [callDialog, setCallDialog] = useState<{ ids: string[]; code: string } | null>(null)
  const [bookOpen, setBookOpen] = useState(false)
  const [exporting, setExporting] = useState(false)

  const reviewStatuses = useQuery({ queryKey: ['review-statuses'], queryFn: () => listReviewStatuses(), staleTime: 60_000, enabled: view !== 'approved' })
  const counts = useQuery({ queryKey: ['orders', 'queue-counts'], queryFn: queueCounts, staleTime: 15_000, enabled: view !== 'all' })
  const summary = useQuery({ queryKey: ['fulfillment-summary'], queryFn: fulfillmentSummary, staleTime: 15_000, refetchInterval: 60_000, enabled: view === 'approved' })
  const statusMeta = useMemo(() => new Map((reviewStatuses.data ?? []).map((s) => [s.code, s])), [reviewStatuses.data])

  const tabs = useMemo(() => {
    if (view === 'web') {
      const all = reviewStatuses.data ?? []
      const web = counts.data?.web ?? {}
      return [
        ...all.filter((s) => !s.closes_order).map((s) => ({ key: s.code, label: s.label, count: web[s.code] ?? 0, hint: s.description })),
        { key: 'incomplete', label: 'Incomplete', count: counts.data?.incomplete ?? 0, hint: 'Typed a phone at checkout but did not order' },
        ...all.filter((s) => s.closes_order).map((s) => ({ key: s.code, label: s.label, count: web[s.code] ?? 0, hint: s.description })),
        { key: 'all', label: 'All', count: Object.values(web).reduce((a, b) => a + b, 0), hint: null },
      ]
    }
    if (view === 'approved') {
      const approved = counts.data?.approved ?? {}
      return [
        ...ORDER_STAGES.map((s) => ({ key: s.key, label: s.label, count: approved[s.key] ?? 0, hint: s.hint })),
        { key: 'all', label: 'All', count: Object.values(approved).reduce((a, b) => a + (b ?? 0), 0), hint: null },
      ]
    }
    return []
  }, [view, reviewStatuses.data, counts.data])

  const followUpTab = view === 'web' && statusMeta.get(state.tab)?.needs_follow_up
  const sort = followUpTab && state.sort === 'created_at' ? 'follow_up_at' : state.sort
  const dir = followUpTab && state.sort === 'created_at' ? 'asc' : state.dir
  const baseFilters = useMemo((): OrderFilters => ({
    q: state.q || undefined,
    queue: view === 'all' ? undefined : view,
    review_status: view === 'web' && !['all', 'incomplete'].includes(state.tab) ? state.tab : undefined,
    stage: view === 'approved' && state.tab !== 'all' ? state.tab : undefined,
    follow_up_due: state.due === '1' || undefined,
    duplicates: state.dupes === '1' || undefined,
    statuses: state.print === '1' ? ['CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP'] : state.advance === '1' ? ['ADVANCE_REQUIRED'] : undefined,
  }), [state.q, state.tab, state.due, state.dupes, state.print, state.advance, view])
  const withValues = (values: FilterValues): OrderFilters => {
    const f = { ...baseFilters, ...filtersFromValues(values) }
    if (state.print === '1') f.label = 'not_printed'
    return f
  }
  const filters = useMemo(() => withValues(filterValues), [baseFilters, filterValues]) // eslint-disable-line react-hooks/exhaustive-deps

  const showLeads = view === 'web' && state.tab === 'incomplete'
  const orders = useQuery({
    queryKey: ['orders', 'list', view, filters, sort, dir, page],
    placeholderData: keepPreviousData,
    enabled: !showLeads,
    queryFn: () => searchOrders(filters, sort, dir as 'asc' | 'desc', PAGE_SIZE, (page - 1) * PAGE_SIZE),
  })

  const refresh = () => {
    setSelected(new Set())
    void queryClient.invalidateQueries({ queryKey: ['orders'] })
    void queryClient.invalidateQueries({ queryKey: ['fulfillment-summary'] })
  }
  const tagOptions = useQuery({ queryKey: ['order-filter-options'], queryFn: orderFilterOptions, staleTime: 60_000, enabled: can('orders.update') })
  const tagOrders = useMutation({
    mutationFn: ({ ids, add, remove }: { ids: string[]; add: string[]; remove?: string[] }) => setOrderTags(ids, add, remove),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      void queryClient.invalidateQueries({ queryKey: ['order-filter-options'] })
    },
  })
  const tagCell = (o: OrderListItem) => (
    <TagsCell tags={o.tags ?? []} known={(tagOptions.data?.tags ?? []).map((t) => t.name)} canEdit={can('orders.update')}
      onChange={(add, remove) => tagOrders.mutate({ ids: [o.id], add, remove })} />
  )
  const bulk = useMutation({
    mutationFn: ({ to, note }: { to: OrderStatus; note: string }) => bulkTransition([...selected], to, note),
    onSuccess: (r) => { reportBatch(r.updated, r.failed, 'moved'); refresh() },
  })
  const approve = useMutation({
    mutationFn: ({ ids, note }: { ids: string[]; note?: string }) => approveOrders(ids, note),
    onSuccess: (r) => { reportBatch(r.approved, r.failed, 'approved'); refresh() },
  })
  const quickStatus = useMutation({
    mutationFn: ({ id, code }: { id: string; code: string }) => setWebOrderStatus([id], code),
    onSuccess: (r) => { reportBatch(r.updated, r.failed, 'updated'); refresh() },
  })

  const chooseStatus = (ids: string[], code: string) => {
    const meta = statusMeta.get(code)
    if (ids.length === 1 && meta && !meta.needs_follow_up && !meta.closes_order) quickStatus.mutate({ id: ids[0], code })
    else setCallDialog({ ids, code })
  }

  const exportCsv = async () => {
    setExporting(true)
    try {
      const rows = selected.size ? (orders.data?.items ?? []).filter((o) => selected.has(o.id)) : await exportOrders(filters)
      downloadCsv(`orders-${view}-${new Date().toISOString().slice(0, 10)}`, rows, [
        { header: 'Order', value: (o) => o.order_number },
        { header: 'Date', value: (o) => formatDateTime(o.created_at) },
        { header: 'Stage', value: (o) => STAGE[o.stage]?.label ?? o.stage },
        { header: 'Status', value: (o) => ORDER_STATUS[o.status].label },
        { header: 'Call status', value: (o) => (o.confirmed_at ? '' : statusMeta.get(o.review_status)?.label ?? o.review_status) },
        { header: 'Customer', value: (o) => o.customer_name },
        { header: 'Phone', value: (o) => o.customer_phone },
        { header: 'District', value: (o) => o.shipping_district },
        { header: 'Items', value: (o) => o.items_preview ?? o.item_count },
        { header: 'Total', value: (o) => o.total_amount },
        { header: 'Paid', value: (o) => o.amount_paid },
        { header: 'COD due', value: (o) => o.cod_amount },
        { header: 'Payment method', value: (o) => PAYMENT_METHOD[o.payment_method] },
        { header: 'Payment status', value: (o) => PAYMENT_STATUS[o.payment_status].label },
        { header: 'Courier', value: (o) => o.courier_name ?? '' },
        { header: 'Tracking', value: (o) => o.tracking_number ?? '' },
        { header: 'Source', value: (o) => o.attribution?.source ?? 'Unknown' },
        { header: 'Campaign', value: (o) => o.attribution?.campaign ?? '' },
      ])
    } finally {
      setExporting(false)
    }
  }

  const selectTab = (tab: string) => {
    setSelected(new Set())
    update({ tab, print: '', due: '', dupes: '', advance: '' })
  }
  const stageMoves = view === 'approved' && state.tab !== 'all'
    ? ORDER_STAGES.find((s) => s.key === state.tab)?.moves ?? []
    : ALL_MOVES

  const columns: Column<OrderListItem>[] = view === 'approved' ? [
    {
      key: 'date', header: 'Date',
      cell: (o) => (
        <div className="whitespace-nowrap text-xs">
          <p className="font-medium text-foreground" title={formatDateTime(o.created_at)}>{formatDateTime(o.created_at)}</p>
          {o.updated_at && <p className="text-muted-foreground">Updated {timeAgo(o.updated_at)}</p>}
        </div>
      ),
    },
    { key: 'order', header: 'Invoice', primary: true, cell: (o) => <InvoiceCell o={o} /> },
    { key: 'customer', header: 'Customer', cell: (o) => <CustomerCell o={o} /> },
    { key: 'note', header: 'Note', hideOnMobile: true, cell: (o) => <NoteCell o={o} /> },
    { key: 'products', header: 'Products', cell: (o) => <ProductsCell o={o} showStage={state.tab === 'all'} /> },
    { key: 'tags', header: 'Tags', hideOnMobile: true, cell: tagCell },
    {
      key: 'print', header: 'Print', align: 'center',
      cell: (o) => o.label_printed_at
        ? <span title={`Printed ${o.label_print_count}× · last ${formatDateTime(o.label_printed_at)}`} className="inline-flex text-emerald-600"><Check className="size-5" aria-label="Printed" /></span>
        : <span className="text-muted-foreground" aria-label="Not printed">—</span>,
    },
    {
      key: 'total', header: 'Total', align: 'right',
      cell: (o) => (
        <div>
          <Money value={o.total_amount} className="font-medium" />
          {Number(o.cod_amount) > 0 && Number(o.cod_amount) !== Number(o.total_amount) && <p className="text-xs text-muted-foreground">COD <Money value={o.cod_amount} /></p>}
          {o.payment_status === 'PAID' && <p className="text-xs font-medium text-emerald-600">Paid</p>}
        </div>
      ),
    },
    { key: 'upload', header: 'Upload', cell: (o) => <UploadCell o={o} /> },
    { key: 'user', header: 'User', hideOnMobile: true, cell: (o) => <span className="text-xs">{o.handled_by ?? '—'}</span> },
    {
      key: 'actions', header: '', align: 'right',
      cell: (o) => (
        <div className="flex items-center justify-end gap-0.5" onClick={(e) => e.stopPropagation()}>
          {can('orders.update') && (
            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" asChild title="Edit order">
              <Link to={`/admin/orders/${o.id}/edit`} aria-label={`Edit ${o.order_number}`}><Pencil /></Link>
            </Button>
          )}
          {can('orders.override') && (
            <Button size="icon" variant="ghost" className="size-7 text-muted-foreground" asChild title="Super Edit — override status or courier details">
              <Link to={`/admin/orders/super-edit?order=${o.id}`} aria-label={`Super Edit ${o.order_number}`}><ShieldAlert /></Link>
            </Button>
          )}
        </div>
      ),
    },
  ] : [
    {
      key: 'order', header: 'Order', primary: true,
      cell: (o) => (
        <div className={cn('flex flex-wrap items-center gap-1.5', view === 'web' && 'max-w-56')}>
          <span className={cn('font-medium', view === 'web' && 'w-full')}>{o.order_number}</span>
          {view === 'web' && <span className="text-xs font-normal text-muted-foreground" title={formatDateTime(o.created_at)}>{timeAgo(o.created_at)}</span>}
          {o.source === 'ADMIN' && <Badge variant="outline" className="text-[10px]">Manual</Badge>}
      {o.sales_channel && <Badge variant="outline" className="text-[10px]" title={o.sales_channel.name}>{o.sales_channel.platform === 'SHOPIFY' ? 'Shopify' : 'Woo'} {o.sales_channel.number}</Badge>}
          {view !== 'web' && o.label_printed_at && (
            <Badge variant="success" className="gap-0.5 text-[10px]" title={`Label printed ${formatDateTime(o.label_printed_at)}`}><Check className="size-3" /> Printed</Badge>
          )}
          {o.duplicate_status === 'SUSPECTED' && (
            <Badge variant="warning" className="gap-0.5 text-[10px]" title={`Possible duplicate of ${o.duplicate_of_number ?? 'another order'}`}><Copy className="size-3" /> Duplicate?</Badge>
          )}
          {o.merged_count > 0 && <Badge variant="info" className="gap-0.5 text-[10px]"><Layers className="size-3" /> +{o.merged_count}</Badge>}
          {o.status === 'ADVANCE_REQUIRED' && <Badge variant="warning" className="text-[10px]">Advance due</Badge>}
          {o.status === 'FRAUD_REVIEW' && <Badge variant="danger" className="text-[10px]">Fraud review</Badge>}
        </div>
      ),
    },
    ...(view === 'web' ? [] : [{ key: 'date', header: 'Date', cell: (o: OrderListItem) => <span title={formatDateTime(o.created_at)} className="text-muted-foreground">{timeAgo(o.created_at)}</span> }]),
    {
      key: 'customer', header: 'Customer',
      cell: (o) => <div className="max-w-48"><p className="truncate">{o.customer_name}</p><p className="text-xs text-muted-foreground">{o.customer_phone} · {o.shipping_district}</p></div>,
    },
  ]
  if (view === 'web') {
    columns.push(
      { key: 'items', header: 'Items', hideOnMobile: true, cell: (o) => <p className="line-clamp-2 max-w-44 text-xs" title={o.items_preview ?? ''}>{o.items_preview ?? `${o.item_count} item(s)`}</p> },
      { key: 'history', header: 'Success Rate', cell: (o) => <SuccessRateCell h={o.courier_history} orderId={o.id} phone={o.customer_phone} /> },
      { key: 'source', header: 'Source', hideOnMobile: true, cell: (o) => <SourceCell a={o.attribution} /> },
      { key: 'tags', header: 'Tags', hideOnMobile: true, cell: tagCell },
      { key: 'call', header: 'Call', cell: (o) => <CallCell o={o} meta={statusMeta.get(o.review_status)} /> },
      { key: 'total', header: 'Total', align: 'right', cell: (o) => <Money value={o.total_amount} className="font-medium" /> },
      {
        key: 'actions', header: '', align: 'right',
        cell: (o) => (
          <WebRowActions o={o} statuses={reviewStatuses.data ?? []} canSet={can('orders.update')} canApprove={can('orders.status')}
            busy={approve.isPending || quickStatus.isPending}
            onStatus={(code) => chooseStatus([o.id], code)} onApprove={() => approve.mutate({ ids: [o.id] })} />
        ),
      },
    )
  } else if (view === 'all') {
    columns.push(
      { key: 'stage', header: 'Stage', cell: (o) => <StageCell o={o} meta={statusMeta.get(o.review_status)} /> },
      { key: 'payment', header: 'Payment', cell: (o) => <StatusBadge value={o.payment_status} map={PAYMENT_STATUS} /> },
      { key: 'courier', header: 'Courier', hideOnMobile: true, cell: (o) => <UploadCell o={o} /> },
      { key: 'risk', header: 'Risk', cell: (o) => <StatusBadge value={o.risk_level} map={RISK_LEVEL} />, hideOnMobile: true },
      {
        key: 'total', header: 'Total', align: 'right',
        cell: (o) => (
          <div>
            <Money value={o.total_amount} className="font-medium" />
            {Number(o.cod_amount) > 0 && Number(o.cod_amount) !== Number(o.total_amount) && <p className="text-xs text-muted-foreground">COD <Money value={o.cod_amount} /></p>}
          </div>
        ),
      },
    )
  }

  const chips: Array<{ key: string; label: string; icon: typeof Truck; value: number | undefined; active: boolean; alert?: boolean; onClick: () => void }> =
    view === 'web' ? [
      { key: 'due', label: 'Call-backs due', icon: AlarmClock, value: counts.data?.follow_up_due, active: state.due === '1', alert: true,
        onClick: () => update({ tab: 'FOLLOW_UP', due: state.due === '1' ? '' : '1', print: '', dupes: '', advance: '' }) },
      { key: 'advance', label: 'Waiting for advance', icon: Wallet, value: undefined, active: state.advance === '1',
        onClick: () => update({ tab: 'all', advance: state.advance === '1' ? '' : '1', due: '', dupes: '', print: '' }) },
      { key: 'dupes', label: 'Possible duplicates', icon: Copy, value: undefined, active: state.dupes === '1',
        onClick: () => update({ tab: 'all', dupes: state.dupes === '1' ? '' : '1', due: '', advance: '', print: '' }) },
    ] : view === 'approved' ? [
      { key: 'print', label: 'Labels to print', icon: Printer, value: summary.data?.to_print, active: state.print === '1',
        onClick: () => update({ tab: 'all', print: state.print === '1' ? '' : '1' }) },
      { key: 'rts', label: 'Ready to ship', icon: PackageCheck, value: summary.data?.ready_to_ship, active: state.tab === 'RTS', onClick: () => selectTab('RTS') },
      { key: 'shipped', label: 'Shipped today', icon: Truck, value: summary.data?.shipped_today, active: false, onClick: () => selectTab('SHIPPED') },
    ] : []

  return (
    <div className="space-y-4">
      <PageHeader
        title={VIEW_META[view].title}
        description={VIEW_META[view].description}
        actions={
          <>
            <Can permission="orders.export">
              <Button variant="outline" size="sm" onClick={exportCsv} disabled={exporting || showLeads}><Download /> {selected.size ? `Export ${selected.size}` : 'Export'}</Button>
            </Can>
            <Can permission="orders.create"><Button size="sm" asChild><Link to="/admin/orders/new"><Plus /> New order</Link></Button></Can>
          </>
        }
      />

      {chips.length > 0 && (
        <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
          {chips.map((c) => {
            const highlight = c.alert && (c.value ?? 0) > 0
            return (
              <button key={c.key} type="button" onClick={c.onClick} aria-pressed={c.active}
                className={cn('press flex shrink-0 items-center gap-2 rounded-full border bg-card px-3.5 py-1.5 text-sm transition-colors hover:border-foreground/25',
                  c.active && 'border-foreground/40', highlight && 'border-amber-300 text-amber-800')}>
                <c.icon className={cn('size-3.5 text-muted-foreground', highlight && 'text-amber-700')} />
                <span className="text-muted-foreground">{c.label}</span>
                {c.value !== undefined && <span className="font-semibold tabular-nums">{c.value}</span>}
              </button>
            )
          })}
        </div>
      )}

      {tabs.length > 0 && (
        <div className={cn('flex gap-1', view === 'approved' ? 'flex-wrap rounded-2xl border bg-card p-1' : '-mx-1 overflow-x-auto px-1 pb-1')} role="tablist">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={state.tab === t.key} onClick={() => selectTab(t.key)} title={t.hint ?? undefined}
              className={cn('flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm transition-colors',
                state.tab === t.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-card hover:text-foreground')}>
              {t.label}
              {counts.data && <span className={cn('text-xs tabular-nums', state.tab === t.key ? 'opacity-70' : 'opacity-80')}>{t.count}</span>}
            </button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder={showLeads ? 'Phone or name' : 'Order #, phone, name, tracking, SKU, address'} className="sm:w-96" />
        {!showLeads && (
          <>
            <OrderFilterButton view={view} values={filterValues}
              onApply={(v) => update(v)}
              incomplete={showLeads}
              onIncomplete={view === 'web' ? (on) => selectTab(on ? 'incomplete' : 'PROCESSING') : undefined}
              countFor={async (v) => (await searchOrders(withValues(v), 'created_at', 'desc', 1, 0)).total} />
            <Select value={`${state.sort}:${state.dir}`} onValueChange={(v) => { const [s, d] = v.split(':'); update({ sort: s, dir: d }) }}>
              <SelectTrigger size="sm" className="w-44" aria-label="Sort"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="created_at:desc">Newest first</SelectItem>
                <SelectItem value="created_at:asc">Oldest first</SelectItem>
                <SelectItem value="total_amount:desc">Highest value</SelectItem>
                <SelectItem value="total_amount:asc">Lowest value</SelectItem>
                {view === 'web' && <SelectItem value="success_rate:desc">Best success rate</SelectItem>}
                {view === 'web' && <SelectItem value="success_rate:asc">Lowest success rate</SelectItem>}
              </SelectContent>
            </Select>
          </>
        )}
        {selected.size > 0 && (
          <div className="enter flex flex-wrap items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3">
            <span className="text-sm font-medium">{selected.size} selected</span>
            {view === 'web' ? (
              <>
                {can('orders.status') && <Button size="sm" className="rounded-full" onClick={() => setApproveIds([...selected])}><Check /> Approve</Button>}
                {can('orders.update') && (
                  <Select value="" onValueChange={(code) => setCallDialog({ ids: [...selected], code })}>
                    <SelectTrigger size="sm" className="w-40 rounded-full" aria-label="Set call status"><SelectValue placeholder="Call status…" /></SelectTrigger>
                    <SelectContent>{(reviewStatuses.data ?? []).map((s) => <SelectItem key={s.code} value={s.code}>{s.label}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </>
            ) : (
              <>
                {can('orders.fulfill') && (
                  <Button size="sm" variant="outline" className="rounded-full" onClick={() => navigate(`/admin/labels?ids=${[...selected].join(',')}`)}><Printer /> Print labels</Button>
                )}
                {can('shipments.manage') && (
                  <Button size="sm" variant="outline" className="rounded-full" onClick={() => setBookOpen(true)}><Truck /> Book courier</Button>
                )}
                {can('orders.status') && stageMoves.length > 0 && (
                  <Select value="" onValueChange={(v) => setBulkTarget(v as OrderStatus)}>
                    <SelectTrigger size="sm" className="w-40 rounded-full" aria-label="Move to stage"><SelectValue placeholder="Move to…" /></SelectTrigger>
                    <SelectContent>
                      {stageMoves.filter((m) => !['CANCELLED', 'PENDING_CANCEL'].includes(m.to) || can('orders.cancel'))
                        .map((m) => <SelectItem key={m.to} value={m.to}>{m.label}</SelectItem>)}
                    </SelectContent>
                  </Select>
                )}
              </>
            )}
            {can('orders.update') && (
              <BulkTagButton known={(tagOptions.data?.tags ?? []).map((t) => t.name)}
                onAdd={(tag) => tagOrders.mutate({ ids: [...selected], add: [tag] }, { onSuccess: () => toast.success(`Tagged ${selected.size} order(s) "${tag}"`) })} />
            )}
            <Button variant="ghost" size="sm" className="rounded-full" onClick={() => setSelected(new Set())}>Clear</Button>
          </div>
        )}
      </div>

      {showLeads ? <IncompleteCheckouts q={state.q} /> : (
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
          empty={<EmptyState title={state.q ? 'No orders match' : 'Nothing here'} description={state.q ? 'Try a different search.' : emptyHint(view, state.tab)} />}
          footer={<Pagination page={page} pageSize={PAGE_SIZE} total={orders.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />}
        />
      )}

      <ConfirmDialog
        open={approveIds !== null}
        onOpenChange={(o) => !o && setApproveIds(null)}
        title={`Approve ${approveIds?.length ?? 0} order${approveIds?.length === 1 ? '' : 's'}?`}
        description="They move to Approved Orders. Orders waiting for an advance or a fraud decision need a fraud reviewer."
        reason
        reasonLabel="Note (optional)"
        confirmLabel="Approve"
        onConfirm={(note) => approve.mutateAsync({ ids: approveIds!, note })}
      />
      <ConfirmDialog
        open={bulkTarget !== null}
        onOpenChange={(o) => !o && setBulkTarget(null)}
        title={`Move ${selected.size} order(s) to ${bulkTarget ? ALL_MOVES.find((m) => m.to === bulkTarget)?.label ?? ORDER_STATUS[bulkTarget].label : ''}?`}
        description={bulkTarget === 'RETURNED' ? 'Every item goes back to stock. To mark items damaged, receive the return from the order page instead.'
          : 'Each order is checked on its own; orders that cannot move are skipped and listed.'}
        reason
        reasonRequired={bulkTarget !== null && NEEDS_REASON.includes(bulkTarget)}
        reasonLabel={bulkTarget && NEEDS_REASON.includes(bulkTarget) ? 'Reason' : 'Note (optional)'}
        destructive={bulkTarget === 'CANCELLED'}
        confirmLabel="Move orders"
        onConfirm={(note) => bulk.mutateAsync({ to: bulkTarget!, note })}
      />
      {callDialog && (
        <CallStatusDialog open ids={callDialog.ids} initial={callDialog.code} statuses={reviewStatuses.data ?? []}
          onOpenChange={(o) => !o && setCallDialog(null)} onDone={refresh} />
      )}
      <BookCourierDialog open={bookOpen} onOpenChange={setBookOpen} orderIds={[...selected]}
        orderNumber={(id) => orders.data?.items.find((o) => o.id === id)?.order_number ?? id.slice(0, 8)}
        onDone={refresh} />
    </div>
  )
}

export default function AllOrdersPage() {
  return <OrdersPage view="all" />
}

function emptyHint(view: View, tab: string) {
  if (view === 'web') return tab === 'PROCESSING' ? 'New website orders land here.' : 'No orders with this call status.'
  if (view === 'approved') return 'Approved orders in this stage show up here.'
  return 'Orders will appear here as they come in.'
}

const RATE_TONE = {
  good: { text: 'text-emerald-600', ring: 'stroke-emerald-500' },
  mid: { text: 'text-amber-600', ring: 'stroke-amber-500' },
  low: { text: 'text-red-600', ring: 'stroke-red-500' },
} as const

function rateTone(rate: number, tier: string | null | undefined) {
  if (tier === 'GOOD' || (!tier && rate >= 80)) return RATE_TONE.good
  if (tier === 'MID' || (!tier && rate >= 50)) return RATE_TONE.mid
  return RATE_TONE.low
}

/** Delivery success as the checkout check saw it: a ring, the rate and the parcels behind it. */
function SuccessRateCell({ h, orderId, phone }: { h: OrderListItem['courier_history']; orderId: string; phone: string }) {
  const counted = h ? h.total ?? h.completed : 0
  const rate = h ? h.rate ?? h.score ?? (h.completed > 0 ? (100 * h.delivered) / h.completed : null) : null
  if (!h || rate === null || (counted === 0 && !h.ranges?.length)) {
    return <span className="text-xs text-muted-foreground">{h ? 'New customer' : 'Not checked'}</span>
  }
  const tone = rateTone(rate, h.tier)
  const r = 9
  const length = 2 * Math.PI * r
  return (
    <div className="flex items-center gap-2" title={h.checked_at ? `Checked ${formatDateTime(h.checked_at)}` : undefined}>
      <svg viewBox="0 0 24 24" className="size-7 shrink-0 -rotate-90" aria-hidden>
        <circle cx="12" cy="12" r={r} fill="none" strokeWidth="3" className="stroke-muted" />
        <circle cx="12" cy="12" r={r} fill="none" strokeWidth="3" strokeLinecap="round" className={tone.ring}
          strokeDasharray={`${(length * Math.min(Math.max(rate, 0), 100)) / 100} ${length}`} />
      </svg>
      <div className="text-xs leading-tight tabular-nums">
        <p>Success: <SuccessRateButton orderId={orderId} phone={phone} rate={rate} className="font-medium" /></p>
        <p>Order: <span className={cn('font-medium', tone.text)}>{h.delivered}/{counted}</span>
</p>
        {!!h.ranges?.length && <p className="text-muted-foreground" title="Couriers that report only a range, not exact parcels">{h.ranges.join(', ')}</p>}
        {h.verdict && <p className="text-muted-foreground">{h.verdict}</p>}
      </div>
    </div>
  )
}

function SourceCell({ a }: { a: OrderListItem['attribution'] }) {
  if (!a || a.channel === 'unknown') return <span className="text-xs text-muted-foreground">Unknown</span>
  return (
    <div className="max-w-36 space-y-0.5 text-xs">
      <p className="truncate font-medium" title={a.campaign ?? undefined}>{a.source}</p>
      {a.campaign ? <p className="truncate text-muted-foreground">{a.campaign}</p> : a.channel !== 'direct' && <div>{paidBadge(a)}</div>}
    </div>
  )
}

function CallCell({ o, meta }: { o: OrderListItem; meta: ReviewStatus | undefined }) {
  const due = o.follow_up_at && new Date(o.follow_up_at).getTime() <= Date.now()
  return (
    <div className="max-w-48 space-y-0.5">
      <Badge variant={(meta?.color ?? 'neutral') as BadgeVariant}>{meta?.label ?? titleCase(o.review_status)}</Badge>
      {(o.contact_attempts > 0 || o.follow_up_at) && (
        <p className="text-xs text-muted-foreground">
          {o.contact_attempts > 0 && `${o.contact_attempts} call${o.contact_attempts === 1 ? '' : 's'}`}
          {o.contact_attempts > 0 && o.follow_up_at && ' · '}
          {o.follow_up_at && <span className={cn(due && 'font-medium text-red-600')}>call {formatDateTime(o.follow_up_at)}</span>}
        </p>
      )}
      {o.review_note && <p className="truncate text-xs text-muted-foreground" title={o.review_note}>{o.review_note}</p>}
    </div>
  )
}

function StageCell({ o, meta }: { o: OrderListItem; meta: ReviewStatus | undefined }) {
  if (o.stage === 'WEB') {
    return (
      <div className="space-y-0.5">
        <Badge variant="outline">Web · {meta?.label ?? titleCase(o.review_status)}</Badge>
      </div>
    )
  }
  const stage = STAGE[o.stage as OrderStage]
  const detail = ORDER_STATUS[o.status].label
  return (
    <div className="space-y-0.5">
      <Badge variant={stage.variant}>{stage.label}</Badge>
      {detail !== stage.label && <p className="text-xs text-muted-foreground">{detail}</p>}
    </div>
  )
}

function WebRowActions({ o, statuses, canSet, canApprove, busy, onStatus, onApprove }: {
  o: OrderListItem
  statuses: ReviewStatus[]
  canSet: boolean
  canApprove: boolean
  busy: boolean
  onStatus: (code: string) => void
  onApprove: () => void
}) {
  const closed = CLOSED.includes(o.status)
  const wa = waNumber(o.customer_phone)
  return (
    <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
      <Button size="icon-sm" variant="ghost" asChild><a href={`tel:${o.customer_phone}`} aria-label={`Call ${o.customer_name}`}><Phone /></a></Button>
      {wa && <Button size="icon-sm" variant="ghost" asChild><a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label={`WhatsApp ${o.customer_name}`}><MessageCircle /></a></Button>}
      {canSet && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" aria-label="Call status">Status <ChevronDown className="size-3" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {statuses.filter((s) => !closed || s.closes_order).map((s) => (
              <DropdownMenuItem key={s.code} onClick={() => onStatus(s.code)} disabled={s.code === o.review_status}>
                <span className={cn('size-2 rounded-full', DOT[s.color] ?? DOT.neutral)} /> {s.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {canApprove && !closed && <Button size="sm" className="h-7" disabled={busy} onClick={onApprove}>Approve</Button>}
    </div>
  )
}

const DOT: Record<string, string> = {
  neutral: 'bg-zinc-400', info: 'bg-sky-500', violet: 'bg-violet-500', success: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-red-500',
}

function localInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function CallStatusDialog({ open, onOpenChange, ids, initial, statuses, onDone }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  ids: string[]
  initial: string
  statuses: ReviewStatus[]
  onDone: () => void
}) {
  const [code, setCode] = useState(initial)
  const [note, setNote] = useState('')
  const [followUp, setFollowUp] = useState(() => localInput(new Date(Date.now() + 2 * 3600_000)))
  useEffect(() => { setCode(initial) }, [initial])
  const meta = statuses.find((s) => s.code === code)
  const save = useMutation({
    mutationFn: () => setWebOrderStatus(ids, code, note, meta?.needs_follow_up ? new Date(followUp).toISOString() : null),
    onSuccess: (r) => { reportBatch(r.updated, r.failed, 'updated'); onOpenChange(false); onDone() },
  })
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} busy={save.isPending} destructive={meta?.closes_order}
      title={ids.length > 1 ? `Call status for ${ids.length} orders` : 'Call status'}
      submitLabel={meta?.closes_order ? 'Close order' : 'Save'}
      disabled={!code || (meta?.needs_follow_up && !followUp)}
      onSubmit={() => save.mutate()}>
      <Field label="Status" htmlFor="call-status">
        <Select value={code} onValueChange={setCode}>
          <SelectTrigger id="call-status"><SelectValue placeholder="Choose…" /></SelectTrigger>
          <SelectContent>{statuses.map((s) => <SelectItem key={s.code} value={s.code}>{s.label}</SelectItem>)}</SelectContent>
        </Select>
      </Field>
      {meta?.closes_order && <p className="rounded-md bg-muted p-2.5 text-sm">This cancels the order and puts its stock back. It stays in Web Orders under {meta.label}.</p>}
      {meta?.needs_follow_up && (
        <Field label="Call back at" htmlFor="call-follow-up">
          <Input id="call-follow-up" type="datetime-local" value={followUp} onChange={(e) => setFollowUp(e.target.value)} />
        </Field>
      )}
      <Field label="Note" htmlFor="call-note" hint="What the customer said, for whoever calls next.">
        <Textarea id="call-note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </Field>
    </FormDialog>
  )
}

type LeadItem = { name?: string; variant?: string | null; quantity?: number }

function IncompleteCheckouts({ q }: { q: string }) {
  const queryClient = useQueryClient()
  const { can } = useAuth()
  const [page, setPage] = useState(1)
  const [contact, setContact] = useState<CheckoutLead | null>(null)
  const [note, setNote] = useState('')
  useEffect(() => setPage(1), [q])
  const leads = useQuery({
    queryKey: ['checkout-leads', q, page],
    placeholderData: keepPreviousData,
    queryFn: () => listCheckoutLeads(['OPEN', 'CONTACTED'], q, PAGE_SIZE, (page - 1) * PAGE_SIZE),
  })
  const save = useMutation({
    mutationFn: ({ id, status, text }: { id: string; status: 'CONTACTED' | 'DISMISSED'; text?: string }) => updateCheckoutLead(id, status, text),
    onSuccess: (_d, v) => {
      toast.success(v.status === 'DISMISSED' ? 'Removed from the list' : 'Call logged')
      setContact(null)
      setNote('')
      void queryClient.invalidateQueries({ queryKey: ['checkout-leads'] })
      void queryClient.invalidateQueries({ queryKey: ['orders', 'queue-counts'] })
    },
  })
  const columns: Column<CheckoutLead>[] = [
    {
      key: 'customer', header: 'Customer', primary: true,
      cell: (l) => <div className="max-w-48"><p className="truncate font-medium">{l.customer_name || 'No name yet'}</p><p className="text-xs text-muted-foreground">{l.phone}{l.district ? ` · ${l.district}` : ''}</p></div>,
    },
    {
      key: 'items', header: 'Cart',
      cell: (l) => <p className="line-clamp-2 max-w-56 text-xs">{((l.items ?? []) as LeadItem[]).map((i) => `${i.name ?? 'Item'}${i.variant ? ` · ${i.variant}` : ''} ×${i.quantity ?? 1}`).join(', ') || '—'}</p>,
    },
    { key: 'total', header: 'Total', align: 'right', cell: (l) => <Money value={l.total} className="font-medium" /> },
    { key: 'source', header: 'Source', hideOnMobile: true, cell: (l) => <span className="text-xs">{l.source ?? 'Unknown'}</span> },
    { key: 'when', header: 'Last seen', cell: (l) => <span className="text-muted-foreground" title={formatDateTime(l.updated_at)}>{timeAgo(l.updated_at)}</span> },
    {
      key: 'status', header: 'Follow-up',
      cell: (l) => (
        <div className="max-w-44 space-y-0.5 text-xs">
          <Badge variant={l.status === 'CONTACTED' ? 'info' : 'neutral'}>{l.status === 'CONTACTED' ? `Called ${l.contact_count}×` : 'Not called'}</Badge>
          {l.notes && <p className="truncate text-muted-foreground" title={l.notes}>{l.notes.split('\n').pop()}</p>}
        </div>
      ),
    },
    {
      key: 'actions', header: '', align: 'right',
      cell: (l) => {
        const wa = waNumber(l.phone)
        return (
          <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
            <Button size="icon-sm" variant="ghost" asChild><a href={`tel:${l.phone}`} aria-label="Call"><Phone /></a></Button>
            {wa && <Button size="icon-sm" variant="ghost" asChild><a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" aria-label="WhatsApp"><MessageCircle /></a></Button>}
            {can('orders.update') && <Button size="sm" variant="outline" className="h-7" onClick={() => setContact(l)}>Log call</Button>}
            {can('orders.create') && <Button size="sm" className="h-7" asChild><Link to={`/admin/orders/new?lead=${l.id}`}><ShoppingBag /> Create order</Link></Button>}
          </div>
        )
      },
    },
  ]
  return (
    <>
      <DataTable
        columns={columns}
        rows={leads.data?.items}
        rowKey={(l) => l.id}
        loading={leads.isFetching}
        error={leads.error}
        onRetry={() => leads.refetch()}
        empty={<EmptyState title="No incomplete checkouts" description="When a visitor types their phone at checkout but doesn't order, they show up here so you can call them." />}
        footer={<Pagination page={page} pageSize={PAGE_SIZE} total={leads.data?.total ?? 0} onPage={setPage} />}
      />
      <Dialog open={contact !== null} onOpenChange={(o) => !o && setContact(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{contact?.customer_name || contact?.phone}</DialogTitle>
            <DialogDescription>Log the call. If they want to order, use Create order — their cart and ad source come with it.</DialogDescription>
          </DialogHeader>
          <Textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did they say?" aria-label="Call note" />
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" onClick={() => contact && save.mutate({ id: contact.id, status: 'DISMISSED', text: note })} disabled={save.isPending}>Not interested</Button>
            <Button onClick={() => contact && save.mutate({ id: contact.id, status: 'CONTACTED', text: note })} disabled={save.isPending}>{save.isPending && <Spinner />} Save call</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function InvoiceCell({ o }: { o: OrderListItem }) {
  return (
    <div className="flex max-w-40 flex-wrap items-center gap-1">
      <span className="w-full font-medium">{o.order_number}</span>
      {o.source === 'ADMIN' && <Badge variant="outline" className="text-[10px]">Manual</Badge>}
      {o.sales_channel && <Badge variant="outline" className="text-[10px]" title={o.sales_channel.name}>{o.sales_channel.platform === 'SHOPIFY' ? 'Shopify' : 'Woo'} {o.sales_channel.number}</Badge>}
      {o.duplicate_status === 'SUSPECTED' && (
        <Badge variant="warning" className="gap-0.5 text-[10px]" title={`Possible duplicate of ${o.duplicate_of_number ?? 'another order'}`}><Copy className="size-3" /> Duplicate?</Badge>
      )}
      {o.merged_count > 0 && <Badge variant="info" className="gap-0.5 text-[10px]"><Layers className="size-3" /> +{o.merged_count}</Badge>}
    </div>
  )
}

/** Name, phone with the delivery success rate, quick call / WhatsApp and the address. */
function CustomerCell({ o }: { o: OrderListItem }) {
  const h = o.courier_history
  const rate = h ? h.rate ?? h.score ?? (h.completed > 0 ? (100 * h.delivered) / h.completed : null) : null
  const tone = rate !== null && h && (h.total ?? h.completed) > 0 ? rateTone(rate, h.tier) : null
  const wa = waNumber(o.customer_phone)
  return (
    <div className="max-w-60 space-y-0.5 text-xs" onClick={(e) => e.stopPropagation()}>
      <p className="flex items-center gap-1 text-sm font-medium">
        <span className="truncate">{o.customer_name}</span>
        <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="Copy name"
          onClick={() => { void navigator.clipboard.writeText(o.customer_name); toast.success('Name copied') }}><Copy className="size-3" /></button>
      </p>
      <p className="flex items-center gap-1.5">
        <span className="tabular-nums">{o.customer_phone}</span>
        {tone && rate !== null && <SuccessRateButton orderId={o.id} phone={o.customer_phone} rate={rate} />}
        <a href={`tel:${o.customer_phone}`} className="text-sky-600 hover:opacity-80" aria-label={`Call ${o.customer_name}`}><Phone className="size-3.5" /></a>
        {wa && <a href={`https://wa.me/${wa}`} target="_blank" rel="noreferrer" className="text-emerald-600 hover:opacity-80" aria-label={`WhatsApp ${o.customer_name}`}><MessageCircle className="size-3.5" /></a>}
      </p>
      <p className="line-clamp-2 text-muted-foreground" title={o.shipping_address}>{o.shipping_address ?? o.shipping_district}{o.shipping_address && !o.shipping_address.includes(o.shipping_district) ? `, ${o.shipping_district}` : ''}</p>
    </div>
  )
}

function NoteCell({ o }: { o: OrderListItem }) {
  const note = o.customer_note || o.review_note
  return note
    ? <p className="line-clamp-3 max-w-40 text-xs" title={note}>{note}</p>
    : <span className="text-xs text-muted-foreground">—</span>
}

const STAGE_DOT: Record<string, string> = {
  success: 'bg-emerald-500', info: 'bg-sky-500', warning: 'bg-amber-500', danger: 'bg-red-500', violet: 'bg-violet-500', neutral: 'bg-zinc-400',
}

function ProductThumb({ src }: { src: string | null | undefined }) {
  const [broken, setBroken] = useState(false)
  if (!src || broken) return <div className="size-8 shrink-0 rounded-md border bg-muted" />
  return <img src={src} alt="" className="size-8 shrink-0 rounded-md border bg-muted object-cover" loading="lazy" onError={() => setBroken(true)} />
}

function ProductsCell({ o, showStage }: { o: OrderListItem; showStage: boolean }) {
  const stage = o.stage !== 'WEB' ? STAGE[o.stage as OrderStage] : null
  const lines = o.lines ?? []
  // On a stage tab the stage is already known; only the finer status (e.g. "In transit") is worth a line.
  const detail = stage && o.stage !== 'PENDING' && ORDER_STATUS[o.status].label !== stage.label ? ORDER_STATUS[o.status].label : null
  return (
    <div className="max-w-64 space-y-1.5">
      {stage && showStage && (
        <p className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
          <span className={cn('size-1.5 rounded-full', STAGE_DOT[stage.variant] ?? STAGE_DOT.neutral)} />{stage.label}
          {detail && <span className="font-normal text-muted-foreground normal-case">· {detail}</span>}
        </p>
      )}
      {!showStage && detail && <p className="text-[11px] text-muted-foreground">{detail}</p>}
      {lines.length === 0 ? <p className="text-xs text-muted-foreground">{o.items_preview ?? `${o.item_count} item(s)`}</p> : lines.map((l, i) => (
        <div key={i} className="flex items-center gap-2">
          <ProductThumb src={l.image_url} />
          <div className="min-w-0 text-xs leading-tight">
            <p className="truncate font-medium" title={l.name}>{l.name}{l.variant ? ` · ${l.variant}` : ''}</p>
            <p className="truncate text-muted-foreground">{l.sku ? `${l.sku} · ` : ''}Qty: {l.quantity}</p>
          </div>
        </div>
      ))}
      {o.item_count > lines.reduce((a, l) => a + l.quantity, 0) && <p className="text-xs text-muted-foreground">+ more items</p>}
    </div>
  )
}

/** ✓✓ and the tracking link once the parcel is booked with a courier's API. */
function UploadCell({ o }: { o: OrderListItem }) {
  const s = o.shipment
  if (!s) return <span className="text-xs text-muted-foreground">—</span>
  const code = s.tracking_number ?? s.consignment_id
  return (
    <div className="max-w-44 text-xs" onClick={(e) => e.stopPropagation()}>
      <p className="flex items-center gap-1">
        {s.uploaded && <CheckCheck className="size-4 shrink-0 text-emerald-600" aria-label="Uploaded to courier" />}
        {code && s.tracking_url
          ? <a href={s.tracking_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 truncate font-mono text-sky-600 underline-offset-2 hover:underline" title={`Track on ${s.courier}`}>{code}<ExternalLink className="size-3 shrink-0" /></a>
          : <span className="truncate font-mono">{code ?? 'Not booked'}</span>}
      </p>
      <p className="text-muted-foreground">{s.courier}</p>
    </div>
  )
}

const TAG_LIMIT = 40

function TagsCell({ tags, known, canEdit, onChange }: { tags: string[]; known: string[]; canEdit: boolean; onChange: (add: string[], remove: string[]) => void }) {
  const [text, setText] = useState('')
  const add = (t: string) => { const v = t.trim().slice(0, TAG_LIMIT); if (v && !tags.includes(v)) onChange([v], []); setText('') }
  return (
    <div className="flex max-w-36 flex-wrap items-center gap-1" onClick={(e) => e.stopPropagation()}>
      {tags.slice(0, 2).map((t) => <Badge key={t} variant="secondary" className="px-1.5 text-[10px]">{t}</Badge>)}
      {tags.length > 2 && <Badge variant="outline" className="px-1.5 text-[10px]" title={tags.slice(2).join(', ')}>+{tags.length - 2}</Badge>}
      {canEdit && (
        <Popover>
          <PopoverTrigger asChild>
            <Button size="icon" variant="ghost" className="size-6 rounded-full border border-dashed text-muted-foreground" aria-label="Edit tags"><Plus className="size-3" /></Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="grid w-60 gap-2 p-3">
            <form onSubmit={(e) => { e.preventDefault(); add(text) }} className="flex gap-1.5">
              <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={TAG_LIMIT} placeholder="New tag" className="h-8" aria-label="New tag" />
              <Button type="submit" size="sm" className="h-8" disabled={!text.trim()}>Add</Button>
            </form>
            {[...new Set([...tags, ...known])].length > 0 && (
              <div className="flex flex-wrap gap-1">
                {[...new Set([...tags, ...known])].map((t) => {
                  const on = tags.includes(t)
                  return (
                    <button key={t} type="button" aria-pressed={on} onClick={() => (on ? onChange([], [t]) : onChange([t], []))}
                      className={cn('press rounded-full border px-2 py-0.5 text-xs', on ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
                      {t}
                    </button>
                  )
                })}
              </div>
            )}
          </PopoverContent>
        </Popover>
      )}
    </div>
  )
}

function BulkTagButton({ known, onAdd }: { known: string[]; onAdd: (tag: string) => void }) {
  const [text, setText] = useState('')
  return (
    <Popover>
      <PopoverTrigger asChild><Button size="sm" variant="outline" className="rounded-full"><Tag /> Tag</Button></PopoverTrigger>
      <PopoverContent align="start" className="grid w-60 gap-2 p-3">
        <form onSubmit={(e) => { e.preventDefault(); if (text.trim()) { onAdd(text.trim().slice(0, TAG_LIMIT)); setText('') } }} className="flex gap-1.5">
          <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={TAG_LIMIT} placeholder="Tag name" className="h-8" aria-label="Tag name" />
          <Button type="submit" size="sm" className="h-8" disabled={!text.trim()}>Add</Button>
        </form>
        <div className="flex flex-wrap gap-1">
          {known.map((t) => <button key={t} type="button" onClick={() => onAdd(t)} className="press rounded-full border px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground">{t}</button>)}
        </div>
      </PopoverContent>
    </Popover>
  )
}
