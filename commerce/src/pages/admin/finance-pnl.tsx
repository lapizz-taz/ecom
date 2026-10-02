import { useQuery } from '@tanstack/react-query'
import { Download, Printer } from 'lucide-react'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { useDateRange } from '@/hooks/use-date-range'
import { useStoreConfig } from '@/hooks/use-store-config'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { previousPeriod } from '@/lib/dates'
import { formatDate, formatMoney, formatPercent, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { profitLoss } from '@/services/finance'
import type { ProfitLoss } from '@/types/domain'

interface Line {
  label: string
  current: number
  previous?: number
  kind: 'line' | 'subtotal' | 'total' | 'heading'
  /** Shown in brackets (amounts that are subtracted). */
  negative?: boolean
  note?: string
}

function groupLines(pl: ProfitLoss | undefined, group: string) {
  return (pl?.lines ?? []).filter((l) => l.group === group)
}

/** Builds the statement rows, merging per-category lines of both periods by code. */
function buildStatement(cur: ProfitLoss, prev?: ProfitLoss): Line[] {
  const merged = (group: string) => {
    const codes = new Map<string, string>()
    for (const l of [...groupLines(cur, group), ...groupLines(prev, group)]) codes.set(l.code, l.name)
    return [...codes].map(([code, name]) => ({
      label: name,
      current: toNumber(groupLines(cur, group).find((l) => l.code === code)?.amount),
      previous: prev ? toNumber(groupLines(prev, group).find((l) => l.code === code)?.amount) : undefined,
    }))
  }
  const p = <K extends keyof ProfitLoss>(k: K) => (prev ? toNumber(prev[k]) : undefined)
  const margin = (pl: ProfitLoss | undefined, k: 'gross_profit' | 'net_profit') =>
    pl && toNumber(pl.net_revenue) > 0 ? (toNumber(pl[k]) / toNumber(pl.net_revenue)) * 100 : null

  return [
    { label: 'Revenue', current: 0, kind: 'heading' },
    { label: 'Product sales', current: toNumber(cur.product_revenue), previous: p('product_revenue'), kind: 'line' },
    { label: 'Delivery charges', current: toNumber(cur.delivery_income), previous: p('delivery_income'), kind: 'line' },
    { label: 'Total revenue', current: toNumber(cur.revenue), previous: p('revenue'), kind: 'subtotal' },
    { label: 'Refunds', current: toNumber(cur.refunds), previous: p('refunds'), kind: 'line', negative: true },
    { label: 'Net revenue', current: toNumber(cur.net_revenue), previous: p('net_revenue'), kind: 'subtotal' },
    { label: 'Cost of sales', current: 0, kind: 'heading' },
    ...merged('COGS').map((l) => ({ ...l, kind: 'line' as const, negative: true })),
    { label: 'Total cost of sales', current: toNumber(cur.cogs), previous: p('cogs'), kind: 'subtotal', negative: true },
    {
      label: 'Gross profit', current: toNumber(cur.gross_profit), previous: p('gross_profit'), kind: 'total',
      note: `Gross margin ${formatPercent(margin(cur, 'gross_profit'))}${prev ? ` (prev. ${formatPercent(margin(prev, 'gross_profit'))})` : ''}`,
    },
    { label: 'Operating expenses', current: 0, kind: 'heading' },
    ...merged('OPERATING_EXPENSE').map((l) => ({ ...l, kind: 'line' as const, negative: true })),
    { label: 'Total operating expenses', current: toNumber(cur.operating_expenses), previous: p('operating_expenses'), kind: 'subtotal', negative: true },
    { label: 'Other income', current: 0, kind: 'heading' },
    ...merged('OTHER_INCOME').map((l) => ({ ...l, kind: 'line' as const })),
    { label: 'Total other income', current: toNumber(cur.other_income), previous: p('other_income'), kind: 'subtotal' },
    {
      label: 'Net profit', current: toNumber(cur.net_profit), previous: p('net_profit'), kind: 'total',
      note: `Net margin ${formatPercent(margin(cur, 'net_profit'))}${prev ? ` (prev. ${formatPercent(margin(prev, 'net_profit'))})` : ''}`,
    },
  ]
}

function amount(value: number | undefined, negative?: boolean) {
  if (value === undefined) return ''
  if (negative && value !== 0) return `(${formatMoney(Math.abs(value))})`
  return formatMoney(value)
}

function change(cur: number, prev: number | undefined) {
  if (prev === undefined) return null
  if (prev === 0) return cur === 0 ? '—' : 'new'
  const pct = ((cur - prev) / Math.abs(prev)) * 100
  return `${pct > 0 ? '+' : ''}${formatPercent(pct, 0)}`
}

export default function ProfitLossPage() {
  const { can } = useAuth()
  const { data: config } = useStoreConfig()
  const [range, setRange] = useDateRange('month')
  const [state, update] = useUrlState({ compare: '1' })
  const compare = state.compare === '1'
  const prevRange = previousPeriod(range)
  const current = useQuery({ queryKey: ['finance', 'pnl', range], queryFn: () => profitLoss(range.from, range.to) })
  const previous = useQuery({ queryKey: ['finance', 'pnl', prevRange], enabled: compare, queryFn: () => profitLoss(prevRange.from, prevRange.to) })
  const lines = current.data ? buildStatement(current.data, compare ? previous.data : undefined) : []
  const showPrev = compare && !!previous.data

  const exportCsv = () => downloadCsv(`profit-and-loss-${range.from}-to-${range.to}`, lines.filter((l) => l.kind !== 'heading'), [
    { header: 'Line', value: (l) => l.label },
    { header: `${range.from} to ${range.to}`, value: (l) => (l.negative ? -Math.abs(l.current) : l.current) },
    ...(showPrev ? [{ header: `${prevRange.from} to ${prevRange.to}`, value: (l: Line) => (l.previous === undefined ? '' : l.negative ? -Math.abs(l.previous) : l.previous) }] : []),
  ])

  return (
    <div className="space-y-4">
      <PageHeader
        title="Profit & loss"
        description="Accrual view: sales and their cost are recognised when an order is delivered."
        className="no-print"
        actions={
          <>
            {can('reports.export') && <Button size="sm" variant="outline" onClick={exportCsv} disabled={!current.data}><Download /> CSV</Button>}
            <Button size="sm" variant="outline" onClick={() => window.print()} disabled={!current.data}><Printer /> Print / PDF</Button>
          </>
        }
      />
      <div className="no-print flex flex-wrap items-center gap-4">
        <DateRangeFilter value={range} onChange={setRange} />
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={compare} onCheckedChange={(v) => update({ compare: v ? '1' : '0' })} /> Compare with previous period
        </label>
      </div>

      {current.error ? <ErrorState error={current.error} onRetry={() => current.refetch()} /> : !current.data ? <LoadingState /> : (
        <Card className="print:border-0 print:shadow-none">
          <CardContent>
            <div className="mb-4">
              <p className="text-lg font-semibold">{config?.store?.name} — Profit &amp; loss statement</p>
              <p className="text-sm text-muted-foreground">{formatDate(range.from)} – {formatDate(range.to)}</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[28rem] text-sm">
                <thead>
                  <tr className="border-b text-xs text-muted-foreground">
                    <th className="py-2 text-left font-medium" />
                    <th className="py-2 text-right font-medium">This period</th>
                    {showPrev && <><th className="py-2 text-right font-medium">Previous</th><th className="w-20 py-2 text-right font-medium">Change</th></>}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => l.kind === 'heading' ? (
                    <tr key={i}><td colSpan={showPrev ? 4 : 2} className="pt-4 pb-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase">{l.label}</td></tr>
                  ) : (
                    <tr key={i} className={cn(l.kind === 'subtotal' && 'border-t font-medium', l.kind === 'total' && 'border-y-2 text-base font-semibold')}>
                      <td className={cn('py-1.5', l.kind === 'line' && 'pl-4')}>
                        {l.label}
                        {l.note && <span className="block text-xs font-normal text-muted-foreground">{l.note}</span>}
                      </td>
                      <td className={cn('py-1.5 text-right tabular-nums', l.kind === 'total' && l.current < 0 && 'text-red-600')}>{amount(l.current, l.negative)}</td>
                      {showPrev && (
                        <>
                          <td className="py-1.5 text-right text-muted-foreground tabular-nums">{amount(l.previous, l.negative)}</td>
                          <td className="py-1.5 text-right text-xs text-muted-foreground tabular-nums">{change(l.current, l.previous)}</td>
                        </>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-5 text-xs text-muted-foreground">
              Advance payments, COD collections, online payments, advance refunds and stock purchases move cash but are not income or
              expense on their own — they appear under Cash flow. Stock cost reaches this statement as cost of sales when the order is delivered.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
