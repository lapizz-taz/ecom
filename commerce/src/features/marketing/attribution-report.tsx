import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronRight, Info, Route } from 'lucide-react'
import { type Column, DataTable } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Money } from '@/components/common/money'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BarsChart } from '@/features/reports/charts'
import { useUrlState } from '@/hooks/use-url-state'
import { rangeFor } from '@/lib/dates'
import { formatDate, formatMoney, formatNumber, formatPercent, toNumber } from '@/lib/format'
import { type AttributionGroup, attributionReport, type AttributionRow } from '@/services/marketing'

const GROUPS: Array<{ value: AttributionGroup; label: string }> = [
  { value: 'source', label: 'Source' },
  { value: 'medium', label: 'Medium' },
  { value: 'campaign', label: 'Campaign' },
  { value: 'adset', label: 'Ad set' },
  { value: 'ad', label: 'Ad' },
  { value: 'date', label: 'Day' },
  { value: 'product', label: 'Product' },
]
const STATUSES = [
  { value: '', label: 'All orders' },
  { value: 'open', label: 'Still open' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'cancelled', label: 'Cancelled' },
  { value: 'returned', label: 'Returned' },
]
// What a click on a row opens next.
const NEXT: Partial<Record<AttributionGroup, AttributionGroup>> = { source: 'campaign', medium: 'source', campaign: 'adset', adset: 'ad', product: 'source' }

const ratio = (v: number | null) => (v === null || v === undefined ? '—' : `${formatNumber(v, 2)}×`)
const rate = (part: number, whole: number) => (whole > 0 ? formatPercent((100 * part) / whole) : '—')

/** Where sales came from, what they cost to win and to deliver. */
export function AttributionReport() {
  const initial = rangeFor('30d')
  const [s, update] = useUrlState({
    from: initial.from, to: initial.to, group: 'source', status: '',
    source: '', medium: '', campaign: '', campaignName: '', adset: '', adsetName: '', ad: '', adName: '', product: '', productName: '',
  })
  const group = (GROUPS.some((g) => g.value === s.group) ? s.group : 'source') as AttributionGroup
  const filters = { source: s.source, medium: s.medium, campaign: s.campaign, adset: s.adset, ad: s.ad, product: s.product, status: s.status }
  const report = useQuery({
    queryKey: ['attribution', s.from, s.to, group, filters],
    placeholderData: keepPreviousData,
    queryFn: () => attributionReport(s.from, s.to, group, filters),
  })
  const r = report.data
  const totals = r?.totals
  const spend = r?.spend ?? null
  const attributed = totals ? totals.orders - totals.unattributed : 0

  // Breadcrumb of what the report is narrowed to.
  type Crumb = { label: string; clear: Record<string, string> }
  const trail = ([
    s.medium && { label: s.medium, clear: { medium: '' } },
    s.source && { label: s.source, clear: { source: '', campaign: '', campaignName: '', adset: '', adsetName: '', ad: '', adName: '' } },
    s.campaign && { label: s.campaignName || 'Campaign', clear: { campaign: '', campaignName: '', adset: '', adsetName: '', ad: '', adName: '' } },
    s.adset && { label: s.adsetName || 'Ad set', clear: { adset: '', adsetName: '', ad: '', adName: '' } },
    s.ad && { label: s.adName || 'Ad', clear: { ad: '', adName: '' } },
    s.product && { label: s.productName || 'Product', clear: { product: '', productName: '' } },
  ] as Array<Crumb | '' | undefined>).filter((c): c is Crumb => !!c)

  const drill = (row: AttributionRow) => {
    const next = NEXT[group]
    if (!next || row.key === '-') return
    if (group === 'source') update({ source: row.key, group: next })
    else if (group === 'medium') update({ medium: row.key, group: next })
    else if (group === 'campaign') update({ campaign: row.key, campaignName: row.label, group: next })
    else if (group === 'adset') update({ adset: row.key, adsetName: row.label, group: next })
    else if (group === 'product') update({ product: row.key, productName: row.label, group: next })
  }

  const columns: Column<AttributionRow>[] = [
    {
      key: 'name', header: GROUPS.find((g) => g.value === group)?.label, primary: true,
      cell: (row) => (
        <span className="flex items-center gap-1 font-medium">
          {group === 'date' ? formatDate(row.key) : row.label}
          {NEXT[group] && row.key !== '-' && <ChevronRight className="size-3.5 text-muted-foreground" />}
        </span>
      ),
    },
    {
      key: 'orders', header: 'Orders', align: 'right',
      cell: (row) => (
        <span className="tabular-nums">
          {formatNumber(row.orders)}
          <span className="block text-xs text-muted-foreground">{formatNumber(row.approved)} approved · {formatNumber(row.shipped)} shipped</span>
        </span>
      ),
    },
    {
      key: 'delivered', header: 'Delivered', align: 'right',
      cell: (row) => (
        <span className="tabular-nums">
          {formatNumber(row.delivered)}
          <span className="block text-xs text-muted-foreground">{rate(row.delivered, row.orders)}</span>
        </span>
      ),
    },
    { key: 'cancelled', header: 'Cancelled', align: 'right', hideOnMobile: true, cell: (row) => formatNumber(row.cancelled) },
    { key: 'returned', header: 'Returned', align: 'right', hideOnMobile: true, cell: (row) => formatNumber(row.returned) },
    { key: 'revenue', header: 'Revenue', align: 'right', cell: (row) => <Money value={row.revenue} /> },
    {
      key: 'spend', header: 'Ad spend', align: 'right',
      cell: (row) => (row.ad_spend === null ? <span className="text-muted-foreground" title="No ad spend can be tied to this">—</span> : <Money value={row.ad_spend} />),
    },
    {
      key: 'courier', header: 'Courier costs', align: 'right', hideOnMobile: true,
      cell: (row) => (
        <span title={`Delivery ${formatMoney(row.delivery_cost)} · returns ${formatMoney(row.return_cost)}`}>
          <Money value={toNumber(row.delivery_cost) + toNumber(row.return_cost)} muted />
          {toNumber(row.return_cost) > 0 && <span className="block text-xs text-muted-foreground">returns {formatMoney(row.return_cost)}</span>}
        </span>
      ),
    },
    {
      key: 'net', header: 'Net', align: 'right', hideOnMobile: true,
      cell: (row) => <Money value={row.net_revenue} className={toNumber(row.net_revenue) < 0 ? 'text-red-600' : undefined} />,
    },
    {
      key: 'cpo', header: 'Cost / order', align: 'right', hideOnMobile: true,
      cell: (row) => (row.cost_per_order === null ? '—' : (
        <span>
          <Money value={row.cost_per_order} />
          {row.cost_per_delivered !== null && <span className="block text-xs text-muted-foreground">{formatMoney(row.cost_per_delivered)} / delivered</span>}
        </span>
      )),
    },
    { key: 'roas', header: 'ROAS', align: 'right', cell: (row) => ratio(row.roas) },
  ]

  const chartRows = (r?.rows ?? []).filter((row) => toNumber(row.revenue) > 0 || toNumber(row.ad_spend) > 0)
  const chart = group === 'date'
    ? chartRows.map((row) => ({ name: row.key, revenue: toNumber(row.revenue), spend: toNumber(row.ad_spend) }))
    : [...chartRows].sort((a, b) => toNumber(b.revenue) + toNumber(b.ad_spend) - toNumber(a.revenue) - toNumber(a.ad_spend))
        .slice(0, 8).map((row) => ({ name: row.label, revenue: toNumber(row.revenue), spend: toNumber(row.ad_spend) }))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeFilter value={{ from: s.from, to: s.to }} onChange={(range) => update(range)} />
        <Select value={group} onValueChange={(v) => update({ group: v })}>
          <SelectTrigger size="sm" className="w-40" aria-label="Group by"><span className="text-muted-foreground">By</span> <SelectValue /></SelectTrigger>
          <SelectContent>{GROUPS.map((g) => <SelectItem key={g.value} value={g.value}>{g.label}</SelectItem>)}</SelectContent>
        </Select>
        <Select value={s.status || 'all'} onValueChange={(v) => update({ status: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-36" aria-label="Order status"><SelectValue /></SelectTrigger>
          <SelectContent>{STATUSES.map((x) => <SelectItem key={x.value || 'all'} value={x.value || 'all'}>{x.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      {trail.length > 0 && (
        <nav aria-label="Narrowed to" className="flex flex-wrap items-center gap-1 text-sm">
          <Button size="sm" variant="ghost" className="h-7 px-2"
            onClick={() => update({ source: '', medium: '', campaign: '', campaignName: '', adset: '', adsetName: '', ad: '', adName: '', product: '', productName: '', group: 'source' })}>
            All sales
          </Button>
          {trail.map((t, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="size-3.5 text-muted-foreground" />
              <Button size="sm" variant={i === trail.length - 1 ? 'secondary' : 'ghost'} className="h-7 px-2"
                onClick={() => update(Object.fromEntries(Object.entries(trail.slice(i + 1).reduce((acc, x) => ({ ...acc, ...x.clear }), {}))))}>
                {t.label}
              </Button>
            </span>
          ))}
        </nav>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Orders" value={totals ? formatNumber(totals.orders) : '—'}
          hint={totals ? `${rate(attributed, totals.orders)} with a known source` : undefined} />
        <StatCard label="Delivered revenue" value={totals ? formatMoney(totals.revenue) : '—'}
          hint={totals ? `${formatNumber(totals.delivered)} delivered · ${rate(totals.delivered, totals.orders)}` : undefined} />
        <StatCard label="Ad spend" value={spend === null ? '—' : formatMoney(spend)}
          hint={r?.spend_tracked === false ? 'Ad spend can’t be split by product' : 'Meta (synced) and other campaigns'} />
        <StatCard label="ROAS" value={spend && totals ? ratio(totals.revenue / spend) : '—'} hint="Delivered revenue ÷ ad spend" />
        <StatCard label="Cost per delivered order" value={spend && totals?.delivered ? formatMoney(spend / totals.delivered) : '—'}
          hint={r ? `Courier ${formatMoney(toNumber(r.costs.delivery) + toNumber(r.costs.returns))}` : undefined} />
      </div>

      {chart.length > 1 && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Revenue and ad spend{group === 'date' ? ' by day' : ` by ${GROUPS.find((g) => g.value === group)?.label.toLowerCase()}`}</CardTitle></CardHeader>
          <CardContent>
            <BarsChart format="money" xKey="name" dateAxis={group === 'date'} data={chart}
              series={[{ key: 'revenue', label: 'Delivered revenue', slot: 1 }, ...(r?.spend_tracked ? [{ key: 'spend', label: 'Ad spend', slot: 2 }] : [])]} />
          </CardContent>
        </Card>
      )}

      <DataTable columns={columns} rows={r?.rows} rowKey={(row) => row.key} loading={report.isFetching} error={report.error}
        onRetry={() => report.refetch()} onRowClick={NEXT[group] ? drill : undefined}
        empty={<EmptyState icon={<Route className="size-5" />} title="No orders in this period" description="Try a longer date range or clear the filters." />} />

      <p className="flex gap-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        <span>
          An order counts for a campaign, ad set or ad only when the link the customer clicked carried its id (set the URL parameters under
          Meta Ads → Tracking). Orders that arrived without tracking data are shown as Unknown and never get ad spend. Ad spend is what Meta
          reports, converted at your rate; revenue and ROAS use delivered orders only.
        </span>
      </p>
    </div>
  )
}
