import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, ArrowDown, ArrowRight, ArrowUp, Boxes, ChevronRight, ClipboardList, CreditCard, Eye, EyeOff, Factory, GripVertical, LayoutGrid,
  PackagePlus, Plug, RefreshCw, RotateCcw, ShieldAlert, ShoppingCart, Sparkles, Truck, TrendingDown, TrendingUp, UserPlus, Wallet, X,
} from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { percentChange, StatCard } from '@/components/common/stat-card'
import { StatusBadge } from '@/components/common/status-badge'
import { CardsSkeleton, ErrorState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/auth-context'
import { useDashboardLayout } from '@/features/dashboard/use-dashboard-layout'
import { OnlineStoreChoice } from '@/features/website/online-store-choice'
import { useStoreConfig } from '@/hooks/use-store-config'
import { BarsChart, ShareList, TrendChart } from '@/features/reports/charts'
import { useRealtimeInvalidate } from '@/hooks/use-realtime'
import { type DateRange, granularityFor, previousPeriod, rangeFor, RANGE_PRESETS } from '@/lib/dates'
import { formatMoney, formatNumber, formatPercent, timeAgo, toNumber } from '@/lib/format'
import { ORDER_STATUS, RISK_LEVEL } from '@/lib/status'
import { cn } from '@/lib/utils'
import { queueCounts, statusCounts } from '@/services/orders'
import { type CommandCenter, commandCenter, dashboardOverview, timeseries } from '@/services/reports'
import type { DashboardOverview, OrderStatus } from '@/types/domain'

const QUICK_ACTIONS = [
  { label: 'New order', to: '/admin/orders/new', icon: <ClipboardList />, permission: 'orders.create' },
  { label: 'Add product', to: '/admin/products/new', icon: <PackagePlus />, permission: 'products.manage' },
  { label: 'Stock adjustment', to: '/admin/inventory/adjustments?new=1', icon: <Boxes />, permission: 'inventory.adjust' },
  { label: 'Add expense', to: '/admin/finance/expenses?new=1', icon: <TrendingDown />, permission: 'finance.manage' },
  { label: 'Create purchase', to: '/admin/purchases/new', icon: <Truck />, permission: 'purchases.manage' },
]

interface Ctx {
  d: DashboardOverview
  c: CommandCenter | undefined
  series: Array<Record<string, unknown>> | undefined
  can: (p: string) => boolean
}

interface Widget {
  id: string
  title: string
  span: 'full' | 'half' | 'third'
  permission?: string
  render: (ctx: Ctx) => ReactNode
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>

const WIDGETS: Widget[] = [
  { id: 'business', title: 'Business overview', span: 'full', render: (x) => <BusinessOverview {...x} /> },
  { id: 'couriers', title: 'Courier overview', span: 'full', permission: 'orders.view', render: (x) => <CourierOverview c={x.c} /> },
  {
    id: 'sales', title: 'Sales', span: 'half', permission: 'reports.view',
    render: ({ d, series }) => (
      <TrendChart data={series ?? []} xKey="bucket" format="money"
        series={d.finance ? [{ key: 'revenue', label: 'Revenue', slot: 1 }, { key: 'expenses', label: 'Expenses', slot: 2 }, { key: 'profit', label: 'Profit', slot: 3 }]
          : [{ key: 'gross_sales', label: 'Gross sales', slot: 1 }]} />
    ),
  },
  {
    id: 'orders-chart', title: 'Orders', span: 'half', permission: 'reports.view',
    render: ({ series }) => (
      <BarsChart data={series ?? []} xKey="bucket" dateAxis stacked series={[{ key: 'orders', label: 'Orders', slot: 1 }, { key: 'cancelled', label: 'Cancelled', slot: 2 }]} />
    ),
  },
  {
    id: 'status', title: 'Order status', span: 'third',
    render: ({ d }) => {
      const items = Object.entries(d.status_distribution).map(([k, v]) => ({ label: ORDER_STATUS[k as OrderStatus]?.label ?? k, value: v }))
        .sort((a, b) => b.value - a.value)
      const rest = items.slice(7).reduce((t, i) => t + i.value, 0)
      return <ShareList items={rest > 0 ? [...items.slice(0, 7), { label: 'Other', value: rest }] : items} />
    },
  },
  { id: 'marketing', title: 'Marketing performance', span: 'third', permission: 'marketing.view', render: ({ c }) => <MarketingWidget c={c} /> },
  {
    id: 'rates', title: 'Delivery & risk', span: 'third',
    render: ({ d }) => (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
        {[
          ['Cancellation', d.cancellation_rate, d.cancellation_rate > 15], ['Return', d.return_rate, false],
          ['Failed delivery', d.failed_delivery_rate, d.failed_delivery_rate > 10], ['Fraud rejected', d.fraud_rejection_rate, false],
          ['COD orders', d.cod_percentage, false], ['Advance orders', d.advance_percentage, false],
        ].map(([label, v, warn]) => (
          <div key={String(label)}>
            <dt className="text-xs text-muted-foreground">{String(label)}</dt>
            <dd className={cn('text-lg font-semibold tabular-nums', warn ? 'text-amber-600' : undefined)}>{formatPercent(Number(v))}</dd>
          </div>
        ))}
      </dl>
    ),
  },
  { id: 'recent-orders', title: 'Recent orders', span: 'half', permission: 'orders.view', render: ({ c }) => <RecentOrders c={c} /> },
  { id: 'recent-customers', title: 'Recent customers', span: 'half', permission: 'customers.view', render: ({ c }) => <RecentCustomers c={c} /> },
  {
    id: 'top-products', title: 'Top products', span: 'half',
    render: ({ d }) => d.top_products.length === 0 ? <Empty>No sales in this period.</Empty> : (
      <ul className="divide-y text-sm">
        {d.top_products.map((p) => (
          <li key={p.product_id} className="flex justify-between gap-3 py-2">
            <Link to={`/admin/products/${p.product_id}`} className="truncate hover:underline">{p.product_name}</Link>
            <span className="shrink-0 text-muted-foreground tabular-nums">{formatNumber(p.quantity)} sold · <Money value={p.revenue} /></span>
          </li>
        ))}
      </ul>
    ),
  },
  {
    id: 'low-stock', title: 'Low stock', span: 'half', permission: 'inventory.view',
    render: ({ d }) => d.low_stock.length === 0 ? <Empty>All products are well stocked.</Empty> : (
      <ul className="divide-y text-sm">
        {d.low_stock.map((s) => (
          <li key={s.variant_id} className="flex justify-between gap-2 py-2">
            <Link to={`/admin/products/${s.product_id}`} className="truncate hover:underline">{s.product_name}{s.variant_title !== 'Default' ? ` · ${s.variant_title}` : ''}</Link>
            <Badge variant={s.available <= 0 ? 'danger' : 'warning'}>{s.available} left</Badge>
          </li>
        ))}
      </ul>
    ),
  },
  {
    id: 'top-customers', title: 'Top customers', span: 'half', permission: 'customers.view',
    render: ({ d }) => d.top_customers.length === 0 ? <Empty>No orders in this period.</Empty> : (
      <ul className="divide-y text-sm">
        {d.top_customers.map((c) => (
          <li key={c.customer_id} className="flex justify-between gap-3 py-2">
            <Link to={`/admin/customers/${c.customer_id}`} className="truncate hover:underline">{c.customer_name} <span className="text-muted-foreground">{c.customer_phone}</span></Link>
            <span className="shrink-0 text-muted-foreground tabular-nums">{c.orders} order{c.orders === 1 ? '' : 's'} · <Money value={c.total} /></span>
          </li>
        ))}
      </ul>
    ),
  },
]
const DEFAULT_ORDER = WIDGETS.map((w) => w.id)
const SPAN = { full: 'lg:col-span-6', half: 'lg:col-span-3', third: 'lg:col-span-2' }

function greeting(name: string | null | undefined) {
  const h = new Date().getHours()
  const part = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
  const first = name?.trim().split(/\s+/)[0]
  return first ? `${part}, ${first}` : part
}

function rangeLabel(range: DateRange) {
  const preset = RANGE_PRESETS.find((p) => { const r = rangeFor(p.key); return r.from === range.from && r.to === range.to })
  return preset ? preset.label.toLowerCase() : `${range.from} – ${range.to}`
}

export default function DashboardPage() {
  const { can, user, access } = useAuth()
  const { data: config } = useStoreConfig()
  const [params, setParams] = useSearchParams()
  const [range, setRange] = useState<DateRange>(() => rangeFor('today'))
  const [editing, setEditing] = useState(false)
  const [dragging, setDragging] = useState<string | null>(null)
  const queryClient = useQueryClient()
  // Every number on the dashboard, including the order pipeline counts.
  const refreshing = useIsFetching({ predicate: (q) => q.queryKey[0] === 'dashboard' || (q.queryKey[0] === 'orders' && String(q.queryKey[1]).endsWith('-counts')) }) > 0
  const refresh = () => Promise.all([
    queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
    queryClient.invalidateQueries({ queryKey: ['orders', 'queue-counts'] }),
    queryClient.invalidateQueries({ queryKey: ['orders', 'status-counts'] }),
  ])
  const overview = useQuery({ queryKey: ['dashboard', range], queryFn: () => dashboardOverview(range.from, range.to) })
  const center = useQuery({ queryKey: ['dashboard', 'center', range], queryFn: () => commandCenter(range.from, range.to) })
  const prev = previousPeriod(range)
  const before = useQuery({ queryKey: ['dashboard', 'center', prev], queryFn: () => commandCenter(prev.from, prev.to), staleTime: 5 * 60_000 })
  const granularity = granularityFor(range)
  const series = useQuery({
    queryKey: ['dashboard', 'series', range, granularity],
    enabled: can('reports.view'),
    queryFn: () => timeseries(range.from, range.to, granularity),
  })
  useRealtimeInvalidate('finance_transactions', [['dashboard']], can('finance.view'))
  const { layout, move, toggle, reset } = useDashboardLayout(user?.id, DEFAULT_ORDER)

  const d = overview.data
  const actions = d?.action_items
  const widgets = layout.order
    .map((id) => WIDGETS.find((w) => w.id === id)!)
    .filter((w) => w && (!w.permission || can(w.permission)))

  return (
    <div className="space-y-6">
      <PageHeader title={greeting(access?.full_name)} description={`${config?.store.name ?? 'Your store'} · ${rangeLabel(range)}`}
        actions={(
          <>
            <Button size="icon-sm" variant="outline" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh dashboard" title="Refresh">
              <RefreshCw className={cn(refreshing && 'animate-spin')} />
            </Button>
            <DateRangeFilter value={range} onChange={setRange} />
            <Button size="sm" variant={editing ? 'default' : 'outline'} onClick={() => setEditing((e) => !e)}>
              <LayoutGrid /> {editing ? 'Done' : 'Customize'}
            </Button>
          </>
        )} />

      <OnlineStoreChoice />

      {params.get('welcome') === '1' && <WelcomeChecklist onClose={() => { params.delete('welcome'); setParams(params, { replace: true }) }} />}

      <KpiRow c={center.data} prev={before.data} series={series.data as Array<Record<string, unknown>> | undefined} finance={can('finance.view')} />

      {!editing && (
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
          {QUICK_ACTIONS.filter((a) => can(a.permission)).map((a) => (
            <Button key={a.to} variant="outline" size="sm" className="shrink-0" asChild><Link to={a.to}>{a.icon} {a.label}</Link></Button>
          ))}
        </div>
      )}

      {can('orders.view') && <StatusTiles />}

      {overview.error ? <ErrorState error={overview.error} onRetry={() => overview.refetch()} /> : !d ? <CardsSkeleton count={8} /> : (
        <>
          {actions && Object.values(actions).some((n) => n > 0) && !editing && (
            <section aria-label="Needs your attention" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {[
                { n: actions.fraud_review, label: 'Fraud review', to: '/admin/orders/fraud', icon: <ShieldAlert className="size-4 text-red-600" /> },
                { n: actions.advance_pending, label: 'Awaiting advance', to: '/admin/orders/fraud?tab=advance', icon: <Wallet className="size-4 text-amber-600" /> },
                { n: actions.payments_to_verify, label: 'Payments to verify', to: '/admin/orders/web?tab=all', icon: <CreditCard className="size-4 text-amber-600" /> },
                { n: actions.confirmation_required, label: 'Web orders to call', to: '/admin/orders/web', icon: <ShoppingCart className="size-4" /> },
                { n: actions.ready_to_ship, label: 'Ready to ship', to: '/admin/orders/approved?tab=RTS', icon: <Truck className="size-4" /> },
                { n: actions.low_stock, label: 'Low stock', to: '/admin/inventory?view=alerts', icon: <AlertTriangle className="size-4 text-amber-600" /> },
                { n: actions.production_overdue, label: 'Production overdue', to: '/admin/production', icon: <Factory className="size-4 text-red-600" /> },
              ].filter((a) => a.n > 0).map((a) => (
                <Link key={a.label} to={a.to} className="group flex items-center gap-3 rounded-xl border bg-card px-3.5 py-3 text-sm shadow-xs transition-[border-color,box-shadow] hover:border-foreground/15 hover:shadow-sm">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-xl bg-muted">{a.icon}</span>
                  <span className="min-w-0 flex-1"><span className="block truncate font-medium">{a.label}</span><span className="block text-xs text-muted-foreground">{formatNumber(a.n)} waiting</span></span>
                  <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                </Link>
              ))}
            </section>
          )}

          {editing && (
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-dashed px-4 py-2.5 text-sm text-muted-foreground">
              Drag cards to reorder (or use the arrows), hide what you don't need. Saved for you on this device.
              <Button size="sm" variant="ghost" className="ml-auto" onClick={reset}><RotateCcw /> Reset</Button>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-6">
            {widgets.map((w, index) => {
              const hidden = layout.hidden.includes(w.id)
              if (hidden && !editing) return null
              return (
                <Card
                  key={w.id}
                  className={cn('min-w-0', SPAN[w.span], editing && 'border-dashed', hidden && 'opacity-50', dragging === w.id && 'ring-2 ring-ring')}
                  draggable={editing}
                  onDragStart={(e) => { setDragging(w.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => { if (editing && dragging) e.preventDefault() }}
                  onDrop={(e) => { e.preventDefault(); if (dragging && dragging !== w.id) move(dragging, layout.order.indexOf(w.id)); setDragging(null) }}
                >
                  <CardHeader>
                    <CardTitle className="flex items-center gap-1.5 text-[15px]">
                      {editing && <GripVertical className="size-4 cursor-grab text-muted-foreground" aria-hidden />}
                      {w.title}
                    </CardTitle>
                    {editing && (
                      <CardAction className="flex gap-0.5">
                        <Button size="icon-sm" variant="ghost" aria-label={`Move ${w.title} up`} disabled={index === 0}
                          onClick={() => move(w.id, layout.order.indexOf(widgets[index - 1].id))}><ArrowUp /></Button>
                        <Button size="icon-sm" variant="ghost" aria-label={`Move ${w.title} down`} disabled={index === widgets.length - 1}
                          onClick={() => move(w.id, layout.order.indexOf(widgets[index + 1].id))}><ArrowDown /></Button>
                        <Button size="icon-sm" variant="ghost" aria-label={hidden ? `Show ${w.title}` : `Hide ${w.title}`} onClick={() => toggle(w.id)}>
                          {hidden ? <EyeOff /> : <Eye />}
                        </Button>
                      </CardAction>
                    )}
                  </CardHeader>
                  {!hidden && <CardContent>{w.render({ d, c: center.data, series: series.data as Array<Record<string, unknown>> | undefined, can })}</CardContent>}
                </Card>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}

/** Where every order is right now (all time), one tap from its list. */
function StatusTiles() {
  const { can } = useAuth()
  const queue = useQuery({ queryKey: ['orders', 'queue-counts'], queryFn: queueCounts, staleTime: 30_000 })
  const status = useQuery({ queryKey: ['orders', 'status-counts'], queryFn: statusCounts, staleTime: 30_000 })
  const a = queue.data?.approved ?? {}
  const total = Object.values(status.data ?? {}).reduce((s, n) => s + n, 0)
  const tiles = [
    { label: 'Total orders', n: total, to: '/admin/orders' },
    { label: 'Pending (web)', n: queue.data?.web?.PROCESSING, to: '/admin/orders/web' },
    { label: 'Pending', n: a.PENDING, to: '/admin/orders/approved?tab=PENDING' },
    { label: 'Ready (RTS)', n: a.RTS, to: '/admin/orders/approved?tab=RTS' },
    { label: 'Shipped', n: a.SHIPPED, to: '/admin/orders/approved?tab=SHIPPED' },
    { label: 'Delivered', n: a.DELIVERED, to: '/admin/orders/approved?tab=DELIVERED', tone: 'text-emerald-600' },
    { label: 'Return pending', n: a.RETURN_PENDING ?? 0, to: '/admin/orders/approved?tab=RETURN_PENDING', tone: 'text-amber-600' },
    { label: 'Returned', n: a.RETURNED, to: '/admin/orders/approved?tab=RETURNED' },
    { label: 'Partial', n: a.PARTIAL, to: '/admin/orders/approved?tab=PARTIAL' },
    { label: 'Cancelled', n: a.CANCELLED, to: '/admin/orders/approved?tab=CANCELLED' },
    { label: 'Preorder', n: a.PRE_ORDER, to: '/admin/orders/approved?tab=PRE_ORDER' },
    { label: 'Lost', n: a.LOST, to: '/admin/orders/approved?tab=LOST', tone: 'text-red-600' },
  ]
  if (!can('orders.view')) return null
  return (
    <section aria-label="Orders by status" className="rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-0.5">
        <h2 className="text-[13px] font-semibold">Order pipeline</h2>
        <Link to="/admin/orders" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">All orders <ArrowRight className="size-3" /></Link>
      </div>
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-b-2xl sm:grid-cols-4 lg:grid-cols-6">
        {tiles.map((t) => (
          <Link key={t.label} to={t.to} className="group px-4 py-2.5 transition-colors hover:bg-muted/50">
            <p className="truncate text-[11px] text-muted-foreground group-hover:text-foreground">{t.label}</p>
            <p className={cn('mt-0.5 text-[17px] font-semibold tabular-nums', (t.n ?? 0) > 0 && t.tone)}>{queue.data || status.data ? formatNumber(t.n ?? 0) : '—'}</p>
          </Link>
        ))}
      </div>
    </section>
  )
}

function Tile({ label, value, hint, tone, to }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'positive' | 'negative'; to?: string }) {
  const body = (
    <>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn('mt-0.5 text-xl font-semibold tabular-nums', tone === 'positive' && 'text-emerald-600', tone === 'negative' && 'text-red-600')}>{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-muted-foreground">{hint}</p>}
    </>
  )
  return to ? <Link to={to} className="rounded-xl p-2.5 transition-colors hover:bg-muted/60">{body}</Link> : <div className="p-2.5">{body}</div>
}

function BusinessOverview({ d, c, can }: Ctx) {
  if (!c) return <CardsSkeleton count={5} />
  const f = c.finance
  const returning = c.period.orders > 0 ? (100 * c.period.returning_orders) / c.period.orders : null
  return (
    <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-5">
      <Tile label="Today's sales" value={formatMoney(c.today.sales)} hint={`${formatNumber(c.today.orders)} orders today · ${formatNumber(c.today.delivered)} delivered`} to="/admin/orders" />
      <Tile label="Today's orders" value={formatNumber(c.today.orders)} hint={`${formatNumber(c.today.approved)} approved today`} to="/admin/orders/web" />
      {f && <Tile label="Today's profit" value={formatMoney(f.today_profit)} tone={toNumber(f.today_profit) < 0 ? 'negative' : 'positive'} hint="delivered today, after costs" to="/admin/finance/profit-loss" />}
      <Tile label="COD with couriers" value={formatMoney(c.cod_in_transit)} hint={f ? `${formatMoney(f.cod_receivable)} delivered, not yet settled` : 'shipped, not yet delivered'} to={can('couriers.view') ? '/admin/couriers?tab=cod' : undefined} />
      {f && <Tile label="Courier fees" value={formatMoney(f.courier_fees)} hint="delivery, COD and return charges" to="/admin/couriers?tab=performance" />}
      {c.ad_spend !== null && <Tile label="Ad spend" value={formatMoney(c.ad_spend)} hint="Meta (synced) and other campaigns" to="/admin/marketing" />}
      {f && <Tile label="Net profit" value={formatMoney(f.net_profit)} tone={toNumber(f.net_profit) < 0 ? 'negative' : 'positive'} hint={`gross profit ${formatMoney(f.gross_profit)}`} to="/admin/finance" />}
      <Tile label="Conversion rate" value={c.period.conversion_rate === null ? '—' : formatPercent(c.period.conversion_rate)}
        hint={c.period.sessions ? `${formatNumber(c.period.sessions)} store visits` : 'no store visits recorded'} />
      <Tile label="Average order value" value={formatMoney(c.period.average_order_value)} hint={`${formatNumber(c.period.orders)} orders · ${formatMoney(c.period.sales)}`} />
      <Tile label="Returning customers" value={returning === null ? '—' : formatPercent(returning)} hint={`${formatNumber(c.period.returning_orders)} repeat orders`} to="/admin/customers" />
      {!f && <Tile label="Delivered in period" value={formatNumber(d.delivered)} />}
    </div>
  )
}

function CourierOverview({ c }: { c: CommandCenter | undefined }) {
  if (!c) return <CardsSkeleton count={3} />
  if (c.couriers.length === 0) return <Empty>No parcels booked in this period.</Empty>
  const total = c.couriers.reduce((s, x) => s + x.total, 0)
  const stale = c.couriers.reduce((s, x) => s + x.stale, 0)
  return (
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b">
              <th className="py-1.5 pr-2 text-left font-medium">Courier</th>
              <th className="px-2 py-1.5 text-right font-medium">Parcels</th>
              <th className="px-2 py-1.5 text-right font-medium">Booked</th>
              <th className="px-2 py-1.5 text-right font-medium">In transit</th>
              <th className="px-2 py-1.5 text-right font-medium">Delivered</th>
              <th className="px-2 py-1.5 text-right font-medium">Returned</th>
              <th className="px-2 py-1.5 text-right font-medium">Failed</th>
              <th className="px-2 py-1.5 text-right font-medium" title="On the way with no courier update for 24 hours">Needs sync</th>
              <th className="py-1.5 pl-2 text-right font-medium">Success</th>
            </tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {c.couriers.map((x) => (
              <tr key={x.id}>
                <td className="py-2 pr-2"><Link to={`/admin/couriers?tab=shipments`} className="font-medium hover:underline">{x.name}</Link></td>
                <td className="px-2 text-right">{formatNumber(x.total)}<span className="block text-[11px] text-muted-foreground">{total ? formatPercent((100 * x.total) / total, 0) : ''}</span></td>
                <td className="px-2 text-right">{formatNumber(x.booked)}</td>
                <td className="px-2 text-right">{formatNumber(x.in_transit)}</td>
                <td className="px-2 text-right text-emerald-600">{formatNumber(x.delivered)}</td>
                <td className="px-2 text-right">{formatNumber(x.returned)}</td>
                <td className={cn('px-2 text-right', x.failed > 0 && 'text-red-600')}>{formatNumber(x.failed)}</td>
                <td className={cn('px-2 text-right', x.stale > 0 && 'text-amber-600')}>{formatNumber(x.stale)}</td>
                <td className="pl-2 text-right">{x.success_rate === null ? '—' : formatPercent(x.success_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted-foreground">
        {c.unshipped_approved > 0 && <Link to="/admin/orders/approved?tab=PENDING" className="hover:underline">{formatNumber(c.unshipped_approved)} approved orders not booked with a courier yet. </Link>}
        {stale > 0 && <Link to="/admin/couriers?tab=shipments" className="text-amber-600 hover:underline">{formatNumber(stale)} parcels have had no courier update for a day — check their status.</Link>}
      </p>
    </div>
  )
}

function MarketingWidget({ c }: { c: CommandCenter | undefined }) {
  if (!c?.sources) return <CardsSkeleton count={2} />
  if (c.sources.length === 0) return <Empty>No orders in this period.</Empty>
  const revenue = c.sources.reduce((s, x) => s + toNumber(x.revenue), 0)
  return (
    <div className="space-y-3 text-sm">
      <ul className="divide-y">
        {c.sources.map((s) => (
          <li key={s.source} className="flex items-center justify-between gap-2 py-1.5">
            <Link to={`/admin/marketing?source=${encodeURIComponent(s.source)}&group=campaign`} className="truncate hover:underline">{s.source}</Link>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatNumber(s.orders)} orders · <Money value={s.revenue} /></span>
          </li>
        ))}
      </ul>
      <p className="flex justify-between border-t pt-2 text-xs text-muted-foreground">
        <span>Ad spend <Money value={c.ad_spend} /></span>
        <span>ROAS {c.ad_spend ? `${formatNumber(revenue / toNumber(c.ad_spend), 2)}×` : '—'}</span>
      </p>
    </div>
  )
}

function RecentOrders({ c }: { c: CommandCenter | undefined }) {
  if (!c) return <CardsSkeleton count={3} />
  if (c.recent_orders.length === 0) return <Empty>No orders yet.</Empty>
  return (
    <ul className="divide-y text-sm">
      {c.recent_orders.map((o) => (
        <li key={o.id} className="flex items-center gap-3 py-2">
          <Link to={`/admin/orders/${o.id}`} className="min-w-0 flex-1">
            <span className="block truncate font-medium hover:underline">{o.order_number} · {o.customer_name}</span>
            <span className="block text-xs text-muted-foreground">{o.customer_phone} · {timeAgo(o.created_at)}</span>
          </Link>
          <StatusBadge value={o.status} map={ORDER_STATUS} />
          <Money value={o.total_amount} className="w-20 shrink-0 text-right" />
        </li>
      ))}
    </ul>
  )
}

function RecentCustomers({ c }: { c: CommandCenter | undefined }) {
  if (!c?.recent_customers) return <CardsSkeleton count={3} />
  if (c.recent_customers.length === 0) return <Empty>No customers yet.</Empty>
  return (
    <ul className="divide-y text-sm">
      {c.recent_customers.map((x) => (
        <li key={x.id} className="flex items-center gap-3 py-2">
          <Link to={`/admin/customers/${x.id}`} className="min-w-0 flex-1">
            <span className="block truncate font-medium hover:underline">{x.full_name}</span>
            <span className="block text-xs text-muted-foreground">{x.phone}{x.district ? ` · ${x.district}` : ''} · joined {timeAgo(x.created_at)}</span>
          </Link>
          {x.risk_level && x.risk_level !== 'LOW' && <Badge variant={RISK_LEVEL[x.risk_level].variant}>{RISK_LEVEL[x.risk_level].label}</Badge>}
          <span className="shrink-0 text-right text-xs text-muted-foreground tabular-nums">{x.total_orders} order{x.total_orders === 1 ? '' : 's'}<br /><Money value={x.total_spent} /></span>
        </li>
      ))}
    </ul>
  )
}

/** Headline numbers for the period with their trend and the change against the period before. */
function KpiRow({ c, prev, series, finance }: { c: CommandCenter | undefined; prev: CommandCenter | undefined; series: Array<Record<string, unknown>> | undefined; finance: boolean }) {
  if (!c) return <CardsSkeleton count={4} />
  const line = (key: string) => series?.map((p) => toNumber(p[key])) ?? undefined
  const vs = (delta: number | null) => (delta != null ? 'vs previous period' : undefined)
  const cards = [
    { label: 'Sales', value: formatMoney(c.period.sales), trend: line('gross_sales'), delta: prev ? percentChange(c.period.sales, prev.period.sales) : null, fallback: `${formatMoney(c.today.sales)} today`, icon: <Wallet />, to: '/admin/orders' },
    { label: 'Orders', value: formatNumber(c.period.orders), trend: line('orders'), delta: prev ? percentChange(c.period.orders, prev.period.orders) : null, fallback: `${formatNumber(c.today.orders)} today`, icon: <ShoppingCart />, to: '/admin/orders/web' },
    { label: 'Average order', value: formatMoney(c.period.average_order_value), trend: undefined, delta: prev ? percentChange(c.period.average_order_value, prev.period.average_order_value) : null, fallback: `${formatNumber(c.period.orders)} orders`, icon: <ClipboardList /> },
    finance && c.finance
      ? { label: 'Net profit', value: formatMoney(c.finance.net_profit), trend: line('profit'), delta: prev?.finance ? percentChange(c.finance.net_profit, prev.finance.net_profit) : null, fallback: `gross ${formatMoney(c.finance.gross_profit)}`, icon: <TrendingUp />, to: '/admin/finance/profit-loss' }
      : { label: 'COD with couriers', value: formatMoney(c.cod_in_transit), trend: undefined, delta: null, fallback: 'shipped, not yet delivered', icon: <Truck />, to: '/admin/couriers?tab=cod' },
  ].map((k) => ({ ...k, hint: vs(k.delta) ?? k.fallback }))
  return (
    <section aria-label="Key numbers" className="grid grid-cols-2 gap-3 xl:grid-cols-4">
      {cards.map((k) => <StatCard key={k.label} label={k.label} value={k.value} trend={k.trend} delta={k.delta} hint={k.hint} icon={k.icon} to={k.to} />)}
    </section>
  )
}

/** First steps for a business that has just opened its account. */
function WelcomeChecklist({ onClose }: { onClose: () => void }) {
  const { can } = useAuth()
  const steps = [
    { icon: <PackagePlus />, title: 'Add your products', text: 'Or import them from your store.', to: '/admin/products/new', permission: 'products.manage' },
    { icon: <Plug />, title: 'Connect your store', text: 'Shopify or WooCommerce orders come in by themselves.', to: '/admin/channels', permission: 'settings.view' },
    { icon: <Truck />, title: 'Connect a courier', text: 'Steadfast, Pathao, RedX and more.', to: '/admin/couriers', permission: 'couriers.view' },
    { icon: <UserPlus />, title: 'Invite your team', text: 'Give each person only what they need.', to: '/admin/users', permission: 'users.manage' },
  ].filter((x) => can(x.permission))
  return (
    <section aria-label="Get started" className="relative overflow-hidden rounded-xl border bg-card p-5 shadow-xs">
      <div aria-hidden className="pointer-events-none absolute -top-24 -right-24 size-64 rounded-full bg-[radial-gradient(closest-side,var(--brand-soft),transparent)]" />
      <button type="button" onClick={onClose} className="absolute top-3 right-3 rounded-lg p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Hide"><X className="size-4" /></button>
      <p className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]"><Sparkles className="size-4 text-brand" /> Your business is open</p>
      <p className="mt-1 text-sm text-muted-foreground">Four short steps and your first orders can flow in.</p>
      <ol className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {steps.map((x, i) => (
          <li key={x.title}>
            <Link to={x.to} className="group flex h-full gap-3 rounded-xl border bg-background p-3 transition-colors hover:border-foreground/20">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground [&_svg]:size-4">{x.icon}</span>
              <span className="min-w-0">
                <span className="block text-sm font-medium">{i + 1}. {x.title}</span>
                <span className="block text-xs text-muted-foreground">{x.text}</span>
              </span>
            </Link>
          </li>
        ))}
      </ol>
    </section>
  )
}
