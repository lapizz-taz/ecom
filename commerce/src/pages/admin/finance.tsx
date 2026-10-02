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
        actions={<DateRangeFilter value={range} onChange={setRange} />}
      />
      {can('finance.manage') && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" asChild><Link to="/admin/finance/expenses?new=1"><TrendingDown /> Add expense</Link></Button>
          <Button size="sm" variant="outline" asChild><Link to="/admin/finance/income?new=1"><TrendingUp /> Add income</Link></Button>
          <Button size="sm" variant="outline" asChild><Link to={`/admin/finance/profit-loss${qs}`}><FileText /> Profit &amp; loss</Link></Button>
          <Button size="sm" variant="outline" asChild><Link to={`/admin/finance/cash-flow${qs}`}><Banknote /> Cash flow</Link></Button>
        </div>
      )}

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

          <section>
            <h2 className="mb-2 text-sm font-medium text-muted-foreground">Balances right now</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="COD receivable" value={<Money value={f.cod_receivable} />} hint="delivered, not yet settled by courier" to="/admin/couriers?tab=cod" />
              <StatCard label="Outstanding on open orders" value={<Money value={f.outstanding_amount} />} hint="still to be collected" to="/admin/orders?tab=processing" />
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
