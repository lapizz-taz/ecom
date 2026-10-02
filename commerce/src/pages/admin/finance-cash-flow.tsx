import { useQuery } from '@tanstack/react-query'
import { ArrowDownRight, ArrowUpRight, Download, Printer, Wallet } from 'lucide-react'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, ErrorState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useAuth } from '@/features/auth/auth-context'
import { BarsChart, ShareList, TrendChart } from '@/features/reports/charts'
import { useDateRange } from '@/hooks/use-date-range'
import { downloadCsv } from '@/lib/csv'
import { granularityFor } from '@/lib/dates'
import { formatDate, toNumber } from '@/lib/format'
import { cashFlow } from '@/services/finance'

export default function CashFlowPage() {
  const { can } = useAuth()
  const [range, setRange] = useDateRange('month')
  const granularity = granularityFor(range)
  const flow = useQuery({ queryKey: ['finance', 'cash-flow', range, granularity], queryFn: () => cashFlow(range.from, range.to, granularity) })
  const c = flow.data

  // Running balance of net cash across the period (starts at zero).
  let running = 0
  const series = (c?.series ?? []).map((s) => {
    running += toNumber(s.net)
    return { ...s, cash_in: toNumber(s.cash_in), cash_out: toNumber(s.cash_out), net: toNumber(s.net), cumulative: running }
  })
  const inflows = (c?.by_category ?? []).filter((x) => x.type === 'INCOME' && toNumber(x.amount) !== 0)
  const outflows = (c?.by_category ?? []).filter((x) => x.type === 'EXPENSE' && toNumber(x.amount) !== 0)

  const exportCsv = () => downloadCsv(`cash-flow-${range.from}-to-${range.to}`, series, [
    { header: granularity === 'day' ? 'Date' : `${granularity} starting`, value: (s) => s.bucket },
    { header: 'Cash in', value: (s) => s.cash_in },
    { header: 'Cash out', value: (s) => s.cash_out },
    { header: 'Net', value: (s) => s.net },
    { header: 'Cumulative net', value: (s) => s.cumulative },
  ])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Cash flow"
        description="Money that actually came in or went out, including advances, COD settlements and stock purchases."
        actions={
          <>
            {can('reports.export') && <Button size="sm" variant="outline" onClick={exportCsv} disabled={!c}><Download /> CSV</Button>}
            <Button size="sm" variant="outline" className="no-print" onClick={() => window.print()} disabled={!c}><Printer /> Print / PDF</Button>
          </>
        }
      />
      <div className="no-print"><DateRangeFilter value={range} onChange={setRange} /></div>

      {flow.error ? <ErrorState error={flow.error} onRetry={() => flow.refetch()} /> : !c ? <CardsSkeleton count={3} /> : (
        <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard label="Cash in" value={<Money value={c.cash_in} />} icon={<ArrowDownRight />} />
            <StatCard label="Cash out" value={<Money value={c.cash_out} />} icon={<ArrowUpRight />} />
            <StatCard label="Net cash flow" value={<Money value={c.net_cash_flow} signed />} tone={toNumber(c.net_cash_flow) < 0 ? 'negative' : 'positive'} icon={<Wallet />} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm">Cash in vs cash out</CardTitle></CardHeader>
              <CardContent>
                <BarsChart data={series} xKey="bucket" dateAxis format="money"
                  series={[{ key: 'cash_in', label: 'Cash in', slot: 1 }, { key: 'cash_out', label: 'Cash out', slot: 2 }]} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Cumulative net cash</CardTitle></CardHeader>
              <CardContent>
                <TrendChart data={series} xKey="bucket" format="money" area series={[{ key: 'cumulative', label: 'Cumulative net', slot: 1 }]} />
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-sm">Where cash came from</CardTitle></CardHeader>
              <CardContent><ShareList format="money" items={inflows.map((x) => ({ label: x.name, value: toNumber(x.amount) }))} /></CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Where cash went</CardTitle></CardHeader>
              <CardContent><ShareList format="money" items={outflows.map((x) => ({ label: x.name, value: toNumber(x.amount) }))} /></CardContent>
            </Card>
          </div>

          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{granularity === 'day' ? 'Date' : granularity === 'week' ? 'Week of' : 'Month'}</TableHead>
                  <TableHead className="text-right">Cash in</TableHead>
                  <TableHead className="text-right">Cash out</TableHead>
                  <TableHead className="text-right">Net</TableHead>
                  <TableHead className="text-right">Cumulative</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {series.length === 0 && <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No cash movements in this period</TableCell></TableRow>}
                {series.map((s) => (
                  <TableRow key={s.bucket}>
                    <TableCell>{formatDate(s.bucket)}</TableCell>
                    <TableCell className="text-right"><Money value={s.cash_in} /></TableCell>
                    <TableCell className="text-right"><Money value={s.cash_out} /></TableCell>
                    <TableCell className={s.net < 0 ? 'text-right text-red-600' : 'text-right'}><Money value={s.net} signed /></TableCell>
                    <TableCell className="text-right"><Money value={s.cumulative} signed muted /></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  )
}
