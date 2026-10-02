import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle, Boxes, ClipboardList, CreditCard, Factory, PackagePlus, PlusCircle, ShieldAlert, ShoppingCart, Truck,
  TrendingDown, TrendingUp, Wallet,
} from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, ErrorState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/auth-context'
import { BarsChart, ShareList, TrendChart } from '@/features/reports/charts'
import { useRealtimeInvalidate } from '@/hooks/use-realtime'
import { type DateRange, granularityFor, rangeFor } from '@/lib/dates'
import { formatMoney, formatNumber, formatPercent } from '@/lib/format'
import { ORDER_STATUS, PAYMENT_METHOD } from '@/lib/status'
import { dashboardOverview, timeseries } from '@/services/reports'
import type { OrderStatus } from '@/types/domain'

const QUICK_ACTIONS = [
  { label: 'New order', to: '/admin/orders/new', icon: <ClipboardList />, permission: 'orders.create' },
  { label: 'Add product', to: '/admin/products/new', icon: <PackagePlus />, permission: 'products.manage' },
  { label: 'Stock adjustment', to: '/admin/inventory/adjustments?new=1', icon: <Boxes />, permission: 'inventory.adjust' },
  { label: 'Add expense', to: '/admin/finance/expenses?new=1', icon: <TrendingDown />, permission: 'finance.manage' },
  { label: 'Add income', to: '/admin/finance/income?new=1', icon: <TrendingUp />, permission: 'finance.manage' },
  { label: 'Create purchase', to: '/admin/purchases/new', icon: <Truck />, permission: 'purchases.manage' },
  { label: 'Fraud review', to: '/admin/orders/fraud', icon: <ShieldAlert />, permission: 'fraud.view' },
  { label: 'Low stock', to: '/admin/inventory?status=LOW_STOCK', icon: <AlertTriangle />, permission: 'inventory.view' },
]

export default function DashboardPage() {
  const { can } = useAuth()
  const [range, setRange] = useState<DateRange>(() => rangeFor('30d'))
  const overview = useQuery({ queryKey: ['dashboard', range], queryFn: () => dashboardOverview(range.from, range.to) })
  const granularity = granularityFor(range)
  const series = useQuery({
    queryKey: ['dashboard', 'series', range, granularity],
    enabled: can('reports.view'),
    queryFn: () => timeseries(range.from, range.to, granularity),
  })
  useRealtimeInvalidate('finance_transactions', [['dashboard']], can('finance.view'))

  const d = overview.data
  const fin = d?.finance
  const actions = d?.action_items

  return (
    <div className="space-y-5">
      <PageHeader title="Dashboard" description="How the business is doing" actions={<DateRangeFilter value={range} onChange={setRange} />} />

      <div className="flex flex-wrap gap-2">
        {QUICK_ACTIONS.filter((a) => can(a.permission)).map((a) => (
          <Button key={a.to} variant="outline" size="sm" asChild><Link to={a.to}>{a.icon} {a.label}</Link></Button>
        ))}
      </div>

      {overview.error ? <ErrorState error={overview.error} onRetry={() => overview.refetch()} /> : !d ? <CardsSkeleton count={8} /> : (
        <>
          {actions && Object.values(actions).some((n) => n > 0) && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              {[
                { n: actions.fraud_review, label: 'Fraud review', to: '/admin/orders/fraud', icon: <ShieldAlert className="size-4 text-red-600" /> },
                { n: actions.advance_pending, label: 'Awaiting advance', to: '/admin/orders/fraud?tab=advance', icon: <Wallet className="size-4 text-amber-600" /> },
                { n: actions.payments_to_verify, label: 'Payments to verify', to: '/admin/orders/web?tab=all', icon: <CreditCard className="size-4 text-amber-600" /> },
                { n: actions.confirmation_required, label: 'Web orders to call', to: '/admin/orders/web', icon: <ShoppingCart className="size-4" /> },
                { n: actions.ready_to_ship, label: 'Ready to ship', to: '/admin/orders/approved?tab=RTS', icon: <Truck className="size-4" /> },
                { n: actions.production_overdue, label: 'Production overdue', to: '/admin/production', icon: <Factory className="size-4 text-red-600" /> },
              ].filter((a) => a.n > 0).map((a) => (
                <Link key={a.label} to={a.to} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm hover:bg-muted/50">
                  {a.icon}<span className="flex-1 truncate">{a.label}</span><Badge variant="secondary">{a.n}</Badge>
                </Link>
              ))}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Orders today" value={formatNumber(d.orders_today)} hint={`${formatNumber(d.orders_this_week)} this week · ${formatNumber(d.orders_this_month)} this month`} to="/admin/orders" />
            <StatCard label="Orders in period" value={formatNumber(d.orders)} hint={`Gross sales ${formatMoney(d.gross_sales)}`} />
            <StatCard label="Average order value" value={formatMoney(d.average_order_value)} />
            {fin ? (
              <StatCard label="Net profit" value={formatMoney(fin.net_profit)} tone={fin.net_profit >= 0 ? 'positive' : 'negative'}
                hint={`Revenue ${formatMoney(fin.revenue)} · Expenses ${formatMoney(fin.cogs + fin.operating_expenses)}`} to="/admin/finance/profit-loss" />
            ) : (
              <StatCard label="Delivered" value={formatNumber(d.delivered)} />
            )}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Cancellation rate" value={formatPercent(d.cancellation_rate)} tone={d.cancellation_rate > 15 ? 'warning' : undefined} />
            <StatCard label="Return rate" value={formatPercent(d.return_rate)} />
            <StatCard label="Failed delivery" value={formatPercent(d.failed_delivery_rate)} tone={d.failed_delivery_rate > 10 ? 'warning' : undefined} />
            <StatCard label="COD orders" value={formatPercent(d.cod_percentage)} />
            <StatCard label="Advance orders" value={formatPercent(d.advance_percentage)} />
            <StatCard label={d.conversion_rate !== null ? 'Conversion rate' : 'Fraud rejections'}
              value={d.conversion_rate !== null ? formatPercent(d.conversion_rate) : formatPercent(d.fraud_rejection_rate)}
              hint={d.conversion_rate !== null ? `${formatNumber(d.sessions)} sessions · fraud rejected ${formatPercent(d.fraud_rejection_rate)}` : undefined} />
          </div>

          {can('reports.view') && (
            <div className="grid gap-4 lg:grid-cols-2">
              <Card>
                <CardHeader><CardTitle className="text-sm">{fin ? 'Revenue, expenses & profit' : 'Gross sales'}</CardTitle></CardHeader>
                <CardContent>
                  <TrendChart data={series.data ?? []} xKey="bucket" format="money"
                    series={fin ? [{ key: 'revenue', label: 'Revenue', slot: 1 }, { key: 'expenses', label: 'Expenses', slot: 2 }, { key: 'profit', label: 'Profit', slot: 3 }]
                      : [{ key: 'gross_sales', label: 'Gross sales', slot: 1 }]} />
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle className="text-sm">Orders</CardTitle></CardHeader>
                <CardContent>
                  <BarsChart data={series.data ?? []} xKey="bucket" dateAxis stacked
                    series={[{ key: 'orders', label: 'Orders', slot: 1 }, { key: 'cancelled', label: 'Cancelled', slot: 2 }]} />
                </CardContent>
              </Card>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader><CardTitle className="text-sm">Order status</CardTitle></CardHeader>
              <CardContent>
                <ShareList items={Object.entries(d.status_distribution).map(([k, v]) => ({ label: ORDER_STATUS[k as OrderStatus]?.label ?? k, value: v }))} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Payment method</CardTitle></CardHeader>
              <CardContent>
                <ShareList items={Object.entries(d.payment_method_distribution).map(([k, v]) => ({ label: PAYMENT_METHOD[k as keyof typeof PAYMENT_METHOD] ?? k, value: v }))} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Low stock</CardTitle></CardHeader>
              <CardContent>
                {d.low_stock.length === 0 ? <p className="text-sm text-muted-foreground">All products are well stocked.</p> : (
                  <ul className="space-y-2 text-sm">
                    {d.low_stock.map((s) => (
                      <li key={s.variant_id} className="flex justify-between gap-2">
                        <Link to={`/admin/products/${s.product_id}`} className="truncate hover:underline">{s.product_name}{s.variant_title !== 'Default' ? ` · ${s.variant_title}` : ''}</Link>
                        <Badge variant={s.available <= 0 ? 'danger' : 'warning'}>{s.available}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm">Top products</CardTitle></CardHeader>
              <CardContent>
                {d.top_products.length === 0 ? <p className="text-sm text-muted-foreground">No sales in this period.</p> : (
                  <ul className="divide-y text-sm">
                    {d.top_products.map((p) => (
                      <li key={p.product_id} className="flex justify-between gap-3 py-2">
                        <Link to={`/admin/products/${p.product_id}`} className="truncate hover:underline">{p.product_name}</Link>
                        <span className="shrink-0 text-muted-foreground tabular-nums">{formatNumber(p.quantity)} sold · <Money value={p.revenue} /></span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Top customers</CardTitle></CardHeader>
              <CardContent>
                {d.top_customers.length === 0 ? <p className="text-sm text-muted-foreground">No orders in this period.</p> : (
                  <ul className="divide-y text-sm">
                    {d.top_customers.map((c) => (
                      <li key={c.customer_id} className="flex justify-between gap-3 py-2">
                        <Link to={`/admin/customers/${c.customer_id}`} className="truncate hover:underline">{c.customer_name} <span className="text-muted-foreground">{c.customer_phone}</span></Link>
                        <span className="shrink-0 text-muted-foreground tabular-nums">{c.orders} orders · <Money value={c.total} /></span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
          {can('orders.create') && (
            <Button variant="outline" className="sm:hidden" asChild><Link to="/admin/orders/new"><PlusCircle /> New order</Link></Button>
          )}
        </>
      )}
    </div>
  )
}
