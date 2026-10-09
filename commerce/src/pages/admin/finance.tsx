import { useQuery } from '@tanstack/react-query'
import { ArrowDownRight, ArrowUpRight, Banknote, FileText, Landmark, Receipt, TrendingDown, TrendingUp, Undo2, Wallet } from 'lucide-react'
import { Link } from 'react-router'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, ErrorState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/auth-context'
import { BarsChart, ShareList } from '@/features/reports/charts'
import { useDateRange } from '@/hooks/use-date-range'
import { useRealtimeInvalidate } from '@/hooks/use-realtime'
import { formatPercent, toNumber } from '@/lib/format'
import { expensesByCategory, financeOverview } from '@/services/finance'
import { cn } from '@/lib/utils'
import type { FinanceOverview } from '@/types/domain'

export default function FinanceOverviewPage() {
  const { can } = useAuth()
  const [range, setRange] = useDateRange('month')
  const overview = useQuery({ queryKey: ['finance', 'overview', range], queryFn: () => financeOverview(range.from, range.to) })
  const expenses = useQuery({ queryKey: ['finance', 'expenses-by-category', range], queryFn: () => expensesByCategory(range.from, range.to) })
  useRealtimeInvalidate('finance_transactions', [['finance']])
  const f = overview.data
  const qs = `?from=${range.from}&to=${range.to}`

  return (
    <div className="space-y-5">
      <PageHeader
        title="Finance"
        description="Profit is recognised when orders are delivered; cash is counted when money actually moves."
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DateRangeFilter value={range} onChange={setRange} />
        {can('finance.manage') && (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" asChild><Link to="/admin/finance/income-expense?tab=expense"><TrendingDown /> Income &amp; expense</Link></Button>
            <Button size="sm" variant="outline" asChild><Link to={`/admin/finance/profit-loss${qs}`}><FileText /> Profit &amp; loss</Link></Button>
            <Button size="sm" variant="outline" asChild><Link to={`/admin/finance/cash-flow${qs}`}><Banknote /> Cash flow</Link></Button>
          </div>
        )}
      </div>

      {overview.error ? <ErrorState error={overview.error} onRetry={() => overview.refetch()} /> : !f ? <CardsSkeleton count={8} /> : (
        <>
          <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Net revenue" value={<Money value={f.net_revenue} />} hint={<>after <Money value={f.refunds} /> refunds</>} icon={<Receipt />} to={`/admin/finance/profit-loss${qs}`} />
            <StatCard label="Gross profit" value={<Money value={f.gross_profit} />} hint={f.gross_margin_pct === null ? 'no revenue yet' : `${formatPercent(f.gross_margin_pct)} margin`} icon={<TrendingUp />} />
            <StatCard label="Expenses" value={<Money value={f.total_expenses} />} hint={<>COGS <Money value={f.cogs} /> · operating <Money value={f.operating_expenses} /></>} icon={<TrendingDown />} to={`/admin/finance/expenses${qs}`} />
            <StatCard label="Net profit" value={<Money value={f.net_profit} />} tone={toNumber(f.net_profit) < 0 ? 'negative' : 'positive'} icon={<Landmark />} to={`/admin/finance/profit-loss${qs}`} />
            <StatCard label="Cash in" value={<Money value={f.cash_in} />} hint={<>incl. <Money value={f.advance_payments} /> advances</>} icon={<ArrowDownRight />} to={`/admin/finance/cash-flow${qs}`} />
            <StatCard label="Cash out" value={<Money value={f.cash_out} />} hint={<>delivery &amp; returns <Money value={f.delivery_costs} /></>} icon={<ArrowUpRight />} to={`/admin/finance/cash-flow${qs}`} />
            <StatCard label="Net cash flow" value={<Money value={f.net_cash_flow} signed />} tone={toNumber(f.net_cash_flow) < 0 ? 'negative' : 'positive'} icon={<Wallet />} />
            <StatCard label="Other income" value={<Money value={f.other_income} />} hint="retained advances and other" icon={<TrendingUp />} to={`/admin/finance/income${qs}`} />
          </section>

          <Breakdown f={f} qs={qs} />

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Balances right now</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="COD receivable" value={<Money value={f.cod_receivable} />} hint="delivered, not yet settled by courier" to="/admin/couriers?tab=cod" />
              <StatCard label="Outstanding on open orders" value={<Money value={f.outstanding_amount} />} hint="still to be collected" to="/admin/orders/approved?tab=PENDING" />
              <StatCard label="Supplier payables" value={<Money value={f.supplier_payables} />} hint="owed on purchase orders" to="/admin/purchases" />
              <StatCard label="Unresolved advances" value={<Money value={f.unresolved_advances} />} hint="refund or keep" tone={toNumber(f.unresolved_advances) > 0 ? 'warning' : 'default'} icon={<Undo2 />} to="/admin/finance/refunds?tab=advances" />
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-5">
            <Card className="lg:col-span-3">
              <CardHeader>
                <CardTitle className="text-sm">Cash in vs cash out</CardTitle>
                <CardAction><Button size="sm" variant="ghost" asChild><Link to={`/admin/finance/cash-flow${qs}`}>Details</Link></Button></CardAction>
              </CardHeader>
              <CardContent>
                <BarsChart data={f.cash_series} xKey="bucket" dateAxis format="money"
                  series={[{ key: 'cash_in', label: 'Cash in', slot: 1 }, { key: 'cash_out', label: 'Cash out', slot: 2 }]} />
              </CardContent>
            </Card>
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="text-sm">Expenses by category</CardTitle>
                <CardAction><Button size="sm" variant="ghost" asChild><Link to={`/admin/finance/expenses${qs}`}>All expenses</Link></Button></CardAction>
              </CardHeader>
              <CardContent>
                {expenses.error ? <ErrorState error={expenses.error} /> : (
                  <ShareList format="money" items={(expenses.data ?? []).filter((e) => toNumber(e.amount) > 0).map((e) => ({ label: e.name, value: toNumber(e.amount) }))} />
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}

/** Gross revenue down to net profit, and how the money came in. */
function Breakdown({ f, qs }: { f: FinanceOverview; qs: string }) {
  const lines: Array<{ label: string; value: number; minus?: boolean; strong?: boolean; to?: string; hint?: string }> = [
    { label: 'Gross revenue', value: toNumber(f.gross_sales) + toNumber(f.delivery_income), strong: true, hint: 'delivered orders, before discounts' },
    { label: 'Product sales', value: toNumber(f.gross_sales) },
    { label: 'Delivery charges collected', value: toNumber(f.delivery_income) },
    { label: 'Discounts', value: toNumber(f.discounts), minus: true },
    { label: 'Refunds', value: toNumber(f.refunds), minus: true, to: `/admin/finance/refunds${qs}` },
    { label: 'Net revenue', value: toNumber(f.net_revenue), strong: true },
    { label: 'Product cost', value: toNumber(f.cogs), minus: true },
    { label: 'Courier charges', value: toNumber(f.courier_charges), minus: true, to: '/admin/couriers?tab=statements' },
    { label: 'COD fees', value: toNumber(f.courier_cod_fees), minus: true },
    { label: 'Return charges', value: toNumber(f.return_charges), minus: true },
    { label: 'Marketing (ads)', value: toNumber(f.marketing_costs), minus: true, to: '/admin/marketing' },
    { label: 'SMS', value: toNumber(f.sms_costs), minus: true, to: '/admin/sms' },
    { label: 'Payment gateway fees', value: toNumber(f.payment_fees), minus: true },
    { label: 'Other expenses', value: toNumber(f.other_expenses), minus: true, to: `/admin/finance/expenses${qs}` },
    { label: 'Other income', value: toNumber(f.other_income), to: `/admin/finance/income${qs}` },
    { label: 'Net profit', value: toNumber(f.net_profit), strong: true },
  ]
  const collected = toNumber(f.cod_collected) + toNumber(f.online_collected)
  return (
    <div className="grid gap-4 lg:grid-cols-5">
      <Card className="lg:col-span-3">
        <CardHeader><CardTitle className="text-sm">From revenue to profit</CardTitle></CardHeader>
        <CardContent>
          <dl className="divide-y text-sm">
            {lines.map((l) => (
              <div key={l.label} className={cn('flex items-center justify-between gap-3 py-1.5', l.strong && 'font-medium')}>
                <dt className={cn(!l.strong && 'pl-3 text-muted-foreground')}>
                  {l.to ? <Link to={l.to} className="hover:underline">{l.label}</Link> : l.label}
                  {l.hint && <span className="ml-1.5 text-xs font-normal text-muted-foreground">{l.hint}</span>}
                </dt>
                <dd className={cn('tabular-nums', l.label === 'Net profit' && (l.value < 0 ? 'text-red-600' : 'text-emerald-600'))}>
                  {l.minus && l.value > 0 ? '−' : ''}<Money value={l.value} />
                </dd>
              </div>
            ))}
          </dl>
        </CardContent>
      </Card>
      <Card className="lg:col-span-2">
        <CardHeader><CardTitle className="text-sm">How customers paid</CardTitle></CardHeader>
        <CardContent className="grid gap-3 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Order value (not cancelled)</span><Money value={f.order_value} /></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Cash on delivery collected</span><Money value={f.cod_collected} /></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Paid online (bKash, Nagad, gateways)</span><Money value={f.online_collected} /></div>
          {collected > 0 && (
            <div>
              <div className="flex h-2 overflow-hidden rounded-full bg-muted" aria-hidden>
                <div className="bg-chart-1" style={{ width: `${(100 * toNumber(f.cod_collected)) / collected}%` }} />
                <div className="bg-chart-3" style={{ width: `${(100 * toNumber(f.online_collected)) / collected}%` }} />
              </div>
              <p className="mt-1.5 text-xs text-muted-foreground">
                {formatPercent((100 * toNumber(f.cod_collected)) / collected)} cash on delivery · {formatPercent((100 * toNumber(f.online_collected)) / collected)} online
              </p>
            </div>
          )}
          <div className="flex justify-between border-t pt-3"><span className="text-muted-foreground">Still with couriers (COD receivable)</span><Money value={f.cod_receivable} /></div>
        </CardContent>
      </Card>
    </div>
  )
}
