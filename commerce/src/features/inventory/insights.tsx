import {
  AlertTriangle, ArchiveX, BarChart3, Boxes, CalendarClock, ChevronRight, PackageX, Settings2, ShoppingCart, TrendingUp,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { Money } from '@/components/common/money'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge, type BadgeVariant } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { formatDate, formatMoney, formatNumber, timeAgo, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type InsightItem, type Insights, setPurchasePrefill } from '@/services/inventory'

export const INSIGHT_STATUS: Record<InsightItem['status'], { label: string; variant: BadgeVariant }> = {
  OUT: { label: 'Out of stock', variant: 'danger' },
  CRITICAL: { label: 'Critical', variant: 'danger' },
  LOW: { label: 'Low', variant: 'warning' },
  DEAD: { label: 'Dead stock', variant: 'neutral' },
  OK: { label: 'Healthy', variant: 'success' },
}

const name = (i: InsightItem) => `${i.product_name}${i.variant_title && i.variant_title !== 'Default' ? ` · ${i.variant_title}` : ''}`
const days = (n: number | null) => (n === null ? '—' : n >= 365 ? '1y+' : `${Math.floor(n)}d`)

function Thumb({ i }: { i: InsightItem }) {
  const [broken, setBroken] = useState(false)
  return i.image_url && !broken
    ? <img src={i.image_url} alt="" className="size-10 shrink-0 rounded-md border object-cover" loading="lazy" onError={() => setBroken(true)} />
    : <div className="size-10 shrink-0 rounded-md border bg-muted" />
}

/** Lead time, target cover and dead-stock age; the numbers behind every suggestion. */
export function InsightSettings({ lead, cover, dead, onChange }: { lead: number; cover: number; dead: number; onChange: (v: { lead: number; cover: number; dead: number }) => void }) {
  const [v, setV] = useState({ lead, cover, dead })
  return (
    <Popover onOpenChange={(o) => o && setV({ lead, cover, dead })}>
      <PopoverTrigger asChild><Button size="sm" variant="outline"><Settings2 /> {lead}d lead · {cover}d cover</Button></PopoverTrigger>
      <PopoverContent align="end" className="grid w-72 gap-3">
        {([
          ['lead', 'Supplier lead time (days)', 'How long a purchase takes to arrive'],
          ['cover', 'Stock to keep (days of sales)', 'Reorder enough for this many days after it arrives'],
          ['dead', 'Dead stock after (days)', 'No sale for this long while there is stock'],
        ] as const).map(([k, l, h]) => (
          <div key={k} className="grid gap-1">
            <Label htmlFor={`ins-${k}`} className="text-xs">{l}</Label>
            <Input id={`ins-${k}`} type="number" min={k === 'dead' ? 7 : k === 'cover' ? 1 : 0} value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} className="h-8" />
            <p className="text-[11px] text-muted-foreground">{h}</p>
          </div>
        ))}
        <Button size="sm" onClick={() => onChange(v)}>Apply</Button>
      </PopoverContent>
    </Popover>
  )
}

export function InsightsOverview({ data, go }: { data: Insights; go: (view: string) => void }) {
  const navigate = useNavigate()
  const s = useMemo(() => {
    const it = data.items
    return {
      tracked: it.length,
      out: it.filter((i) => i.status === 'OUT').length,
      critical: it.filter((i) => i.status === 'CRITICAL').length,
      low: it.filter((i) => i.status === 'LOW').length,
      dead: it.filter((i) => i.dead),
      value: it.reduce((t, i) => t + toNumber(i.stock_value), 0),
      fast: [...it].filter((i) => i.sold_30 > 0).sort((a, b) => b.sold_30 - a.sold_30).slice(0, 8),
    }
  }, [data])
  const deadValue = s.dead.reduce((t, i) => t + toNumber(i.stock_value), 0)
  const urgent = s.out + s.critical
  return (
    <div className="space-y-4">
      {urgent > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-300 bg-red-50 px-4 py-3 text-red-900">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">Attention needed</p>
              <p className="text-sm opacity-90">{s.out} out of stock and {s.critical} will run out before a new purchase arrives ({data.lead_days} days).</p>
            </div>
          </div>
          <Button size="sm" variant="outline" className="border-red-300 bg-transparent text-red-900" onClick={() => go('alerts')}>View alerts <ChevronRight /></Button>
        </div>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <StatCard label="Products tracked" value={formatNumber(s.tracked)} icon={<Boxes />} />
        <StatCard label="Out of stock" value={formatNumber(s.out)} tone={s.out ? 'negative' : undefined} icon={<PackageX />} />
        <StatCard label="Low / critical" value={formatNumber(s.low + s.critical)} tone={s.low + s.critical ? 'warning' : undefined} icon={<AlertTriangle />} />
        <StatCard label="Dead stock" value={formatNumber(s.dead.length)} hint={`${formatMoney(deadValue)} tied up`} icon={<ArchiveX />} />
        <StatCard label="Stock value (cost)" value={formatMoney(s.value)} className="col-span-2 lg:col-span-1" />
      </div>
      <div>
        <h2 className="mb-2 text-sm font-medium text-muted-foreground">Quick actions</h2>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {([
            [ArchiveX, 'Dead stock', 'Find slow movers', () => go('dead')],
            [BarChart3, 'ABC analysis', 'What earns the most', () => go('abc')],
            [CalendarClock, 'Forecast', 'When stock runs out', () => go('forecast')],
            [ShoppingCart, 'New purchase', 'Restock from a supplier', () => navigate('/admin/purchases/new')],
          ] as const).map(([Icon, t, d, fn]) => (
            <button key={t} type="button" onClick={fn} className="press flex flex-col items-center gap-1.5 rounded-xl border bg-card p-4 text-center transition-colors hover:bg-muted/40">
              <Icon className="size-5 text-muted-foreground" />
              <span className="text-sm font-medium">{t}</span>
              <span className="text-xs text-muted-foreground">{d}</span>
            </button>
          ))}
        </div>
      </div>
      <Card className="gap-0 p-0">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="flex items-center gap-2 font-medium"><TrendingUp className="size-4" /> Fast movers (30 days)</h2>
          <Button size="sm" variant="ghost" onClick={() => go('forecast')}>View all <ChevronRight /></Button>
        </div>
        {s.fast.length === 0 ? <p className="px-4 py-6 text-sm text-muted-foreground">No sales in the last 30 days yet.</p> : (
          <div className="divide-y">
            {s.fast.map((i) => (
              <div key={i.variant_id} className="flex items-center gap-3 px-4 py-2.5">
                <Thumb i={i} />
                <div className="min-w-0 flex-1">
                  <Link to={`/admin/products/${i.product_id}`} className="block truncate text-sm font-medium hover:underline">{name(i)}</Link>
                  <p className="text-xs text-muted-foreground">{i.sku}</p>
                </div>
                <div className="hidden text-right text-xs sm:block"><p className="font-medium tabular-nums">{i.sold_30} sold</p><p className="text-muted-foreground">30 days</p></div>
                <div className="w-16 text-right text-xs"><p className="font-medium tabular-nums">{formatNumber(i.available)}</p><p className="text-muted-foreground">in stock</p></div>
                <Badge variant={INSIGHT_STATUS[i.status].variant} className="w-20 justify-center">{INSIGHT_STATUS[i.status].label}</Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  )
}

/** Low stock alerts with a sales-based reorder suggestion, ready to turn into a purchase order. */
export function LowStockAlerts({ data }: { data: Insights }) {
  const navigate = useNavigate()
  const [filter, setFilter] = useState<'all' | 'OUT' | 'CRITICAL' | 'LOW'>('all')
  const [q, setQ] = useState('')
  const [qty, setQty] = useState<Record<string, number>>({})
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const alerts = useMemo(() => data.items.filter((i) => ['OUT', 'CRITICAL', 'LOW'].includes(i.status))
    .sort((a, b) => ['OUT', 'CRITICAL', 'LOW'].indexOf(a.status) - ['OUT', 'CRITICAL', 'LOW'].indexOf(b.status) || (a.cover_days ?? 0) - (b.cover_days ?? 0)), [data])
  const shown = alerts.filter((i) => (filter === 'all' || i.status === filter) && (!q || `${name(i)} ${i.sku}`.toLowerCase().includes(q.toLowerCase())))
  const want = (i: InsightItem) => qty[i.variant_id] ?? Math.max(i.suggest ?? 0, i.status === 'OUT' && !i.suggest ? Math.max(i.low_stock_threshold, 1) : 0)
  const purchase = (items: InsightItem[]) => {
    setPurchasePrefill(items.filter((i) => want(i) > 0).map((i) => ({ variant_id: i.variant_id, label: `${name(i)} (${i.sku})`, quantity: want(i), unit_cost: toNumber(i.unit_cost) })))
    navigate('/admin/purchases/new')
  }
  const count = (s: string) => alerts.filter((i) => i.status === s).length
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {([['all', 'All alerts', alerts.length], ['OUT', 'Out of stock', count('OUT')], ['CRITICAL', 'Critical', count('CRITICAL')], ['LOW', 'Low', count('LOW')]] as const).map(([k, l, n]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} aria-pressed={filter === k}
            className={cn('press rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40', filter === k && 'border-foreground/40')}>
            <p className="text-xs font-medium text-muted-foreground">{l}</p>
            <p className={cn('text-xl font-semibold tabular-nums', k === 'OUT' && n && 'text-red-600', k === 'CRITICAL' && n && 'text-red-600', k === 'LOW' && n && 'text-amber-600')}>{n}</p>
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Search product or SKU" className="sm:w-72" />
        {picked.size > 0 && (
          <Button size="sm" onClick={() => purchase(alerts.filter((i) => picked.has(i.variant_id)))}><ShoppingCart /> Create purchase order ({picked.size})</Button>
        )}
        <p className="ml-auto text-xs text-muted-foreground">Suggested = sales per day × ({data.lead_days} + {data.cover_days} days) − in stock − on order</p>
      </div>
      {shown.length === 0 ? <EmptyState title="No alerts" description="Every product has enough stock for its sales." /> : (
        <Card className="gap-0 divide-y p-0">
          {shown.map((i) => (
            <div key={i.variant_id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 sm:flex-nowrap">
              <Checkbox checked={picked.has(i.variant_id)} aria-label={`Select ${name(i)}`}
                onCheckedChange={(v) => setPicked((p) => { const n = new Set(p); if (v === true) n.add(i.variant_id); else n.delete(i.variant_id); return n })} />
              <Thumb i={i} />
              <div className="min-w-0 flex-1 basis-40">
                <div className="flex items-center gap-1.5">
                  <Link to={`/admin/products/${i.product_id}`} className="truncate text-sm font-medium hover:underline">{name(i)}</Link>
                  <Badge variant={INSIGHT_STATUS[i.status].variant} className="shrink-0 text-[10px]">{INSIGHT_STATUS[i.status].label}</Badge>
                  {i.abc === 'A' && <Badge variant="info" className="shrink-0 text-[10px]" title="Top sellers by revenue">A</Badge>}
                </div>
                <p className="text-xs text-muted-foreground">{i.sku} · {i.daily > 0 ? `${i.daily.toFixed(1)}/day` : 'no recent sales'}{i.last_sale_at ? ` · last sold ${timeAgo(i.last_sale_at)}` : ''}</p>
              </div>
              <div className="grid grid-cols-4 gap-3 text-center text-xs sm:w-72">
                <div><p className={cn('font-semibold tabular-nums', i.available <= 0 && 'text-red-600')}>{formatNumber(i.available)}</p><p className="text-muted-foreground">Stock</p></div>
                <div><p className="font-semibold tabular-nums">{i.sold_30}</p><p className="text-muted-foreground">Sold 30d</p></div>
                <div><p className="font-semibold tabular-nums">{days(i.cover_days)}</p><p className="text-muted-foreground">Left</p></div>
                <div title={i.incoming_expected ? `Expected ${formatDate(i.incoming_expected)}` : undefined}><p className="font-semibold tabular-nums">{i.incoming}</p><p className="text-muted-foreground">On order</p></div>
              </div>
              <div className="flex items-center gap-1.5">
                <Input type="number" min={0} value={want(i)} onChange={(e) => setQty({ ...qty, [i.variant_id]: Math.max(0, Number(e.target.value) || 0) })}
                  className="h-8 w-20 text-right tabular-nums" aria-label={`Quantity to buy for ${name(i)}`} />
                <Button size="sm" variant="outline" disabled={want(i) <= 0} onClick={() => purchase([i])}><ShoppingCart /> Purchase</Button>
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

export function DeadStock({ data }: { data: Insights }) {
  const items = useMemo(() => data.items.filter((i) => i.dead).sort((a, b) => toNumber(b.stock_value) - toNumber(a.stock_value)), [data])
  const value = items.reduce((t, i) => t + toNumber(i.stock_value), 0)
  const units = items.reduce((t, i) => t + i.on_hand, 0)
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Dead stock products" value={formatNumber(items.length)} />
        <StatCard label="Units sitting" value={formatNumber(units)} />
        <StatCard label="Money tied up (cost)" value={formatMoney(value)} tone={value ? 'warning' : undefined} className="col-span-2 sm:col-span-1" />
      </div>
      <p className="text-xs text-muted-foreground">No sale for {data.dead_days}+ days while there is stock. Ideas: a discount or bundle, a boosted ad, or stop reordering.</p>
      {items.length === 0 ? <EmptyState title="No dead stock" description={`Everything in stock sold within the last ${data.dead_days} days.`} /> : (
        <Card className="gap-0 divide-y p-0">
          {items.map((i) => (
            <div key={i.variant_id} className="flex items-center gap-3 px-3 py-2.5">
              <Thumb i={i} />
              <div className="min-w-0 flex-1">
                <Link to={`/admin/products/${i.product_id}`} className="block truncate text-sm font-medium hover:underline">{name(i)}</Link>
                <p className="text-xs text-muted-foreground">{i.sku} · {i.last_sale_at ? `last sold ${timeAgo(i.last_sale_at)}` : 'never sold'}</p>
              </div>
              <div className="text-right text-xs"><p className="font-semibold tabular-nums">{formatNumber(i.on_hand)}</p><p className="text-muted-foreground">units</p></div>
              <div className="w-24 text-right text-xs"><Money value={i.stock_value} className="font-semibold" /><p className="text-muted-foreground">at cost</p></div>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

export function AbcAnalysis({ data }: { data: Insights }) {
  const [cls, setCls] = useState<'A' | 'B' | 'C' | 'none'>('A')
  const groups = useMemo(() => {
    const total = data.items.reduce((t, i) => t + i.revenue_90, 0)
    return (['A', 'B', 'C', 'none'] as const).map((k) => {
      const it = data.items.filter((i) => (k === 'none' ? i.abc === null : i.abc === k))
      const revenue = it.reduce((t, i) => t + i.revenue_90, 0)
      return { k, items: it.sort((a, b) => b.revenue_90 - a.revenue_90), revenue, share: total ? (100 * revenue) / total : 0, value: it.reduce((t, i) => t + toNumber(i.stock_value), 0) }
    })
  }, [data])
  const LABEL = { A: 'A · top sellers', B: 'B · steady', C: 'C · slow', none: 'No sales (90d)' }
  const HINT = { A: 'About 80% of revenue. Never let these run out.', B: 'The next 15% of revenue. Keep a normal buffer.', C: 'The last 5%. Keep stock lean.', none: 'Nothing sold in 90 days. Check the Dead stock tab.' }
  const g = groups.find((x) => x.k === cls)!
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {groups.map((x) => (
          <button key={x.k} type="button" onClick={() => setCls(x.k)} aria-pressed={cls === x.k}
            className={cn('press rounded-xl border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/40', cls === x.k && 'border-foreground/40')}>
            <p className="text-xs font-medium text-muted-foreground">{LABEL[x.k]}</p>
            <p className="text-xl font-semibold tabular-nums">{x.items.length}</p>
            <p className="text-xs text-muted-foreground">{x.share.toFixed(0)}% of revenue · {formatMoney(x.value)} stock</p>
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{HINT[cls]} Based on the last 90 days of approved orders.</p>
      {g.items.length === 0 ? <EmptyState title="Nothing here" description="No products in this class." /> : (
        <Card className="gap-0 divide-y p-0">
          {g.items.map((i) => (
            <div key={i.variant_id} className="flex items-center gap-3 px-3 py-2.5">
              <Thumb i={i} />
              <div className="min-w-0 flex-1">
                <Link to={`/admin/products/${i.product_id}`} className="block truncate text-sm font-medium hover:underline">{name(i)}</Link>
                <p className="text-xs text-muted-foreground">{i.sku} · {i.sold_90} sold in 90 days</p>
              </div>
              <div className="w-24 text-right text-xs"><Money value={i.revenue_90} className="font-semibold" /><p className="text-muted-foreground">revenue</p></div>
              <div className="hidden w-16 text-right text-xs sm:block"><p className="font-semibold tabular-nums">{formatNumber(i.available)}</p><p className="text-muted-foreground">in stock</p></div>
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

export function Forecast({ data }: { data: Insights }) {
  const [q, setQ] = useState('')
  const items = useMemo(() => data.items.filter((i) => i.daily > 0).sort((a, b) => (a.cover_days ?? 1e9) - (b.cover_days ?? 1e9)), [data])
  const shown = items.filter((i) => !q || `${name(i)} ${i.sku}`.toLowerCase().includes(q.toLowerCase()))
  const runOut = (i: InsightItem) => (i.cover_days === null ? null : new Date(Date.now() + i.cover_days * 864e5).toISOString())
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={q} onChange={setQ} placeholder="Search product or SKU" className="sm:w-72" />
        <p className="ml-auto text-xs text-muted-foreground">Sales per day = 40% last 7 days + 40% last 30 days + 20% last 90 days</p>
      </div>
      {shown.length === 0 ? <EmptyState title="No sales to forecast from" description="Products appear here once they sell." /> : (
        <Card className="gap-0 overflow-x-auto p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b text-xs text-muted-foreground">
              <tr className="[&>th]:px-3 [&>th]:py-2 [&>th]:text-right [&>th]:font-medium">
                <th className="!text-left">Product</th><th>Per day</th><th>Next 7 days</th><th>Next 30 days</th><th>In stock</th><th>On order</th><th>Runs out</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {shown.map((i) => {
                const out = runOut(i)
                const soon = i.cover_days !== null && i.cover_days < data.lead_days
                return (
                  <tr key={i.variant_id} className="[&>td]:px-3 [&>td]:py-2 [&>td]:text-right [&>td]:tabular-nums">
                    <td className="!text-left"><Link to={`/admin/products/${i.product_id}`} className="font-medium hover:underline">{name(i)}</Link><p className="text-xs text-muted-foreground">{i.sku}</p></td>
                    <td>{i.daily.toFixed(1)}</td>
                    <td>{Math.ceil(i.daily * 7)}</td>
                    <td>{Math.ceil(i.daily * 30)}</td>
                    <td className={cn(i.available <= 0 && 'font-medium text-red-600')}>{formatNumber(i.available)}</td>
                    <td>{i.incoming || '—'}</td>
                    <td className={cn(soon && 'font-medium text-red-600')}>{i.available <= 0 ? 'Out now' : out ? formatDate(out) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}

export function InsightsState({ loading, error, onRetry }: { loading: boolean; error: unknown; onRetry: () => void }) {
  if (loading) return <LoadingState />
  if (error) return <ErrorState error={error} onRetry={onRetry} />
  return null
}
