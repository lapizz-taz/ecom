import { type UseQueryResult, useQuery } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, ErrorState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { MovementsTable } from '@/features/inventory/movements-table'
import { BarsChart, ShareList, TrendChart } from '@/features/reports/charts'
import { type ReportColumn, ReportTable } from '@/features/reports/report-table'
import { useDateRange } from '@/hooks/use-date-range'
import { useUrlState } from '@/hooks/use-url-state'
import { type DateRange, granularityFor } from '@/lib/dates'
import { formatDate, formatNumber, formatPercent, titleCase, toNumber } from '@/lib/format'
import { FRAUD_DECISION, ORDER_STATUS, PAYMENT_METHOD, PRODUCTION_STATUS, RISK_LEVEL, SEGMENT } from '@/lib/status'
import { cn } from '@/lib/utils'
import { listCategories } from '@/services/catalog'
import { listCouriers } from '@/services/couriers'
import { expensesByCategory, profitLoss } from '@/services/finance'
import { dashboardOverview, type ProductPerformanceRow, reports, timeseries } from '@/services/reports'
import type { OrderStatus, TimeseriesPoint } from '@/types/domain'

interface ReportDef {
  key: string
  label: string
  permission: string
  /** Point-in-time reports ignore the date range. */
  noRange?: boolean
  render: (range: DateRange) => ReactNode
}

const REPORTS: ReportDef[] = [
  { key: 'sales', label: 'Sales & revenue', permission: 'reports.view', render: (r) => <SalesReport range={r} /> },
  { key: 'orders', label: 'Order status', permission: 'reports.view', render: (r) => <OrderStatusReport range={r} /> },
  { key: 'products', label: 'Product profit', permission: 'reports.view', render: (r) => <ProductReport range={r} /> },
  { key: 'customers', label: 'Customers', permission: 'customers.view', render: (r) => <CustomerReport range={r} /> },
  { key: 'couriers', label: 'Courier performance', permission: 'couriers.view', render: (r) => <CourierReport range={r} /> },
  { key: 'returns', label: 'Returns & cancellations', permission: 'reports.view', render: (r) => <ReturnsReport range={r} /> },
  { key: 'fraud', label: 'Fraud', permission: 'fraud.view', render: (r) => <FraudReport range={r} /> },
  { key: 'advance', label: 'Advance payments', permission: 'finance.view', render: (r) => <AdvanceReport range={r} /> },
  { key: 'expenses', label: 'Expenses', permission: 'finance.view', render: (r) => <ExpenseReport range={r} /> },
  { key: 'pnl', label: 'Profit & loss', permission: 'finance.view', render: (r) => <PnlReport range={r} /> },
  { key: 'inventory', label: 'Inventory valuation', permission: 'inventory.view', noRange: true, render: () => <InventoryReport /> },
  { key: 'movements', label: 'Stock movements', permission: 'inventory.view', noRange: true, render: () => <MovementsTable title="Stock movements" /> },
  { key: 'production', label: 'Production', permission: 'production.view', render: (r) => <ProductionReport range={r} /> },
]

export default function ReportsPage() {
  const { can } = useAuth()
  const [state, update] = useUrlState({ report: 'sales' })
  const [range, setRange] = useDateRange('30d')
  const available = REPORTS.filter((r) => can(r.permission) || can('reports.view'))
  const active = available.find((r) => r.key === state.report) ?? available[0]

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reports"
        description={<span className="print:hidden">Every figure comes straight from the database. Export any table to CSV, or print / save as PDF.</span>}
        actions={<Button size="sm" variant="outline" className="no-print" onClick={() => window.print()}><Printer /> Print / PDF</Button>}
      />
      <div className="grid gap-4 lg:grid-cols-[13rem_1fr]">
        <nav className="no-print">
          <div className="lg:hidden">
            <Select value={active?.key} onValueChange={(v) => update({ report: v })}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>{available.map((r) => <SelectItem key={r.key} value={r.key}>{r.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
          <ul className="hidden space-y-0.5 lg:block">
            {available.map((r) => (
              <li key={r.key}>
                <button type="button" onClick={() => update({ report: r.key })}
                  className={cn('w-full rounded-md px-3 py-1.5 text-left text-sm hover:bg-muted', r.key === active?.key && 'bg-muted font-medium')}>
                  {r.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-lg font-semibold">{active?.label}</h2>
            {active && !active.noRange && <div className="no-print"><DateRangeFilter value={range} onChange={setRange} /></div>}
            {active && !active.noRange && <p className="hidden text-sm print:block">{formatDate(range.from)} – {formatDate(range.to)}</p>}
          </div>
          {active?.render(range)}
        </div>
      </div>
    </div>
  )
}

/** Loading / error wrapper so each report only deals with data. */
function Loaded<T>({ query, children, skeleton = 4 }: { query: UseQueryResult<T>; children: (data: T) => ReactNode; skeleton?: number }) {
  if (query.error) return <ErrorState error={query.error} onRetry={() => query.refetch()} />
  if (query.data === undefined) return <CardsSkeleton count={skeleton} />
  return <>{children(query.data)}</>
}

function Stats({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{children}</div>
}

function ChartCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="break-inside-avoid">
      <CardHeader><CardTitle className="text-sm">{title}</CardTitle></CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  )
}

const slug = (range: DateRange) => `${range.from}-to-${range.to}`
const entries = (record: Record<string, number> | undefined, label: (k: string) => string = titleCase) =>
  Object.entries(record ?? {}).map(([k, v]) => ({ label: label(k), value: toNumber(v) }))

// ---------------------------------------------------------------------------
// Sales & revenue
// ---------------------------------------------------------------------------
function SalesReport({ range }: { range: DateRange }) {
  const { can } = useAuth()
  const [f, update] = useUrlState({ category_id: '', source: '', payment_method: '', courier_id: '', district: '' })
  const granularity = granularityFor(range)
  const filters = Object.fromEntries(Object.entries(f).filter(([, v]) => v)) as Record<string, string>
  const series = useQuery({ queryKey: ['reports', 'sales', range, granularity, filters], queryFn: () => timeseries(range.from, range.to, granularity, filters) })
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers(), enabled: can('couriers.view') })
  const finance = can('finance.view')

  const columns: ReportColumn<TimeseriesPoint>[] = [
    { header: granularity === 'day' ? 'Date' : granularity === 'week' ? 'Week of' : 'Month', value: (p) => p.bucket, cell: (p) => formatDate(p.bucket) },
    { header: 'Orders', value: (p) => p.orders, format: 'number' },
    { header: 'Gross sales', value: (p) => p.gross_sales, format: 'money' },
    { header: 'Cancelled', value: (p) => p.cancelled, format: 'number' },
    { header: 'Returned', value: (p) => p.returned, format: 'number' },
    { header: 'Failed', value: (p) => p.failed, format: 'number' },
    { header: 'New customers', value: (p) => p.new_customers, format: 'number' },
    ...(finance ? [
      { header: 'Net revenue', value: (p: TimeseriesPoint) => p.revenue, format: 'money' as const },
      { header: 'Expenses', value: (p: TimeseriesPoint) => p.expenses, format: 'money' as const },
      { header: 'Profit', value: (p: TimeseriesPoint) => p.profit, format: 'money' as const },
    ] : []),
  ]

  return (
    <div className="space-y-4">
      <div className="no-print flex flex-wrap gap-2">
        <FilterSelect value={f.category_id} onChange={(v) => update({ category_id: v })} all="All categories"
          options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
        <FilterSelect value={f.source} onChange={(v) => update({ source: v })} all="All channels"
          options={[{ value: 'STOREFRONT', label: 'Storefront' }, { value: 'ADMIN', label: 'Admin / phone' }, { value: 'IMPORT', label: 'Import' }, { value: 'API', label: 'API' }]} />
        <FilterSelect value={f.payment_method} onChange={(v) => update({ payment_method: v })} all="All payment methods"
          options={Object.entries(PAYMENT_METHOD).map(([value, label]) => ({ value, label }))} />
        {can('couriers.view') && <FilterSelect value={f.courier_id} onChange={(v) => update({ courier_id: v })} all="All couriers"
          options={(couriers.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />}
        <Input className="h-8 w-40" placeholder="District" defaultValue={f.district} onBlur={(e) => update({ district: e.target.value.trim() })}
          onKeyDown={(e) => e.key === 'Enter' && update({ district: (e.target as HTMLInputElement).value.trim() })} aria-label="District" />
      </div>
      <Loaded query={series}>
        {(points) => {
          const sum = (k: keyof TimeseriesPoint) => points.reduce((s, p) => s + toNumber(p[k]), 0)
          const revenue = sum('revenue')
          return (
            <>
              <Stats>
                <StatCard label="Orders" value={formatNumber(sum('orders'))} hint={`${formatNumber(sum('cancelled'))} cancelled`} />
                <StatCard label="Gross sales" value={<Money value={sum('gross_sales')} />} hint="excl. cancelled & rejected" />
                <StatCard label="New customers" value={formatNumber(sum('new_customers'))} />
                <StatCard label="Returned / failed" value={`${formatNumber(sum('returned'))} / ${formatNumber(sum('failed'))}`} />
                {finance && (
                  <>
                    <StatCard label="Net revenue" value={<Money value={revenue} />} hint="delivered orders, after refunds" />
                    <StatCard label="Expenses" value={<Money value={sum('expenses')} />} hint="COGS + operating" />
                    <StatCard label="Profit" value={<Money value={sum('profit')} />} tone={sum('profit') < 0 ? 'negative' : 'positive'} />
                    <StatCard label="Profit margin" value={revenue > 0 ? formatPercent((sum('profit') / revenue) * 100) : '—'} />
                  </>
                )}
              </Stats>
              {Object.keys(filters).length > 0 && finance && <p className="text-xs text-muted-foreground">Order filters apply to order counts and sales; revenue, expenses and profit are always store-wide.</p>}
              <div className="grid gap-4 xl:grid-cols-2">
                <ChartCard title={finance ? 'Gross sales vs net revenue' : 'Gross sales'}>
                  <TrendChart data={points} xKey="bucket" format="money"
                    series={[{ key: 'gross_sales', label: 'Gross sales', slot: 1 }, ...(finance ? [{ key: 'revenue', label: 'Net revenue', slot: 2 }] : [])]} />
                </ChartCard>
                <ChartCard title="Orders">
                  <BarsChart data={points} xKey="bucket" dateAxis series={[{ key: 'orders', label: 'Orders', slot: 1 }]} />
                </ChartCard>
              </div>
              <ReportTable title="By period" rows={points} columns={columns} filename={`sales-${slug(range)}`} maxHeight={480} />
            </>
          )
        }}
      </Loaded>
    </div>
  )
}

function FilterSelect({ value, onChange, all, options }: { value: string; onChange: (v: string) => void; all: string; options: Array<{ value: string; label: string }> }) {
  return (
    <Select value={value || 'all'} onValueChange={(v) => onChange(v === 'all' ? '' : v)}>
      <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{all}</SelectItem>
        {options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
      </SelectContent>
    </Select>
  )
}

// ---------------------------------------------------------------------------
// Order status
// ---------------------------------------------------------------------------
function OrderStatusReport({ range }: { range: DateRange }) {
  const overview = useQuery({ queryKey: ['reports', 'overview', range], queryFn: () => dashboardOverview(range.from, range.to) })
  return (
    <Loaded query={overview}>
      {(d) => {
        const statuses = Object.entries(d.status_distribution).map(([status, n]) => ({ status: status as OrderStatus, orders: toNumber(n) }))
          .sort((a, b) => b.orders - a.orders)
        return (
          <div className="space-y-4">
            <Stats>
              <StatCard label="Orders" value={formatNumber(d.orders)} hint={`${formatNumber(d.storefront_orders)} from the storefront`} />
              <StatCard label="Delivered" value={formatNumber(d.delivered)} hint={`${formatNumber(d.shipped)} shipped`} />
              <StatCard label="Cancellation rate" value={formatPercent(d.cancellation_rate)} hint={`${formatNumber(d.cancelled)} cancelled`} />
              <StatCard label="Return rate" value={formatPercent(d.return_rate)} hint={`${formatNumber(d.returned)} returned after delivery`} />
              <StatCard label="Failed delivery rate" value={formatPercent(d.failed_delivery_rate)} hint={`${formatNumber(d.failed)} failed`} />
              <StatCard label="Fraud rejection rate" value={formatPercent(d.fraud_rejection_rate)} hint={`${formatNumber(d.rejected_fraud)} rejected`} />
              <StatCard label="COD orders" value={formatPercent(d.cod_percentage)} hint={`${formatNumber(d.cod_orders)} orders`} />
              <StatCard label="Advance orders" value={formatPercent(d.advance_percentage)} hint={`${formatNumber(d.advance_orders)} orders`} />
            </Stats>
            <div className="grid gap-4 xl:grid-cols-2">
              <ReportTable title="Orders by current status" rows={statuses} filename={`order-status-${slug(range)}`} columns={[
                { header: 'Status', value: (r) => ORDER_STATUS[r.status]?.label ?? r.status, cell: (r) => <StatusBadge value={r.status} map={ORDER_STATUS} /> },
                { header: 'Orders', value: (r) => r.orders, format: 'number' },
                { header: 'Share', value: (r) => (d.orders ? (r.orders / d.orders) * 100 : 0), format: 'percent' },
              ]} />
              <ChartCard title="Payment methods">
                <ShareList items={entries(d.payment_method_distribution, (k) => PAYMENT_METHOD[k as keyof typeof PAYMENT_METHOD] ?? k)} />
              </ChartCard>
            </div>
          </div>
        )
      }}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Product profit
// ---------------------------------------------------------------------------
function ProductReport({ range }: { range: DateRange }) {
  const { can } = useAuth()
  const [f, update] = useUrlState({ category_id: '' })
  const categories = useQuery({ queryKey: ['categories'], queryFn: listCategories })
  const filters: Record<string, string> = f.category_id ? { category_id: f.category_id } : {}
  const rows = useQuery({ queryKey: ['reports', 'products', range, filters], queryFn: () => reports.productPerformance(range.from, range.to, filters) })
  const finance = can('finance.view')
  const columns: ReportColumn<ProductPerformanceRow>[] = [
    { header: 'Product', value: (r) => r.product_name, cell: (r) => <Link to={`/admin/products/${r.product_id}`} className="hover:underline">{r.product_name}</Link> },
    { header: 'Category', value: (r) => r.category_name ?? '' },
    { header: 'Ordered', value: (r) => r.ordered_qty, format: 'number' },
    { header: 'Sold', value: (r) => r.sold_qty, format: 'number' },
    { header: 'Returned', value: (r) => r.returned_qty, format: 'number' },
    { header: 'Revenue', value: (r) => r.revenue, format: 'money' },
    ...(finance ? [
      { header: 'Cost', value: (r: ProductPerformanceRow) => r.cogs, format: 'money' as const },
      { header: 'Gross profit', value: (r: ProductPerformanceRow) => r.gross_profit, format: 'money' as const },
      { header: 'Margin', value: (r: ProductPerformanceRow) => r.margin_pct, format: 'percent' as const },
    ] : []),
  ]
  return (
    <div className="space-y-4">
      <div className="no-print">
        <FilterSelect value={f.category_id} onChange={(v) => update({ category_id: v })} all="All categories"
          options={(categories.data ?? []).map((c) => ({ value: c.id, label: c.name }))} />
      </div>
      <Loaded query={rows} skeleton={2}>
        {(data) => (
          <>
            <ChartCard title={finance ? 'Top products by gross profit' : 'Top products by revenue'}>
              <BarsChart horizontal format="money" height={Math.max(160, Math.min(data.length, 10) * 34)}
                data={[...data].sort((a, b) => toNumber(finance ? b.gross_profit : b.revenue) - toNumber(finance ? a.gross_profit : a.revenue)).slice(0, 10)
                  .map((r) => ({ name: r.product_name.length > 18 ? `${r.product_name.slice(0, 17)}…` : r.product_name, value: toNumber(finance ? r.gross_profit : r.revenue) }))}
                xKey="name" series={[{ key: 'value', label: finance ? 'Gross profit' : 'Revenue', slot: 1 }]} />
            </ChartCard>
            <ReportTable title="All products" description="Revenue and cost count delivered orders only, net of returns." rows={data} columns={columns}
              filename={`product-profit-${slug(range)}`} maxHeight={560} />
          </>
        )}
      </Loaded>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------
function CustomerReport({ range }: { range: DateRange }) {
  const data = useQuery({ queryKey: ['reports', 'customers', range], queryFn: () => reports.customers(range.from, range.to) })
  return (
    <Loaded query={data}>
      {(d) => {
        type Top = typeof d.top_customers[number]
        type District = typeof d.by_district[number]
        return (
          <div className="space-y-4">
            <Stats>
              <StatCard label="New customers" value={formatNumber(d.new_customers)} />
              <StatCard label="Repeat customers" value={formatNumber(d.repeat_customers)} hint="ordered more than once in the period" />
              <StatCard label="VIP customers" value={formatNumber(d.segments.VIP ?? 0)} />
              <StatCard label="High risk / blocked" value={`${formatNumber(d.segments.HIGH_RISK ?? 0)} / ${formatNumber(d.segments.BLOCKED ?? 0)}`} />
            </Stats>
            <div className="grid gap-4 xl:grid-cols-3">
              <ChartCard title="Customer segments (all customers)">
                <ShareList items={entries(d.segments, (k) => SEGMENT[k as keyof typeof SEGMENT]?.label ?? k)} />
              </ChartCard>
              <div className="xl:col-span-2">
                <ReportTable<District> title="By district" rows={d.by_district} filename={`customers-by-district-${slug(range)}`} maxHeight={360} columns={[
                  { header: 'District', value: (r) => r.district },
                  { header: 'Customers', value: (r) => r.customers, format: 'number' },
                  { header: 'Orders', value: (r) => r.orders, format: 'number' },
                  { header: 'Delivered value', value: (r) => r.delivered_value, format: 'money' },
                ]} />
              </div>
            </div>
            <ReportTable<Top> title="Top customers" rows={d.top_customers} filename={`top-customers-${slug(range)}`} maxHeight={560} columns={[
              { header: 'Customer', value: (r) => r.full_name, cell: (r) => <Link to={`/admin/customers/${r.id}`} className="hover:underline">{r.full_name}</Link> },
              { header: 'Phone', value: (r) => r.phone },
              { header: 'Segment', value: (r) => r.segment, cell: (r) => <StatusBadge value={r.segment as keyof typeof SEGMENT} map={SEGMENT} /> },
              { header: 'District', value: (r) => r.district ?? '' },
              { header: 'Orders', value: (r) => r.orders, format: 'number' },
              { header: 'Delivered value', value: (r) => r.delivered_value, format: 'money' },
              { header: 'Cancelled', value: (r) => r.cancelled, format: 'number' },
              { header: 'Returned / failed', value: (r) => r.returned_or_failed, format: 'number' },
            ]} />
          </div>
        )
      }}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Couriers
// ---------------------------------------------------------------------------
function CourierReport({ range }: { range: DateRange }) {
  const data = useQuery({ queryKey: ['reports', 'couriers', range], queryFn: () => reports.couriers(range.from, range.to) })
  return (
    <Loaded query={data}>
      {(rows) => {
        type Row = typeof rows[number]
        return (
          <div className="space-y-4">
            <ChartCard title="Delivery success rate">
              <BarsChart horizontal format="percent" height={Math.max(140, rows.length * 40)} xKey="name"
                data={rows.map((r) => ({ name: r.courier_name, rate: toNumber(r.success_rate) }))} series={[{ key: 'rate', label: 'Success rate', slot: 1 }]} />
            </ChartCard>
            <ReportTable<Row> title="Courier performance" rows={rows} filename={`couriers-${slug(range)}`} columns={[
              { header: 'Courier', value: (r) => r.courier_name },
              { header: 'Shipments', value: (r) => r.shipments, format: 'number' },
              { header: 'Delivered', value: (r) => r.delivered, format: 'number' },
              { header: 'Failed / returned', value: (r) => r.failed_or_returned, format: 'number' },
              { header: 'In transit', value: (r) => r.in_transit, format: 'number' },
              { header: 'Success rate', value: (r) => r.success_rate, format: 'percent' },
              { header: 'Avg. delivery (h)', value: (r) => (r.avg_delivery_hours === null ? null : Math.round(r.avg_delivery_hours)), format: 'number' },
              { header: 'Avg. charge', value: (r) => r.avg_shipping_cost, format: 'money' },
              { header: 'Total charges', value: (r) => r.total_shipping_cost, format: 'money' },
              { header: 'Return charges', value: (r) => r.total_return_charges, format: 'money' },
              { header: 'COD collected', value: (r) => r.cod_collected, format: 'money' },
              { header: 'COD pending', value: (r) => r.cod_pending, format: 'money' },
            ]} />
          </div>
        )
      }}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Returns & cancellations
// ---------------------------------------------------------------------------
function ReturnsReport({ range }: { range: DateRange }) {
  const data = useQuery({ queryKey: ['reports', 'returns', range], queryFn: () => reports.cancellationsReturns(range.from, range.to) })
  return (
    <Loaded query={data}>
      {(d) => {
        type Reason = typeof d.cancel_reasons[number]
        type Product = typeof d.returned_products[number]
        type District = typeof d.by_district[number]
        return (
          <div className="space-y-4">
            <div className="grid gap-4 xl:grid-cols-2">
              <ReportTable<Reason> title="Cancellation reasons" rows={d.cancel_reasons} filename={`cancel-reasons-${slug(range)}`} columns={[
                { header: 'Reason', value: (r) => r.reason },
                { header: 'Orders', value: (r) => r.orders, format: 'number' },
                { header: 'Value', value: (r) => r.value, format: 'money' },
              ]} />
              <ReportTable<Product> title="Returned products" rows={d.returned_products} filename={`returned-products-${slug(range)}`} columns={[
                { header: 'Product', value: (r) => r.product_name },
                { header: 'Restocked', value: (r) => r.restocked, format: 'number' },
                { header: 'Damaged', value: (r) => r.damaged, format: 'number' },
              ]} />
            </div>
            <ReportTable<District> title="By district" rows={d.by_district} filename={`returns-by-district-${slug(range)}`} maxHeight={480} columns={[
              { header: 'District', value: (r) => r.district },
              { header: 'Orders', value: (r) => r.orders, format: 'number' },
              { header: 'Cancelled', value: (r) => r.cancelled, format: 'number' },
              { header: 'Returned / failed', value: (r) => r.returned_or_failed, format: 'number' },
              { header: 'Problem rate', value: (r) => (r.orders ? ((r.cancelled + r.returned_or_failed) / r.orders) * 100 : 0), format: 'percent' },
            ]} />
          </div>
        )
      }}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Fraud
// ---------------------------------------------------------------------------
function FraudReport({ range }: { range: DateRange }) {
  const data = useQuery({ queryKey: ['reports', 'fraud', range], queryFn: () => reports.fraud(range.from, range.to) })
  return (
    <Loaded query={data}>
      {(d) => {
        type Outcome = typeof d.outcomes_by_risk[number]
        return (
          <div className="space-y-4">
            <Stats>
              <StatCard label="Fraud checks" value={formatNumber(d.checks)} />
              <StatCard label="Provider errors" value={formatNumber(d.provider_errors)} tone={d.provider_errors > 0 ? 'warning' : 'default'} hint="checks that fell back to internal rules" />
              <StatCard label="Rejected order value" value={<Money value={d.rejected_value} />} hint="blocked before shipping" />
              <StatCard label="Manual reviews" value={formatNumber(Object.values(d.reviews ?? {}).reduce((s, n) => s + toNumber(n), 0))} />
            </Stats>
            <div className="grid gap-4 xl:grid-cols-3">
              <ChartCard title="Decisions"><ShareList items={entries(d.decisions, (k) => FRAUD_DECISION[k as keyof typeof FRAUD_DECISION]?.label ?? k)} /></ChartCard>
              <ChartCard title="Risk levels"><ShareList items={entries(d.risk_levels, (k) => RISK_LEVEL[k as keyof typeof RISK_LEVEL]?.label ?? k)} /></ChartCard>
              <ChartCard title="Review outcomes"><ShareList items={entries(d.reviews)} /></ChartCard>
            </div>
            <ReportTable<Outcome> title="What happened to orders, by risk level" rows={d.outcomes_by_risk} filename={`fraud-outcomes-${slug(range)}`}
              description="Use this to tune thresholds: high delivery rates on high-risk orders mean the rules are too strict." columns={[
                { header: 'Risk level', value: (r) => r.risk_level, cell: (r) => <StatusBadge value={r.risk_level as keyof typeof RISK_LEVEL} map={RISK_LEVEL} /> },
                { header: 'Orders', value: (r) => r.orders, format: 'number' },
                { header: 'Delivered', value: (r) => r.delivered, format: 'number' },
                { header: 'Cancelled / rejected', value: (r) => r.cancelled_or_rejected, format: 'number' },
                { header: 'Failed delivery', value: (r) => r.failed, format: 'number' },
                { header: 'Delivery rate', value: (r) => (r.orders ? (r.delivered / r.orders) * 100 : null), format: 'percent' },
              ]} />
          </div>
        )
      }}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Advance payments
// ---------------------------------------------------------------------------
function AdvanceReport({ range }: { range: DateRange }) {
  const data = useQuery({ queryKey: ['reports', 'advance', range], queryFn: () => reports.advancePayments(range.from, range.to) })
  return (
    <Loaded query={data}>
      {(d) => (
        <div className="space-y-4">
          <Stats>
            <StatCard label="Orders asked for advance" value={formatNumber(d.orders_requiring_advance)} hint={<>total <Money value={d.advance_required_total} /></>} />
            <StatCard label="Paid" value={formatNumber(d.orders_paid)} hint={<><Money value={d.advance_collected} /> collected</>} />
            <StatCard label="Payment rate" value={formatPercent(d.payment_rate)} />
            <StatCard label="Delivered after advance" value={formatNumber(d.delivered_after_advance)} />
            <StatCard label="Awaiting payment" value={formatNumber(d.awaiting_payment)} to="/admin/orders/fraud?tab=advance" />
            <StatCard label="Expired unpaid" value={formatNumber(d.expired_unpaid)} hint="cancelled after the payment window" />
          </Stats>
          <ChartCard title="Advance collected by channel">
            <ShareList format="money" items={entries(d.by_channel)} />
          </ChartCard>
        </div>
      )}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Expenses
// ---------------------------------------------------------------------------
function ExpenseReport({ range }: { range: DateRange }) {
  const data = useQuery({ queryKey: ['reports', 'expenses', range], queryFn: () => expensesByCategory(range.from, range.to) })
  return (
    <Loaded query={data} skeleton={2}>
      {(rows) => {
        const total = rows.reduce((s, r) => s + toNumber(r.amount), 0)
        type Row = typeof rows[number]
        return (
          <div className="space-y-4">
            <Stats>
              <StatCard label="Total spent" value={<Money value={total} />} hint="all expense categories, incl. stock purchases" to={`/admin/finance/expenses?from=${range.from}&to=${range.to}`} />
            </Stats>
            <ChartCard title="By category">
              <BarsChart horizontal format="money" height={Math.max(140, rows.length * 32)} xKey="name"
                data={rows.filter((r) => toNumber(r.amount) !== 0).map((r) => ({ name: r.name, amount: toNumber(r.amount) }))} series={[{ key: 'amount', label: 'Amount', slot: 1 }]} />
            </ChartCard>
            <ReportTable<Row> title="Expenses by category" rows={rows} filename={`expenses-${slug(range)}`} columns={[
              { header: 'Category', value: (r) => r.name },
              { header: 'P&L group', value: (r) => titleCase(r.pnl_group === 'NONE' ? 'cash only' : r.pnl_group) },
              { header: 'Amount', value: (r) => r.amount, format: 'money' },
              { header: 'Share', value: (r) => (total ? (toNumber(r.amount) / total) * 100 : 0), format: 'percent' },
            ]} />
          </div>
        )
      }}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Profit & loss summary
// ---------------------------------------------------------------------------
function PnlReport({ range }: { range: DateRange }) {
  const granularity = granularityFor(range)
  const pl = useQuery({ queryKey: ['reports', 'pnl', range], queryFn: () => profitLoss(range.from, range.to) })
  const series = useQuery({ queryKey: ['reports', 'sales', range, granularity, {}], queryFn: () => timeseries(range.from, range.to, granularity) })
  return (
    <Loaded query={pl}>
      {(p) => (
        <div className="space-y-4">
          <Stats>
            <StatCard label="Net revenue" value={<Money value={p.net_revenue} />} />
            <StatCard label="Gross profit" value={<Money value={p.gross_profit} />} hint={`${formatPercent(p.gross_margin_pct)} margin`} />
            <StatCard label="Operating expenses" value={<Money value={p.operating_expenses} />} />
            <StatCard label="Net profit" value={<Money value={p.net_profit} />} tone={toNumber(p.net_profit) < 0 ? 'negative' : 'positive'} />
          </Stats>
          <ChartCard title="Revenue, expenses and profit">
            {series.data ? (
              <TrendChart data={series.data} xKey="bucket" format="money" series={[
                { key: 'revenue', label: 'Net revenue', slot: 1 }, { key: 'expenses', label: 'Expenses', slot: 2 }, { key: 'profit', label: 'Profit', slot: 3 },
              ]} />
            ) : <CardsSkeleton count={1} />}
          </ChartCard>
          <Button variant="outline" size="sm" asChild className="no-print">
            <Link to={`/admin/finance/profit-loss?from=${range.from}&to=${range.to}`}>Open the full statement</Link>
          </Button>
        </div>
      )}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Inventory valuation (point in time)
// ---------------------------------------------------------------------------
function InventoryReport() {
  const data = useQuery({ queryKey: ['reports', 'inventory-valuation'], queryFn: () => reports.inventoryValuation() })
  return (
    <Loaded query={data}>
      {(d) => {
        type Cat = typeof d.by_category[number]
        type Item = typeof d.items[number]
        const t = d.totals
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">Stock on hand right now, valued at average cost and at selling price.</p>
            <Stats>
              <StatCard label="Value at cost" value={<Money value={t.value_at_cost} />} />
              <StatCard label="Value at retail" value={<Money value={t.value_at_retail} />} hint={<>potential margin <Money value={toNumber(t.value_at_retail) - toNumber(t.value_at_cost)} /></>} />
              <StatCard label="Units on hand" value={formatNumber(t.units_on_hand)} hint={`${formatNumber(t.units_reserved)} reserved for orders`} />
              <StatCard label="Damaged stock" value={<Money value={t.damaged_value} />} hint={`${formatNumber(t.units_damaged)} units`} tone={t.units_damaged > 0 ? 'warning' : 'default'} />
              <StatCard label="Low stock variants" value={formatNumber(t.low_stock_variants)} to="/admin/inventory?status=LOW_STOCK" />
              <StatCard label="Out of stock variants" value={formatNumber(t.out_of_stock_variants)} to="/admin/inventory?status=OUT_OF_STOCK" />
            </Stats>
            <ReportTable<Cat> title="By category" rows={d.by_category} filename="inventory-by-category" columns={[
              { header: 'Category', value: (r) => r.category },
              { header: 'Units', value: (r) => r.units, format: 'number' },
              { header: 'Value at cost', value: (r) => r.value_at_cost, format: 'money' },
              { header: 'Value at retail', value: (r) => r.value_at_retail, format: 'money' },
            ]} />
            <ReportTable<Item> title="By SKU" rows={d.items} filename="inventory-valuation" maxHeight={600} columns={[
              { header: 'Product', value: (r) => r.product_name },
              { header: 'Variant', value: (r) => (r.variant_title === 'Default' ? '' : r.variant_title) },
              { header: 'SKU', value: (r) => r.sku },
              { header: 'On hand', value: (r) => r.on_hand, format: 'number' },
              { header: 'Reserved', value: (r) => r.reserved, format: 'number' },
              { header: 'Available', value: (r) => r.available, format: 'number' },
              { header: 'Damaged', value: (r) => r.damaged, format: 'number' },
              { header: 'Unit cost', value: (r) => r.unit_cost, format: 'money' },
              { header: 'Value at cost', value: (r) => r.value_at_cost, format: 'money' },
              { header: 'Status', value: (r) => titleCase(r.stock_status) },
            ]} />
          </div>
        )
      }}
    </Loaded>
  )
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------
function ProductionReport({ range }: { range: DateRange }) {
  const data = useQuery({ queryKey: ['reports', 'production', range], queryFn: () => reports.production(range.from, range.to) })
  return (
    <Loaded query={data}>
      {(d) => {
        type Assignee = typeof d.by_assignee[number]
        return (
          <div className="space-y-4">
            <Stats>
              <StatCard label="Jobs created" value={formatNumber(d.created)} />
              <StatCard label="Completed" value={formatNumber(d.completed)} hint={d.avg_cycle_hours === null ? undefined : `avg. ${formatNumber(d.avg_cycle_hours, 1)} h from start to done`} />
              <StatCard label="In progress" value={formatNumber(d.in_progress)} />
              <StatCard label="Overdue" value={formatNumber(d.overdue)} tone={d.overdue > 0 ? 'negative' : 'default'} to="/admin/production" />
              <StatCard label="QC rejections" value={formatNumber(d.qc_rejections)} tone={d.qc_rejections > 0 ? 'warning' : 'default'} />
              <StatCard label="Cancelled" value={formatNumber(d.cancelled)} />
            </Stats>
            <div className="grid gap-4 xl:grid-cols-2">
              <ChartCard title="By status"><ShareList items={entries(d.by_status, (k) => PRODUCTION_STATUS[k as keyof typeof PRODUCTION_STATUS]?.label ?? k)} /></ChartCard>
              <ReportTable<Assignee> title="By assignee" rows={d.by_assignee} filename={`production-by-assignee-${slug(range)}`} columns={[
                { header: 'Assignee', value: (r) => r.assignee },
                { header: 'Jobs', value: (r) => r.orders, format: 'number' },
                { header: 'Completed', value: (r) => r.completed, format: 'number' },
              ]} />
            </div>
          </div>
        )
      }}
    </Loaded>
  )
}
