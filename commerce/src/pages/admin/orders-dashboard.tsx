import { useQuery } from '@tanstack/react-query'
import { AlarmClock } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, ErrorState } from '@/components/common/states'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { BarsChart } from '@/features/reports/charts'
import { type DateRange, rangeFor } from '@/lib/dates'
import { formatMoney, formatNumber, formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ordersDashboard } from '@/services/order-tools'

/** Approved orders: how they flow through fulfilment and couriers. */
export default function OrdersDashboardPage() {
  const [range, setRange] = useState<DateRange>(() => rangeFor('30d'))
  const q = useQuery({ queryKey: ['orders-dashboard', range], queryFn: () => ordersDashboard(range.from, range.to) })
  const d = q.data
  const t = d?.totals
  const aging = d?.aging

  return (
    <div className="space-y-4">
      <PageHeader title="Orders Dashboard" description="Approved orders — from approval to the courier, delivery and returns."
        actions={<DateRangeFilter value={range} onChange={setRange} />} />
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d || !t || !aging ? <CardsSkeleton count={6} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
            <StatCard label="Approved" value={formatNumber(t.approved)} hint={formatMoney(t.approved_value)} />
            <StatCard label="Shipped" value={formatNumber(t.shipped)} />
            <StatCard label="Delivered" value={formatNumber(t.delivered)} hint={formatMoney(t.delivered_value)} tone="positive" />
            <StatCard label="Returned" value={formatNumber(t.returned)} />
            <StatCard label="Cancelled after approval" value={formatNumber(t.cancelled)} />
            <StatCard label="Delivery rate" value={t.delivered + t.returned > 0 ? formatPercent((100 * t.delivered) / (t.delivered + t.returned)) : '—'} hint="delivered ÷ (delivered + returned)" />
          </div>

          <section className="grid grid-cols-2 gap-2 md:grid-cols-5" aria-label="Waiting too long">
            {[
              { label: 'Approved, not booked', n: aging.unbooked, to: '/admin/orders/approved?tab=PENDING' },
              { label: 'Pending over 2 days', n: aging.pending_over_2d, to: '/admin/orders/approved?tab=PENDING' },
              { label: 'RTS over 1 day', n: aging.rts_over_1d, to: '/admin/orders/approved?tab=RTS' },
              { label: 'Shipped over 7 days', n: aging.shipped_over_7d, to: '/admin/orders/approved?tab=SHIPPED' },
              { label: 'Return open over 7 days', n: aging.return_over_7d, to: '/admin/orders/approved?tab=PENDING_RETURN' },
            ].map((a) => (
              <Link key={a.label} to={a.to} className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2 text-sm hover:bg-muted/50">
                <AlarmClock className={cn('size-4', a.n > 0 ? 'text-amber-600' : 'text-muted-foreground')} />
                <span className="flex-1 truncate">{a.label}</span>
                <span className={cn('font-semibold tabular-nums', a.n > 0 && 'text-amber-600')}>{formatNumber(a.n)}</span>
              </Link>
            ))}
          </section>

          <Card>
            <CardHeader><CardTitle className="text-sm">Every day</CardTitle></CardHeader>
            <CardContent>
              <BarsChart data={d.daily} xKey="day" dateAxis
                series={[{ key: 'approved', label: 'Approved', slot: 1 }, { key: 'shipped', label: 'Shipped', slot: 4 }, { key: 'delivered', label: 'Delivered', slot: 3 }, { key: 'returned', label: 'Returned', slot: 2 }]} />
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <Card className="min-w-0">
              <CardHeader><CardTitle className="text-sm">Open orders by courier (right now)</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b"><th className="py-1.5 text-left font-medium">Courier</th><th className="px-2 text-right font-medium">Pending</th><th className="px-2 text-right font-medium">RTS</th>
                      <th className="px-2 text-right font-medium">Shipped</th><th className="px-2 text-right font-medium">Pending return</th><th className="px-2 text-right font-medium">Pending cancel</th>
                      <th className="px-2 text-right font-medium">Total</th><th className="pl-2 text-right font-medium">Still to collect</th></tr>
                  </thead>
                  <tbody className="divide-y tabular-nums">
                    {d.by_courier.map((c) => (
                      <tr key={c.courier}>
                        <td className="py-2 font-medium">{c.courier}</td>
                        <td className="px-2 text-right">{formatNumber(c.pending)}</td>
                        <td className="px-2 text-right">{formatNumber(c.rts)}</td>
                        <td className="px-2 text-right">{formatNumber(c.shipped)}</td>
                        <td className={cn('px-2 text-right', c.pending_return > 0 && 'text-amber-600')}>{formatNumber(c.pending_return)}</td>
                        <td className="px-2 text-right">{formatNumber(c.pending_cancel)}</td>
                        <td className="px-2 text-right font-medium">{formatNumber(c.total)}</td>
                        <td className="pl-2 text-right"><Money value={c.cod_open} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {d.by_courier.length === 0 && <p className="py-4 text-sm text-muted-foreground">No open approved orders.</p>}
              </CardContent>
            </Card>
            <Card className="min-w-0">
              <CardHeader><CardTitle className="text-sm">Approved by</CardTitle></CardHeader>
              <CardContent>
                {d.by_agent.length === 0 ? <p className="text-sm text-muted-foreground">No approvals in this period.</p> : (
                  <ul className="divide-y text-sm">
                    {d.by_agent.map((a) => (
                      <li key={a.name} className="flex justify-between gap-3 py-2">
                        <span className="truncate">{a.name}</span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">{formatNumber(a.approved)} orders · <Money value={a.value} /></span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  )
}
