import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { Download, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { cn } from '@/lib/utils'
import { Link } from 'react-router'
import { type Column, DataTable } from '@/components/common/data-table'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { Can } from '@/components/common/permission-gate'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAuth } from '@/features/auth/auth-context'
import { AdjustStockDialog, type AdjustTarget } from '@/features/inventory/adjust-stock-dialog'
import { useRealtimeInvalidate } from '@/hooks/use-realtime'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { formatMoney, formatNumber } from '@/lib/format'
import {
  AbcAnalysis, DeadStock, Forecast, InsightSettings, InsightsOverview, InsightsState, LowStockAlerts,
} from '@/features/inventory/insights'
import { inventoryInsights, listStock, type StockRow } from '@/services/inventory'
import { reports } from '@/services/reports'

const PAGE_SIZE = 50
const STATUS = { OUT_OF_STOCK: { label: 'Out of stock', variant: 'danger' }, LOW_STOCK: { label: 'Low', variant: 'warning' }, IN_STOCK: { label: 'In stock', variant: 'success' } } as const

export default function InventoryPage() {
  const { can } = useAuth()
  const [state, update] = useUrlState({ q: '', status: '', page: '1', view: '', lead: '7', cover: '30', dead: '60' })
  const view = state.view || (state.status ? 'stock' : 'overview')
  const lead = Number(state.lead) || 7, cover = Number(state.cover) || 30, dead = Number(state.dead) || 60
  const insights = useQuery({
    queryKey: ['inventory', 'insights', lead, cover, dead],
    enabled: view !== 'stock',
    staleTime: 60_000,
    queryFn: () => inventoryInsights(lead, cover, dead),
  })
  const page = Number(state.page) || 1
  const [target, setTarget] = useState<AdjustTarget | null>(null)
  const stock = useQuery({
    queryKey: ['inventory', 'stock', state],
    placeholderData: keepPreviousData,
    queryFn: () => listStock({ q: state.q, status: state.status as never, page, pageSize: PAGE_SIZE }),
    enabled: view === 'stock',
  })
  const valuation = useQuery({ queryKey: ['inventory', 'valuation'], queryFn: reports.inventoryValuation })
  useRealtimeInvalidate('inventory', [['inventory']])
  const totals = valuation.data?.totals

  const columns: Column<StockRow>[] = [
    {
      key: 'product', header: 'Product', primary: true,
      cell: (r) => <div><Link to={`/admin/products/${r.product_id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{r.product_name}</Link>
        <p className="text-xs text-muted-foreground">{r.variant_title !== 'Default' ? `${r.variant_title} · ` : ''}{r.sku}</p></div>,
    },
    { key: 'status', header: 'Status', cell: (r) => { const s = STATUS[r.stock_status as keyof typeof STATUS]; return s ? <Badge variant={s.variant}>{s.label}</Badge> : null } },
    { key: 'on_hand', header: 'On hand', align: 'right', cell: (r) => formatNumber(r.on_hand) },
    { key: 'reserved', header: 'Reserved', align: 'right', cell: (r) => formatNumber(r.reserved) },
    { key: 'available', header: 'Available', align: 'right', cell: (r) => <span className={(r.available ?? 0) <= 0 ? 'font-medium text-red-600' : 'font-medium'}>{formatNumber(r.available)}</span> },
    { key: 'damaged', header: 'Damaged', align: 'right', hideOnMobile: true, cell: (r) => formatNumber(r.damaged) },
    { key: 'value', header: 'Value (cost)', align: 'right', hideOnMobile: true, cell: (r) => <Money value={r.stock_value} muted /> },
    {
      key: 'action', header: '', align: 'right',
      cell: (r) => can('inventory.adjust') ? (
        <Button size="sm" variant="ghost" onClick={(e) => { e.stopPropagation(); setTarget({ variantId: r.variant_id!, label: `${r.product_name} · ${r.sku}`, onHand: r.on_hand, available: r.available, damaged: r.damaged }) }}>
          <SlidersHorizontal /> Adjust
        </Button>
      ) : null,
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader title="Inventory" description="Available = on hand − reserved for open orders. Suggestions follow your recent sales."
        actions={<>
          {view !== 'stock' && <InsightSettings lead={lead} cover={cover} dead={dead}
            onChange={(v) => update({ lead: String(v.lead), cover: String(v.cover), dead: String(v.dead) }, { resetPage: false })} />}
          <Button size="sm" variant="outline" asChild><Link to="/admin/inventory/movements">Stock movements</Link></Button>
          <Can permission="reports.export">
            <Button size="sm" variant="outline" onClick={() => valuation.data && downloadCsv('inventory-valuation', valuation.data.items, [
              { header: 'Product', value: (i) => i.product_name }, { header: 'Variant', value: (i) => i.variant_title }, { header: 'SKU', value: (i) => i.sku },
              { header: 'On hand', value: (i) => i.on_hand }, { header: 'Reserved', value: (i) => i.reserved }, { header: 'Available', value: (i) => i.available },
              { header: 'Damaged', value: (i) => i.damaged }, { header: 'Unit cost', value: (i) => i.unit_cost }, { header: 'Value at cost', value: (i) => i.value_at_cost },
            ])}><Download /> Valuation CSV</Button>
          </Can>
        </>} />
      <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist">
        {([['overview', 'Overview'], ['alerts', 'Low stock alerts'], ['stock', 'Stock'], ['dead', 'Dead stock'], ['abc', 'ABC analysis'], ['forecast', 'Forecast']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => update({ view: k, status: '', q: '' })}
            className={cn('shrink-0 rounded-full px-3.5 py-1.5 text-sm transition-colors', view === k ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-card hover:text-foreground')}>
            {l}
          </button>
        ))}
      </div>
      {view !== 'stock' && (insights.data ? (
        view === 'alerts' ? <LowStockAlerts data={insights.data} />
          : view === 'dead' ? <DeadStock data={insights.data} />
            : view === 'abc' ? <AbcAnalysis data={insights.data} />
              : view === 'forecast' ? <Forecast data={insights.data} />
                : <InsightsOverview data={insights.data} go={(v) => update({ view: v })} />
      ) : <InsightsState loading={insights.isLoading} error={insights.error} onRetry={() => insights.refetch()} />)}
      {view === 'stock' && <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Units on hand" value={formatNumber(totals?.units_on_hand)} hint={`${formatNumber(totals?.units_reserved)} reserved`} />
        <StatCard label="Stock value (cost)" value={formatMoney(totals?.value_at_cost)} hint={`Retail ${formatMoney(totals?.value_at_retail)}`} />
        <StatCard label="Low stock" value={formatNumber(totals?.low_stock_variants)} tone={totals?.low_stock_variants ? 'warning' : undefined} to="/admin/inventory?view=alerts" />
        <StatCard label="Out of stock" value={formatNumber(totals?.out_of_stock_variants)} tone={totals?.out_of_stock_variants ? 'negative' : undefined} to="/admin/inventory?view=stock&status=OUT_OF_STOCK" />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Tabs value={state.status || 'all'} onValueChange={(v) => update({ status: v === 'all' ? '' : v, view: 'stock' })}>
          <TabsList>
            <TabsTrigger value="all">All</TabsTrigger><TabsTrigger value="LOW_STOCK">Low stock</TabsTrigger>
            <TabsTrigger value="OUT_OF_STOCK">Out of stock</TabsTrigger><TabsTrigger value="IN_STOCK">In stock</TabsTrigger>
          </TabsList>
        </Tabs>
        <SearchInput value={state.q} onChange={(q) => update({ q })} placeholder="Search product or SKU" />
      </div>
      <DataTable columns={columns} rows={stock.data?.items} rowKey={(r) => r.variant_id!} loading={stock.isFetching} error={stock.error} onRetry={() => stock.refetch()}
        empty={<EmptyState title="No stock items" description="Products with stock tracking appear here." />}
        footer={<Pagination page={page} pageSize={PAGE_SIZE} total={stock.data?.total ?? 0} onPage={(p) => update({ page: String(p) }, { resetPage: false })} />} />
      </>}
      <AdjustStockDialog target={target} open={target !== null} onOpenChange={(o) => !o && setTarget(null)} />
    </div>
  )
}
