import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { type Column, DataTable } from '@/components/common/data-table'
import { Money } from '@/components/common/money'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState } from '@/components/common/states'
import { useUrlState } from '@/hooks/use-url-state'
import { rangeFor } from '@/lib/dates'
import { formatMoney, formatNumber, formatPercent } from '@/lib/format'
import { type CourierMetrics, courierMetrics } from '@/services/couriers'

const rate = (part: number, whole: number) => (whole > 0 ? Math.round((1000 * part) / whole) / 10 : null)

/** Orders shipped, delivered and returned per courier, with what each one cost. */
export function CourierPerformance() {
  const initial = rangeFor('30d')
  const [state, update] = useUrlState({ from: initial.from, to: initial.to })
  const metrics = useQuery({
    queryKey: ['courier-metrics', state.from, state.to],
    placeholderData: keepPreviousData,
    queryFn: () => courierMetrics(state.from, state.to),
  })
  const rows = (metrics.data ?? []).filter((r) => r.booked + r.cancelled > 0 || r.api_enabled)
  const sum = (k: keyof CourierMetrics) => rows.reduce((s, r) => s + Number(r[k] ?? 0), 0)
  const delivered = sum('delivered')
  const returned = sum('returned')
  const shipped = sum('shipped')
  const totalCost = sum('total_cost')

  const columns: Column<CourierMetrics>[] = [
    { key: 'name', header: 'Courier', primary: true, cell: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'shipped', header: 'Shipped', align: 'right', cell: (r) => formatNumber(r.shipped) },
    { key: 'delivered', header: 'Delivered', align: 'right', cell: (r) => formatNumber(r.delivered) },
    { key: 'returned', header: 'Returned', align: 'right', cell: (r) => formatNumber(r.returned) },
    { key: 'cancelled', header: 'Cancelled', align: 'right', hideOnMobile: true, cell: (r) => formatNumber(r.cancelled) },
    { key: 'transit', header: 'On the way', align: 'right', hideOnMobile: true, cell: (r) => formatNumber(r.in_transit) },
    { key: 'dr', header: 'Delivery rate', align: 'right', cell: (r) => (r.delivery_rate == null ? '—' : formatPercent(r.delivery_rate)) },
    { key: 'rr', header: 'Return rate', align: 'right', hideOnMobile: true, cell: (r) => (r.return_rate == null ? '—' : formatPercent(r.return_rate)) },
    {
      key: 'cost', header: 'Courier cost', align: 'right',
      cell: (r) => (
        <span title={`Delivery ${formatMoney(r.delivery_cost)} · Returns ${formatMoney(r.return_cost)} · COD fees ${formatMoney(r.cod_fees)} · Other ${formatMoney(r.other_costs)}`}>
          <Money value={r.total_cost} />
        </span>
      ),
    },
    { key: 'avg', header: 'Per order', align: 'right', cell: (r) => (r.avg_cost_per_order == null ? '—' : <Money value={r.avg_cost_per_order} muted />) },
    { key: 'cod', header: 'COD not paid out', align: 'right', hideOnMobile: true, cell: (r) => <Money value={Math.max(r.cod_expected - r.cod_settled, 0)} muted /> },
  ]

  return (
    <div className="space-y-4">
      <DateRangeFilter value={{ from: state.from, to: state.to }} onChange={(r) => update(r)} />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Shipped" value={formatNumber(shipped)} hint={`${formatNumber(sum('in_transit'))} still on the way`} />
        <StatCard label="Delivery rate" value={rate(delivered, delivered + returned) == null ? '—' : formatPercent(rate(delivered, delivered + returned)!)}
          hint={`${formatNumber(delivered)} delivered · ${formatNumber(returned)} returned`} />
        <StatCard label="Courier cost" value={formatMoney(totalCost)}
          hint={`Delivery ${formatMoney(sum('delivery_cost'))} · Returns ${formatMoney(sum('return_cost'))} · COD fees ${formatMoney(sum('cod_fees'))}`} />
        <StatCard label="Cost per order" value={shipped ? formatMoney(totalCost / shipped) : '—'} hint="Across shipped parcels" />
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(r) => r.id} loading={metrics.isFetching} error={metrics.error} onRetry={() => metrics.refetch()}
        empty={<EmptyState title="No parcels in this period" description="Book parcels with a courier and they show up here." />} />
      <p className="text-xs text-muted-foreground">
        Rates count parcels that reached the end: delivered vs. returned. Costs are what the courier reported (webhooks or statements) and,
        until then, the expected charge.
      </p>
    </div>
  )
}
