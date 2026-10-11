import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Calculator, Download, History, Printer, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { PnlStatement } from '@/features/finance/pnl-statement'
import { allocation, CERTAINTY, type Certainty, calculationRows, type CalcRow } from '@/features/finance/order-financials'
import { BarsChart, TrendChart } from '@/features/reports/charts'
import { useDateRange } from '@/hooks/use-date-range'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { type DateRange, RANGE_PRESETS, rangeFor } from '@/lib/dates'
import { formatDate, formatDateTime, formatMoney, formatNumber, formatPercent, toNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  type FinancialOrderRow, type FinancialsBasis, type OrderFinancials,
  orderFinancials, orderFinancialsOrders, rebuildCost, recalculateOrders,
} from '@/services/finance'

const QUICK = ['today', 'yesterday', '7d', '30d', 'month'] as const
const BASIS: Array<{ value: FinancialsBasis; label: string; hint: string }> = [
  { value: 'delivered', label: 'Delivered date', hint: 'Sales and their costs count on the day the order was delivered — same as the statement.' },
  { value: 'approved', label: 'Approved date', hint: 'Delivered orders grouped by the day they were approved; overheads and ads by their own date.' },
  { value: 'created', label: 'Order date', hint: 'Delivered orders grouped by the day they were placed; overheads and ads by their own date.' },
]
const PLATFORM: Record<string, string> = { SHOPIFY: 'Shopify', WOOCOMMERCE: 'WooCommerce', OWN: 'Own' }
const PART_COLOR: Record<string, string> = {
  profit: 'bg-emerald-500', product_cost: 'bg-sky-500', delivery_cost: 'bg-violet-500', ads: 'bg-amber-500', other: 'bg-slate-400',
}

export default function OrderFinancialsPage() {
  const { can } = useAuth()
  const qc = useQueryClient()
  const [range, setRange] = useDateRange('30d')
  const [state, update] = useUrlState({ tab: 'summary', basis: 'delivered' })
  const basis = (BASIS.some((b) => b.value === state.basis) ? state.basis : 'delivered') as FinancialsBasis
  const [rebuildOpen, setRebuildOpen] = useState(false)
  const report = useQuery({ queryKey: ['finance', 'order-financials', range, basis], queryFn: () => orderFinancials(range.from, range.to, basis) })

  const recalc = useMutation({
    mutationFn: () => recalculateOrders(range.from, range.to),
    onSuccess: (r) => {
      toast.success(r.orders ? `Added ${r.orders} delivered order${r.orders === 1 ? '' : 's'} to the books` : 'Everything delivered is already in the books')
      qc.invalidateQueries({ queryKey: ['finance'] })
    },
    onError: (e) => toast.error(e),
  })

  return (
    <div className="space-y-4">
      <PageHeader
        title="Order financials"
        description="Sales, costs and profit of your orders, from your books. Amounts that are estimated or not available are marked."
        className="no-print"
        actions={
          <>
            {can('finance.manage') && (
              <Button size="sm" variant="outline" onClick={() => recalc.mutate()} disabled={recalc.isPending}
                title="Adds delivered orders that are missing from the books (nothing is posted twice)">
                {recalc.isPending ? <Spinner /> : <RefreshCw />} Recalculate
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => setRebuildOpen(true)} title="Fill product costs that were missing when orders were delivered">
              <History /> Rebuild historical cost
            </Button>
            <Button size="sm" variant="outline" onClick={() => window.print()} disabled={!report.data} aria-label="Print"><Printer /></Button>
          </>
        }
      />

      <div className="no-print flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {QUICK.map((k) => {
            const r = rangeFor(k)
            const active = r.from === range.from && r.to === range.to
            return (
              <Button key={k} size="sm" variant={active ? 'default' : 'outline'} className="h-8" onClick={() => setRange(r)}>
                {k === '7d' ? '7D' : k === '30d' ? '30D' : RANGE_PRESETS.find((p) => p.key === k)?.label}
              </Button>
            )
          })}
        </div>
        <DateRangeFilter value={range} onChange={setRange} />
        <Select value={basis} onValueChange={(v) => update({ basis: v })}>
          <SelectTrigger size="sm" className="w-40" aria-label="Date basis"><SelectValue /></SelectTrigger>
          <SelectContent>{BASIS.map((b) => <SelectItem key={b.value} value={b.value}>{b.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <p className="no-print -mt-2 text-xs text-muted-foreground">{BASIS.find((b) => b.value === basis)?.hint}</p>

      <Tabs value={state.tab} onValueChange={(v) => update({ tab: v })}>
        <div className="no-print overflow-x-auto">
          <TabsList>
            <TabsTrigger value="summary">Summary</TabsTrigger>
            <TabsTrigger value="sales">Sales</TabsTrigger>
            <TabsTrigger value="expenses">Expenses</TabsTrigger>
            <TabsTrigger value="channels">Channel profit</TabsTrigger>
            <TabsTrigger value="orders">Delivered orders</TabsTrigger>
            <TabsTrigger value="chart">Profit &amp; sales chart</TabsTrigger>
            <TabsTrigger value="statement">Statement</TabsTrigger>
          </TabsList>
        </div>

        {state.tab === 'statement' ? (
          <TabsContent value="statement"><PnlStatement range={range} /></TabsContent>
        ) : state.tab === 'orders' ? (
          <TabsContent value="orders"><DeliveredOrders range={range} basis={basis} /></TabsContent>
        ) : report.error ? (
          <ErrorState error={report.error} onRetry={() => report.refetch()} />
        ) : !report.data ? (
          <CardsSkeleton count={4} />
        ) : (
          <>
            <TabsContent value="summary" className="space-y-4">
              <Quality r={report.data} onRebuild={() => setRebuildOpen(true)} onRecalc={can('finance.manage') ? () => recalc.mutate() : undefined} />
              <Summary r={report.data} />
            </TabsContent>
            <TabsContent value="sales"><Sales r={report.data} /></TabsContent>
            <TabsContent value="expenses"><Expenses r={report.data} /></TabsContent>
            <TabsContent value="channels"><Channels r={report.data} /></TabsContent>
            <TabsContent value="chart"><Charts r={report.data} /></TabsContent>
          </>
        )}
      </Tabs>

      <RebuildDialog open={rebuildOpen} onOpenChange={setRebuildOpen} range={range} canApply={can('finance.manage')} />
    </div>
  )
}

// ---------------------------------------------------------------------------- data quality

function CertaintyBadge({ value }: { value: Certainty }) {
  const c = CERTAINTY[value]
  return <span title={c.hint} className={cn('inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium', c.className)}>{c.label}</span>
}

function Quality({ r, onRebuild, onRecalc }: { r: OrderFinancials; onRebuild: () => void; onRecalc?: () => void }) {
  const q = r.quality
  const own = toNumber(r.totals.sales) - toNumber(q.synced_sales)
  const items: Array<{ certainty: Certainty; text: React.ReactNode }> = []
  if (own > 0) items.push({ certainty: 'actual', text: <>Own sales {formatMoney(own)}</> })
  if (toNumber(q.synced_sales) > 0) items.push({ certainty: 'synced', text: <>{formatMoney(q.synced_sales)} from connected stores ({q.synced_orders} order{q.synced_orders === 1 ? '' : 's'})</> })
  if (toNumber(q.delivery_cost_estimated) > 0) items.push({ certainty: 'estimated', text: <>Courier fees {formatMoney(q.delivery_cost_estimated)} not yet confirmed by the courier</> })
  if (q.missing_cost_orders > 0) {
    items.push({
      certainty: 'unavailable',
      text: (
        <>
          Product cost missing on {q.missing_cost_orders} order{q.missing_cost_orders === 1 ? '' : 's'} (counted as 0) ·{' '}
          {q.missing_cost_fixable > 0
            ? <button type="button" className="underline underline-offset-2" onClick={onRebuild}>fill from today’s cost</button>
            : <Link className="underline underline-offset-2" to="/admin/products">add costs to products</Link>}
        </>
      ),
    })
  }
  if (q.ads.status === 'unavailable') items.push({ certainty: 'unavailable', text: <>No ad account connected — profit is before ads · <Link className="underline underline-offset-2" to="/admin/ads">connect</Link></> })
  if (q.ads.status === 'synced' && q.ads.last_sync_at) items.push({ certainty: 'synced', text: <>Ad spend from {q.ads.accounts} account{q.ads.accounts === 1 ? '' : 's'}, last sync {formatDateTime(q.ads.last_sync_at)}</> })

  return (
    <div className="space-y-2">
      {q.unposted_delivered > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm">
          <AlertTriangle className="size-4 text-amber-600" />
          <span>{q.unposted_delivered} delivered order{q.unposted_delivered === 1 ? ' is' : 's are'} not in the books yet, so they are not counted.</span>
          {onRecalc && <Button size="sm" variant="outline" className="ml-auto h-7" onClick={onRecalc}><RefreshCw /> Recalculate</Button>}
        </div>
      )}
      {items.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
          {items.map((i, n) => <span key={n} className="inline-flex items-center gap-1.5"><CertaintyBadge value={i.certainty} />{i.text}</span>)}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------- summary

function Summary({ r }: { r: OrderFinancials }) {
  const t = r.totals
  const s = r.stats
  const profit = toNumber(t.profit)
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Total sales" value={formatMoney(t.sales)}
          hint={`${formatNumber(t.orders)} order${t.orders === 1 ? '' : 's'}${t.sales_per_order !== null ? ` · ${formatMoney(t.sales_per_order)} per order` : ''}`} />
        <StatCard label="Estimated profit" value={formatMoney(profit)} tone={profit < 0 ? 'negative' : 'positive'}
          hint={`Margin ${formatPercent(t.margin_pct)}${t.profit_per_order !== null ? ` · ${formatMoney(t.profit_per_order)} per order` : ''}`} />
        <StatCard label="Total expense" value={formatMoney(t.total_expense)} hint="Product, delivery, ads, other and refunds" />
        <StatCard label={s.basis === 'created' ? 'Orders placed' : 'Orders approved'} value={formatNumber(s.total)}
          hint={`Delivered ${formatPercent(s.delivered_pct, 0)} · ${s.pending} pending · ${s.returned} returned · ${s.cancelled} cancelled`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Allocation r={r} />
        <Card>
          <CardHeader><CardTitle className="text-base">Channel profit snapshot</CardTitle><CardDescription>Before ads and overheads</CardDescription></CardHeader>
          <CardContent>
            {r.channels.length === 0 ? <EmptyState title="No sales in this period" className="py-6" /> : (
              <ul className="space-y-2.5 text-sm">
                {r.channels.slice(0, 5).map((c) => (
                  <li key={c.key} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{c.name} <span className="text-xs text-muted-foreground">· {PLATFORM[c.platform] ?? c.platform}</span></span>
                    <span className="text-xs text-muted-foreground tabular-nums">{formatMoney(c.sales)}</span>
                    <span className={cn('w-24 text-right font-medium tabular-nums', toNumber(c.profit) < 0 && 'text-red-600')}>{formatMoney(c.profit)}</span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Product profit snapshot</CardTitle><CardDescription>Sales less product cost</CardDescription></CardHeader>
          <CardContent>
            {r.products.rows.length === 0 ? <EmptyState title="No products sold" className="py-6" /> : (
              <ul className="space-y-2.5 text-sm">
                {r.products.rows.slice(0, 5).map((p) => (
                  <li key={(p.product_id ?? '') + p.name} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{p.name} <span className="text-xs text-muted-foreground">× {formatNumber(p.quantity)}</span></span>
                    {p.missing_cost
                      ? <span className="text-xs"><CertaintyBadge value="unavailable" /></span>
                      : <span className={cn('w-24 text-right font-medium tabular-nums', toNumber(p.profit) < 0 && 'text-red-600')}>{formatMoney(p.profit)}</span>}
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <Calculation r={r} />
    </>
  )
}

function Allocation({ r }: { r: OrderFinancials }) {
  const a = allocation(r.totals)
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Revenue allocation</CardTitle><CardDescription>Where each sale went</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        {a.sales <= 0 ? <EmptyState title="No sales in this period" className="py-6" /> : (
          <>
            <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted">
              {a.parts.filter((p) => p.pct > 0).map((p) => <div key={p.key} className={PART_COLOR[p.key]} style={{ width: `${Math.min(p.pct, 100)}%` }} title={`${p.label} ${formatPercent(p.pct)}`} />)}
            </div>
            <ul className="space-y-1.5 text-sm">
              {a.parts.map((p) => (
                <li key={p.key} className="flex items-center gap-2">
                  <span className={cn('size-2.5 rounded-sm', PART_COLOR[p.key])} />
                  <span className="flex-1">{p.label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{formatPercent(p.pct)}</span>
                  <span className="w-24 text-right tabular-nums">{formatMoney(p.amount)}</span>
                </li>
              ))}
            </ul>
            {a.loss > 0 && <p className="text-xs text-red-600">Costs are {formatMoney(a.loss)} more than sales and income.</p>}
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Calculation({ r }: { r: OrderFinancials }) {
  const rows = calculationRows(r)
  const section = (name: CalcRow['section']) => rows.filter((x) => x.section === name)
  const profit = toNumber(r.totals.profit)
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Profit calculation</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">Description</th>
              <th className="py-2 text-right font-medium">Amount</th>
              <th className="w-20 py-2 text-right font-medium">Count</th>
              <th className="py-2 pl-6 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {(['Revenue', 'Expenses'] as const).map((name) => (
              <SectionRows key={name} name={name} rows={section(name)} />
            ))}
            <tr className="border-y-2 text-base font-semibold">
              <td className="py-2">Estimated profit</td>
              <td className={cn('py-2 text-right tabular-nums', profit < 0 && 'text-red-600')}>{formatMoney(profit)}</td>
              <td className="py-2 text-right text-muted-foreground tabular-nums">{formatNumber(r.totals.orders)}</td>
              <td className="py-2 pl-6 text-xs font-normal text-muted-foreground">Margin {formatPercent(r.totals.margin_pct)} of net sales</td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function SectionRows({ name, rows }: { name: string; rows: CalcRow[] }) {
  return (
    <>
      <tr><td colSpan={4} className="pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{name}</td></tr>
      {rows.map((x) => (
        <tr key={x.label} className="border-b border-dashed last:border-0">
          <td className="py-2 pl-3">{x.label}</td>
          <td className="py-2 text-right tabular-nums">{x.negative && x.amount !== 0 ? `(${formatMoney(x.amount)})` : formatMoney(x.amount)}</td>
          <td className="py-2 text-right text-muted-foreground tabular-nums">{x.count === null ? '—' : formatNumber(x.count)}</td>
          <td className="py-2 pl-6">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {x.certainty && <CertaintyBadge value={x.certainty} />}
              <span>{x.detail}</span>
            </div>
            {x.warning && <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">{x.warning}</p>}
          </td>
        </tr>
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------- sales / expenses / channels / chart

function Sales({ r }: { r: OrderFinancials }) {
  const total = toNumber(r.totals.sales)
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader><CardTitle className="text-base">Sales by day</CardTitle></CardHeader>
        <CardContent><BarsChart data={r.daily} xKey="day" dateAxis format="money" series={[{ key: 'sales', label: 'Sales', slot: 1 }]} /></CardContent>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-base">By sales channel</CardTitle><CardDescription>Synced = imported from a connected store</CardDescription></CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-2 font-medium">Channel</th><th className="py-2 text-right font-medium">Orders</th><th className="py-2 text-right font-medium">Sales</th><th className="py-2 text-right font-medium">Share</th></tr></thead>
              <tbody>
                {r.channels.map((c) => (
                  <tr key={c.key} className="border-b last:border-0">
                    <td className="py-2">{c.name} <span className="ml-1"><CertaintyBadge value={c.synced ? 'synced' : 'actual'} /></span></td>
                    <td className="py-2 text-right tabular-nums">{formatNumber(c.orders)}</td>
                    <td className="py-2 text-right tabular-nums">{formatMoney(c.sales)}</td>
                    <td className="py-2 text-right text-muted-foreground tabular-nums">{formatPercent(total > 0 ? toNumber(c.sales) / total * 100 : null, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">By day</CardTitle></CardHeader>
          <CardContent className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-2 font-medium">Day</th><th className="py-2 text-right font-medium">Orders</th><th className="py-2 text-right font-medium">Sales</th><th className="py-2 text-right font-medium">Profit</th></tr></thead>
              <tbody>
                {[...r.daily].reverse().map((d) => (
                  <tr key={d.day} className="border-b last:border-0">
                    <td className="py-1.5">{formatDate(d.day)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatNumber(d.orders)}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatMoney(d.sales)}</td>
                    <td className={cn('py-1.5 text-right tabular-nums', toNumber(d.profit) < 0 && 'text-red-600')}>{formatMoney(d.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

const LINE_LABEL: Record<string, string> = {
  product_cost: 'Product cost', delivery_cost: 'Delivery cost', ads: 'Ads expense', other_expense: 'Other expense', refunds: 'Refunds',
}

function Expenses({ r }: { r: OrderFinancials }) {
  const lines = ['product_cost', 'delivery_cost', 'ads', 'other_expense', 'refunds'] as const
  const total = toNumber(r.totals.total_expense)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Expenses · {formatMoney(total)}</CardTitle>
        <CardDescription>Every line comes from your books; manual expenses are added on Income &amp; Expense.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead><tr className="border-b text-left text-xs text-muted-foreground"><th className="py-2 font-medium">Expense</th><th className="py-2 text-right font-medium">Orders</th><th className="py-2 text-right font-medium">Amount</th><th className="py-2 text-right font-medium">Share</th></tr></thead>
          <tbody>
            {lines.map((line) => {
              const cats = r.categories.filter((c) => c.line === line)
              const amount = toNumber(r.totals[line])
              return (
                <ExpenseGroup key={line} label={LINE_LABEL[line]} amount={amount} share={total > 0 ? amount / total * 100 : null}
                  rows={cats.map((c) => ({ name: c.name, amount: toNumber(c.amount), orders: c.orders }))} />
              )
            })}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function ExpenseGroup({ label, amount, share, rows }: { label: string; amount: number; share: number | null; rows: Array<{ name: string; amount: number; orders: number }> }) {
  return (
    <>
      <tr className="border-b font-medium">
        <td className="pt-3 pb-1.5">{label}</td>
        <td />
        <td className="pt-3 pb-1.5 text-right tabular-nums">{formatMoney(amount)}</td>
        <td className="pt-3 pb-1.5 text-right text-muted-foreground tabular-nums">{formatPercent(share, 0)}</td>
      </tr>
      {rows.map((x) => (
        <tr key={x.name} className="text-muted-foreground">
          <td className="py-1 pl-4">{x.name}</td>
          <td className="py-1 text-right tabular-nums">{x.orders ? formatNumber(x.orders) : '—'}</td>
          <td className="py-1 text-right tabular-nums">{formatMoney(x.amount)}</td>
          <td />
        </tr>
      ))}
    </>
  )
}

function Channels({ r }: { r: OrderFinancials }) {
  const u = r.unallocated
  const unallocated = toNumber(u.other_income) - toNumber(u.refunds) - toNumber(u.ads) - toNumber(u.other_expense)
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Channel profit</CardTitle>
        <CardDescription>Each channel's own orders. Ad spend and overheads are not linked to orders, so they are shown once below instead of being split by a guess.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <table className="w-full min-w-[48rem] text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <th className="py-2 font-medium">Channel</th><th className="py-2 text-right font-medium">Orders</th><th className="py-2 text-right font-medium">Sales</th>
              <th className="py-2 text-right font-medium">Product cost</th><th className="py-2 text-right font-medium">Delivery cost</th>
              <th className="py-2 text-right font-medium">Refunds / other</th><th className="py-2 text-right font-medium">Profit</th><th className="py-2 text-right font-medium">Margin</th>
            </tr>
          </thead>
          <tbody>
            {r.channels.map((c) => (
              <tr key={c.key} className="border-b">
                <td className="py-2">
                  <div className="font-medium">{c.name}</div>
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {PLATFORM[c.platform] ?? c.platform}
                    {c.missing_cost_orders > 0 && <span className="text-amber-700 dark:text-amber-300">· {c.missing_cost_orders} without product cost</span>}
                  </div>
                </td>
                <td className="py-2 text-right tabular-nums">{formatNumber(c.orders)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(c.sales)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(c.product_cost)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(c.delivery_cost)}</td>
                <td className="py-2 text-right tabular-nums">{formatMoney(toNumber(c.refunds) + toNumber(c.other_cost) - toNumber(c.other_income))}</td>
                <td className={cn('py-2 text-right font-medium tabular-nums', toNumber(c.profit) < 0 && 'text-red-600')}>{formatMoney(c.profit)}</td>
                <td className="py-2 text-right text-muted-foreground tabular-nums">{formatPercent(c.margin_pct, 0)}</td>
              </tr>
            ))}
            <tr className="border-b text-muted-foreground">
              <td className="py-2" colSpan={6}>
                Not linked to a channel <span className="text-xs">(ads {formatMoney(u.ads)}, other expense {formatMoney(u.other_expense)}, other income {formatMoney(u.other_income)})</span>
              </td>
              <td className="py-2 text-right tabular-nums">{formatMoney(unallocated)}</td>
              <td />
            </tr>
            <tr className="border-b-2 font-semibold">
              <td className="py-2" colSpan={6}>Estimated profit</td>
              <td className={cn('py-2 text-right tabular-nums', toNumber(r.totals.profit) < 0 && 'text-red-600')}>{formatMoney(r.totals.profit)}</td>
              <td className="py-2 text-right text-muted-foreground tabular-nums">{formatPercent(r.totals.margin_pct, 0)}</td>
            </tr>
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function Charts({ r }: { r: OrderFinancials }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-base">Sales and profit</CardTitle></CardHeader>
        <CardContent>
          <TrendChart data={r.daily} xKey="day" format="money" area series={[{ key: 'sales', label: 'Sales', slot: 1 }, { key: 'profit', label: 'Profit', slot: 2 }]} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Costs by day</CardTitle></CardHeader>
        <CardContent>
          <BarsChart data={r.daily} xKey="day" dateAxis stacked format="money" series={[
            { key: 'product_cost', label: 'Product', slot: 3 }, { key: 'delivery_cost', label: 'Delivery', slot: 4 },
            { key: 'ads', label: 'Ads', slot: 5 }, { key: 'other_expense', label: 'Other', slot: 6 },
          ]} />
        </CardContent>
      </Card>
    </div>
  )
}

// ---------------------------------------------------------------------------- delivered orders

const PAGE = 50

function DeliveredOrders({ range, basis }: { range: DateRange; basis: FinancialsBasis }) {
  const { can } = useAuth()
  const [search, setSearch] = useState('')
  const [missing, setMissing] = useState(false)
  const [page, setPage] = useState(1)
  const params = { from: range.from, to: range.to, basis, search, missingCost: missing }
  const list = useQuery({
    queryKey: ['finance', 'order-financials-orders', params, page],
    queryFn: () => orderFinancialsOrders({ ...params, limit: PAGE, offset: (page - 1) * PAGE }),
  })
  const [exporting, setExporting] = useState(false)
  const exportAll = async () => {
    setExporting(true)
    try {
      const rows: FinancialOrderRow[] = []
      for (let offset = 0; offset < 5000; offset += 200) {
        const r = await orderFinancialsOrders({ ...params, limit: 200, offset })
        rows.push(...r.rows)
        if (rows.length >= r.total || r.rows.length === 0) break
      }
      downloadCsv(`order-financials-${range.from}-to-${range.to}`, rows, [
        { header: 'Order', value: (x) => x.order_number }, { header: 'Date', value: (x) => x.day }, { header: 'Channel', value: (x) => x.channel },
        { header: 'Customer', value: (x) => x.customer ?? '' }, { header: 'Sales', value: (x) => x.sales }, { header: 'Refunds', value: (x) => x.refunds },
        { header: 'Product cost', value: (x) => x.product_cost }, { header: 'Product cost missing', value: (x) => (x.missing_cost ? 'yes' : '') },
        { header: 'Delivery cost', value: (x) => x.delivery_cost }, { header: 'Delivery cost estimated', value: (x) => (x.delivery_estimated ? 'yes' : '') },
        { header: 'Profit', value: (x) => x.profit },
      ])
    } catch (e) {
      toast.error(e)
    } finally {
      setExporting(false)
    }
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex flex-wrap items-center gap-3 border-b p-3">
        <SearchInput value={search} onChange={(v) => { setSearch(v); setPage(1) }} placeholder="Order, phone or name" className="w-64" />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={missing} onCheckedChange={(v) => { setMissing(v); setPage(1) }} /> Only orders without product cost
        </label>
        {can('reports.export') && (
          <Button size="sm" variant="outline" className="ml-auto" onClick={exportAll} disabled={exporting || !list.data?.total}>
            {exporting ? <Spinner /> : <Download />} CSV
          </Button>
        )}
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data ? <LoadingState /> : list.data.rows.length === 0 ? (
        <EmptyState title="No delivered orders" description="Orders appear here once delivered and in the books." className="py-12" />
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">Order</th><th className="py-2 font-medium">Date</th><th className="py-2 font-medium">Channel</th>
                  <th className="py-2 text-right font-medium">Sales</th><th className="py-2 text-right font-medium">Product cost</th>
                  <th className="py-2 text-right font-medium">Delivery cost</th><th className="py-2 text-right font-medium">Refunds / other</th>
                  <th className="px-3 py-2 text-right font-medium">Profit</th>
                </tr>
              </thead>
              <tbody>
                {list.data.rows.map((o) => (
                  <tr key={o.order_id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <Link to={`/admin/orders/${o.order_id}`} className="font-medium hover:underline">#{o.order_number}</Link>
                      <div className="max-w-48 truncate text-xs text-muted-foreground">{o.customer ?? o.phone ?? ''}</div>
                    </td>
                    <td className="py-2 text-muted-foreground">{formatDate(o.day)}</td>
                    <td className="py-2">{o.channel}{o.platform !== 'OWN' && <Badge variant="outline" className="ml-1.5 text-[10px]">{PLATFORM[o.platform] ?? o.platform}</Badge>}</td>
                    <td className="py-2 text-right tabular-nums">{formatMoney(o.sales)}</td>
                    <td className="py-2 text-right tabular-nums">{o.missing_cost ? <span className="inline-flex items-center gap-1.5">{formatMoney(o.product_cost)} <CertaintyBadge value="unavailable" /></span> : formatMoney(o.product_cost)}</td>
                    <td className="py-2 text-right tabular-nums">{o.delivery_estimated ? <span className="inline-flex items-center gap-1.5">{formatMoney(o.delivery_cost)} <CertaintyBadge value="estimated" /></span> : formatMoney(o.delivery_cost)}</td>
                    <td className="py-2 text-right tabular-nums">{formatMoney(toNumber(o.refunds) + toNumber(o.other_cost) - toNumber(o.income))}</td>
                    <td className={cn('px-3 py-2 text-right font-medium tabular-nums', toNumber(o.profit) < 0 && 'text-red-600')}>{formatMoney(o.profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination page={page} pageSize={PAGE} total={list.data.total} onPage={setPage} />
        </>
      )}
    </Card>
  )
}

// ---------------------------------------------------------------------------- rebuild historical cost

function RebuildDialog({ open, onOpenChange, range, canApply }: { open: boolean; onOpenChange: (o: boolean) => void; range: DateRange; canApply: boolean }) {
  const qc = useQueryClient()
  const preview = useQuery({ queryKey: ['finance', 'rebuild-cost', range], queryFn: () => rebuildCost(range.from, range.to, false), enabled: open })
  const apply = useMutation({
    mutationFn: () => rebuildCost(range.from, range.to, true),
    onSuccess: (r) => {
      toast.success(r.posted ? `Added ${formatMoney(r.amount)} product cost on ${r.orders} order${r.orders === 1 ? '' : 's'}` : 'Nothing to fill')
      qc.invalidateQueries({ queryKey: ['finance'] })
      onOpenChange(false)
    },
    onError: (e) => toast.error(e),
  })
  const p = preview.data
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2"><Calculator className="size-4" /> Rebuild historical cost</DialogTitle>
          <DialogDescription>
            Orders delivered {formatDate(range.from)} – {formatDate(range.to)} that had no product cost when they were delivered get today’s
            cost price. Costs that were already set are not changed, and nothing is deleted: the difference is added as new entries dated on each delivery day.
          </DialogDescription>
        </DialogHeader>
        {preview.error ? <ErrorState error={preview.error} onRetry={() => preview.refetch()} /> : !p ? <LoadingState /> : (
          <div className="space-y-3 text-sm">
            {p.items === 0 ? (
              <p className="rounded-md bg-muted/50 px-3 py-2">Nothing to fill: every delivered item in this period has a cost, or its product has no cost yet either.</p>
            ) : (
              <p className="rounded-md bg-muted/50 px-3 py-2">
                {p.items} item{p.items === 1 ? '' : 's'} on {p.orders} order{p.orders === 1 ? '' : 's'} · adds <strong>{formatMoney(p.amount)}</strong> to product cost (profit goes down by the same amount).
              </p>
            )}
            {p.unknown_items > 0 && (
              <p className="text-xs text-amber-700 dark:text-amber-300">
                {p.unknown_items} item{p.unknown_items === 1 ? '' : 's'} still have no cost on the product (for example items from a store that does not send costs). Add the cost in <Link to="/admin/products" className="underline">Products</Link> first.
              </p>
            )}
            {p.rows.length > 0 && (
              <div className="max-h-64 overflow-auto rounded-md border">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 bg-background"><tr className="border-b text-left text-muted-foreground"><th className="px-2 py-1.5 font-medium">Order</th><th className="py-1.5 font-medium">Product</th><th className="py-1.5 text-right font-medium">Qty</th><th className="py-1.5 text-right font-medium">Cost</th><th className="px-2 py-1.5 text-right font-medium">Adds</th></tr></thead>
                  <tbody>
                    {p.rows.map((x, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="px-2 py-1">#{x.order_number}</td><td className="max-w-56 truncate py-1">{x.product}</td>
                        <td className="py-1 text-right tabular-nums">{x.quantity}</td><td className="py-1 text-right tabular-nums">{formatMoney(x.unit_cost)}</td>
                        <td className="px-2 py-1 text-right tabular-nums">{formatMoney(x.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {!canApply && p.items > 0 && <p className="text-xs text-muted-foreground">Only staff who manage finance can apply this.</p>}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          {canApply && <Button onClick={() => apply.mutate()} disabled={!p || p.items === 0 || apply.isPending}>{apply.isPending && <Spinner />} Apply</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
