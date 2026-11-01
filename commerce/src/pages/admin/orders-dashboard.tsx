import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { AlarmClock } from 'lucide-react'
import { useCallback, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, ErrorState } from '@/components/common/states'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { BoardFilterPanel } from '@/features/orders/board/board-filters'
import { BoardList, BoardStatusBar, PAGE_SIZES } from '@/features/orders/board/board-list'
import { activeFilters, boardFilters, boardParams, boardValues, type BoardValues, type DateBy } from '@/features/orders/board/board-state'
import { BarsChart } from '@/features/reports/charts'
import { type DateRange, rangeFor } from '@/lib/dates'
import { formatMoney, formatNumber, formatPercent } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ordersBoard, ordersBoardOptions, ordersDashboard } from '@/services/order-tools'

/** Every order with its status now (with the filter panel), and the approved orders' report. */
export default function OrdersDashboardPage() {
  const [params, setParams] = useSearchParams()
  const view = params.get('view') === 'report' ? 'report' : 'orders'
  const setView = (v: string) => setParams((p) => {
    const next = new URLSearchParams(p)
    if (v === 'report') next.set('view', 'report')
    else next.delete('view')
    return next
  }, { replace: true })

  return (
    <div className="space-y-4">
      <PageHeader title="Orders Dashboard" description="Every order and its status now: approved, shipped, delivered, returned, no response and the rest." />
      <Tabs value={view} onValueChange={setView}>
        <TabsList>
          <TabsTrigger value="orders">Orders</TabsTrigger>
          <TabsTrigger value="report">Report</TabsTrigger>
        </TabsList>
        <TabsContent value="orders" className="space-y-4"><OrdersBoardView /></TabsContent>
        <TabsContent value="report" className="space-y-4"><ApprovedReport /></TabsContent>
      </Tabs>
    </div>
  )
}

function OrdersBoardView() {
  const [params, setParams] = useSearchParams()
  const values = useMemo(() => boardValues(params), [params])
  const filters = useMemo(() => boardFilters(values), [values])
  const page = Math.max(1, Math.floor(Number(params.get('page'))) || 1)
  const size = PAGE_SIZES.includes(Number(params.get('size'))) ? Number(params.get('size')) : 50

  const options = useQuery({ queryKey: ['orders-board-options'], queryFn: ordersBoardOptions, staleTime: 5 * 60_000 })
  // Under "orders" so the list refreshes by itself when an order changes.
  const board = useQuery({
    queryKey: ['orders', 'board', filters, page, size],
    queryFn: () => ordersBoard(filters, size, (page - 1) * size),
    placeholderData: keepPreviousData,
  })

  const apply = useCallback((next: BoardValues) => setParams((p) => boardParams(next, p), { replace: true }), [setParams])
  const setPage = (n: number) => setParams((p) => {
    const next = new URLSearchParams(p)
    if (n > 1) next.set('page', String(n))
    else next.delete('page')
    return next
  })
  const setSize = (n: number) => setParams((p) => {
    const next = new URLSearchParams(p)
    next.set('size', String(n))
    next.delete('page')
    return next
  }, { replace: true })

  return (
    <>
      <BoardFilterPanel values={values} onChange={apply} options={options.data} />
      <BoardStatusBar board={board.data} options={options.data} picked={values.status} onPick={(status) => apply({ ...values, status })} />
      <BoardList board={board.data} loading={board.isFetching} error={board.error} onRetry={() => board.refetch()} options={options.data}
        dateBy={values.by as DateBy} page={page} pageSize={size} onPage={setPage} onPageSize={setSize} filtered={activeFilters(values) > 0} />
    </>
  )
}

/** Approved orders: how they flow through fulfilment and couriers. */
function ApprovedReport() {
  const [range, setRange] = useState<DateRange>(() => rangeFor('30d'))
  const q = useQuery({ queryKey: ['orders-dashboard', range], queryFn: () => ordersDashboard(range.from, range.to) })
  const d = q.data
  const t = d?.totals
  const aging = d?.aging

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Approved orders, from approval to the courier, delivery and returns.</p>
        <DateRangeFilter value={range} onChange={setRange} />
      </div>
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
              { label: 'Return open over 7 days', n: aging.return_over_7d, to: '/admin/orders/approved?tab=RETURN_PENDING' },
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
                      <th className="px-2 text-right font-medium">Shipped</th><th className="px-2 text-right font-medium">Return pending</th><th className="px-2 text-right font-medium">Cancelling</th>
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
    </>
  )
}
