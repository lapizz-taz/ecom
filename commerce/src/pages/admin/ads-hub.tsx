import { keepPreviousData, useQuery } from '@tanstack/react-query'
import {
  AlertTriangle, ArrowRight, BarChart3, Clock, Coins, Gauge, Megaphone, PackageCheck, PiggyBank, Receipt, Rocket, ShoppingBag, Undo2,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router'
import { type Column, DataTable } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BarsChart, TrendChart } from '@/features/reports/charts'
import { useDateRange } from '@/hooks/use-date-range'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatMoney, formatNumber, toNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type AdPlatformCode, type AdsCampaign, type AdsReport, adsReport, type CampaignVerdict } from '@/services/marketing'

type Tab = 'dashboard' | 'quality' | 'profit' | 'sales' | 'spend'
const TABS: Array<{ key: Tab; label: string; icon: typeof Receipt }> = [
  { key: 'dashboard', label: 'Dashboard', icon: BarChart3 },
  { key: 'quality', label: 'Campaign quality', icon: Gauge },
  { key: 'profit', label: 'Profit analysis', icon: PiggyBank },
  { key: 'sales', label: 'Sales & hours', icon: Clock },
  { key: 'spend', label: 'Ad spend', icon: Coins },
]
const PLATFORMS: Array<{ key: AdPlatformCode | ''; label: string }> = [
  { key: '', label: 'All platforms' }, { key: 'META', label: 'Meta' }, { key: 'TIKTOK', label: 'TikTok' }, { key: 'GOOGLE', label: 'Google' }, { key: 'OTHER', label: 'Other' },
]
const PLATFORM_STYLE: Record<AdPlatformCode, { label: string; dot: string; page: string | null }> = {
  META: { label: 'Meta', dot: 'bg-blue-500', page: '/admin/marketing?tab=meta' },
  TIKTOK: { label: 'TikTok', dot: 'bg-pink-500', page: '/admin/marketing/tiktok' },
  GOOGLE: { label: 'Google', dot: 'bg-amber-500', page: '/admin/marketing/google' },
  OTHER: { label: 'Other', dot: 'bg-slate-400', page: null },
}
export const VERDICT: Record<CampaignVerdict, { label: string; className: string; hint: string }> = {
  SCALE: { label: 'Scale', className: 'bg-emerald-500/15 text-emerald-600', hint: 'Delivers well and makes money — give it more budget' },
  KEEP: { label: 'Keep', className: 'bg-sky-500/15 text-sky-600', hint: 'Healthy; keep running and watch returns' },
  FIX: { label: 'Fix', className: 'bg-amber-500/15 text-amber-600', hint: 'Too many returns or cancels, or not profitable yet — check audience, creative and price' },
  STOP: { label: 'Stop', className: 'bg-red-500/15 text-red-600', hint: 'Customers from this campaign do not receive their parcels — pause it' },
  WAIT: { label: 'Wait', className: 'bg-muted text-muted-foreground', hint: 'Fewer than 3 orders delivered or returned yet' },
}
const GRADE_STYLE: Record<string, string> = {
  A: 'bg-emerald-500 text-white', B: 'bg-sky-500 text-white', C: 'bg-amber-500 text-white', D: 'bg-red-500 text-white',
}
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${formatNumber(v, 1)}%`)
const ratio = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${formatNumber(v, 2)}×`)

export default function AdsHubPage() {
  const [range, setRange] = useDateRange('30d')
  const [state, update] = useUrlState({ tab: 'dashboard', platform: '' })
  const tab = (TABS.some((t) => t.key === state.tab) ? state.tab : 'dashboard') as Tab
  const platform = state.platform as AdPlatformCode | ''
  const report = useQuery({
    queryKey: ['ads-hub', range.from, range.to, platform],
    queryFn: () => adsReport(range.from, range.to, platform),
    placeholderData: keepPreviousData,
  })
  const r = report.data

  return (
    <div className="space-y-4">
      <PageHeader
        title="Ads"
        description="Every campaign judged by what its customers actually did: delivered, returned or cancelled — not by clicks."
        actions={
          <>
            <Button size="sm" variant="outline" asChild><Link to="/admin/finance/income-expense?tab=expense"><Receipt /> Ad expenses</Link></Button>
            <Button size="sm" variant="outline" asChild><Link to="/admin/marketing?tab=tracking"><Megaphone /> Tracking setup</Link></Button>
          </>
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 rounded-xl border bg-card p-1" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} onClick={() => update({ tab: t.key })}
              className={cn('press flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-colors',
                tab === t.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
              <t.icon className="size-3.5" /> {t.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={platform || 'all'} onValueChange={(v) => update({ platform: v === 'all' ? '' : v })}>
            <SelectTrigger size="sm" className="w-36" aria-label="Platform"><SelectValue /></SelectTrigger>
            <SelectContent>{PLATFORMS.map((p) => <SelectItem key={p.key || 'all'} value={p.key || 'all'}>{p.label}</SelectItem>)}</SelectContent>
          </Select>
          <DateRangeFilter value={range} onChange={setRange} />
        </div>
      </div>

      {report.error ? <ErrorState error={report.error} onRetry={() => report.refetch()} /> : !r ? <CardsSkeleton count={8} /> : (
        <>
          {tab === 'dashboard' && <Dashboard r={r} onTab={(t) => update({ tab: t })} />}
          {tab === 'quality' && <Quality campaigns={r.campaigns} />}
          {tab === 'profit' && <Profit r={r} />}
          {tab === 'sales' && <Sales r={r} />}
          {tab === 'spend' && <Spend r={r} />}
        </>
      )}
    </div>
  )
}

function Kpi({ label, value, hint, icon: Icon, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; icon: typeof Receipt; tone?: string }) {
  return (
    <div className="min-w-0 rounded-xl border bg-card p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase"><Icon className="size-3.5" />{label}</p>
      <p className={cn('mt-1 truncate text-xl font-semibold tabular-nums', tone)}>{value}</p>
      {hint && <p className="truncate text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}

function Dashboard({ r, onTab }: { r: AdsReport; onTab: (t: Tab) => void }) {
  const t = r.totals
  const settled = toNumber(t.delivered) + toNumber(t.returned)
  const deliveryRate = settled > 0 ? (100 * toNumber(t.delivered)) / settled : null
  const attention = r.campaigns.filter((c) => c.verdict === 'STOP' || c.verdict === 'FIX').slice(0, 5)
  const best = r.campaigns.filter((c) => c.verdict === 'SCALE' || c.verdict === 'KEEP').sort((a, b) => toNumber(b.profit) - toNumber(a.profit)).slice(0, 5)
  return (
    <div className="space-y-4">
      <section className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Kpi label="Ad spend" icon={Coins} value={<Money value={t.spend} />} hint={t.spend_usd ? `$${formatNumber(t.spend_usd, 2)} in USD` : `${formatNumber(t.impressions)} impressions`} />
        <Kpi label="Orders from ads" icon={ShoppingBag} value={formatNumber(t.orders)} hint={`${formatNumber(t.in_progress)} still on the way`} />
        <Kpi label="Delivered" icon={PackageCheck} value={formatNumber(t.delivered)} hint={`${pct(deliveryRate)} delivery rate`} tone={deliveryRate !== null && deliveryRate < 70 ? 'text-amber-600' : undefined} />
        <Kpi label="Returned · cancelled" icon={Undo2} value={`${formatNumber(t.returned)} · ${formatNumber(t.cancelled)}`} hint="from ad orders" />
        <Kpi label="Delivered revenue" icon={Receipt} value={<Money value={t.revenue} />} hint={`ROAS ${ratio(toNumber(t.spend) > 0 ? toNumber(t.revenue) / toNumber(t.spend) : null)}`} />
        <Kpi label="Cost per delivered" icon={Gauge} value={toNumber(t.delivered) > 0 ? <Money value={toNumber(t.spend) / toNumber(t.delivered)} /> : '—'}
          hint={toNumber(t.orders) > 0 ? <>per order <Money value={toNumber(t.spend) / toNumber(t.orders)} /></> : undefined} />
        <Kpi label="Est. profit" icon={PiggyBank} value={<Money value={t.profit} signed />} tone={toNumber(t.profit) < 0 ? 'text-red-600' : 'text-emerald-600'}
          hint="revenue − goods − courier − ads" />
        <Kpi label="Clicks" icon={Rocket} value={formatNumber(t.clicks)} hint={toNumber(t.clicks) > 0 ? `${pct((100 * toNumber(t.orders)) / toNumber(t.clicks))} became orders` : undefined} />
      </section>

      {toNumber(t.unknown_campaign_orders) > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-400/50 bg-amber-500/10 p-3 text-sm">
          <AlertTriangle className="size-4 text-amber-600" />
          <span className="flex-1">{t.unknown_campaign_orders} paid-traffic order{t.unknown_campaign_orders === 1 ? '' : 's'} came without a campaign ID, so they can't be credited to a campaign.</span>
          <Button size="sm" variant="outline" asChild><Link to="/admin/marketing?tab=tracking">Fix the links</Link></Button>
        </div>
      )}

      <section className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {r.platforms.map((p) => {
          const s = PLATFORM_STYLE[p.platform]
          return (
            <div key={p.platform} className="rounded-xl border bg-card p-4">
              <div className="flex items-center justify-between">
                <p className="flex items-center gap-2 font-medium"><span className={cn('size-2.5 rounded-full', s.dot)} />{s.label}</p>
                {s.page && <Link to={s.page} className="text-xs text-muted-foreground hover:text-foreground">Open <ArrowRight className="inline size-3" /></Link>}
              </div>
              <p className="mt-2 text-lg font-semibold tabular-nums"><Money value={p.spend} /></p>
              <dl className="mt-1 grid grid-cols-3 gap-1 text-xs">
                <div><dt className="text-muted-foreground">Orders</dt><dd className="font-medium tabular-nums">{p.orders}</dd></div>
                <div><dt className="text-muted-foreground">Delivered</dt><dd className="font-medium tabular-nums">{pct(p.delivery_rate)}</dd></div>
                <div><dt className="text-muted-foreground">ROAS</dt><dd className="font-medium tabular-nums">{ratio(p.roas)}</dd></div>
              </dl>
            </div>
          )
        })}
      </section>

      <Card>
        <CardHeader><CardTitle className="text-sm">Spend and delivered revenue</CardTitle></CardHeader>
        <CardContent>
          <BarsChart data={r.days} xKey="date" dateAxis format="money" height={240}
            series={[{ key: 'spend', label: 'Ad spend', slot: 4 }, { key: 'revenue', label: 'Delivered revenue', slot: 2 }]} />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
        <ShortList title="Needs attention" empty="No campaign is losing parcels right now." campaigns={attention} onMore={() => onTab('quality')} />
        <ShortList title="Best performers" empty="No campaign has enough delivered orders yet." campaigns={best} onMore={() => onTab('quality')} />
      </div>
    </div>
  )
}

function ShortList({ title, empty, campaigns, onMore }: { title: string; empty: string; campaigns: AdsCampaign[]; onMore: () => void }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-sm">{title}</CardTitle>
        <Button size="sm" variant="ghost" onClick={onMore}>All campaigns <ArrowRight /></Button>
      </CardHeader>
      <CardContent className="space-y-2">
        {campaigns.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : campaigns.map((c) => (
          <div key={c.key} className="flex items-center gap-3 rounded-lg border p-2.5">
            <Grade c={c} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{c.name}</p>
              <p className="text-xs text-muted-foreground">{c.delivered} delivered · {c.returned} returned · {c.cancelled} cancelled · {pct(c.delivery_rate)}</p>
            </div>
            <VerdictBadge v={c.verdict} />
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function Grade({ c }: { c: AdsCampaign }) {
  return (
    <span title={c.score !== null ? `Quality score ${c.score}/100` : 'Not enough settled orders yet'}
      className={cn('grid size-8 shrink-0 place-items-center rounded-lg text-sm font-bold', c.grade ? GRADE_STYLE[c.grade] : 'bg-muted text-muted-foreground')}>
      {c.grade ?? '·'}
    </span>
  )
}

function VerdictBadge({ v }: { v: CampaignVerdict }) {
  return <span title={VERDICT[v].hint} className={cn('rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase', VERDICT[v].className)}>{VERDICT[v].label}</span>
}

const SORTS: Record<string, { label: string; value: (c: AdsCampaign) => number }> = {
  spend: { label: 'Highest spend', value: (c) => toNumber(c.spend) },
  score: { label: 'Best quality', value: (c) => c.score ?? -1 },
  worst: { label: 'Worst quality', value: (c) => (c.score === null ? -1000 : -c.score) },
  profit: { label: 'Most profit', value: (c) => toNumber(c.profit) },
  delivered: { label: 'Most delivered', value: (c) => c.delivered },
  returns: { label: 'Most returns', value: (c) => c.returned + c.cancelled },
}

function Quality({ campaigns }: { campaigns: AdsCampaign[] }) {
  const [sort, setSort] = useState('spend')
  const [verdict, setVerdict] = useState<CampaignVerdict | ''>('')
  const rows = useMemo(() => [...campaigns].filter((c) => !verdict || c.verdict === verdict).sort((a, b) => SORTS[sort].value(b) - SORTS[sort].value(a)), [campaigns, sort, verdict])
  const columns: Column<AdsCampaign>[] = [
    {
      key: 'name', header: 'Campaign', primary: true,
      cell: (c) => (
        <div className="flex max-w-72 items-center gap-2.5">
          <Grade c={c} />
          <div className="min-w-0">
            <p className={cn('truncate font-medium', c.unknown && 'text-muted-foreground italic')} title={c.name}>{c.name}</p>
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className={cn('size-1.5 rounded-full', PLATFORM_STYLE[c.platform].dot)} />{PLATFORM_STYLE[c.platform].label}{c.score !== null ? ` · score ${c.score}` : ''}</p>
          </div>
        </div>
      ),
    },
    { key: 'verdict', header: 'Verdict', cell: (c) => <VerdictBadge v={c.verdict} /> },
    { key: 'spend', header: 'Spend', align: 'right', cell: (c) => <Money value={c.spend} /> },
    { key: 'orders', header: 'Orders', align: 'right', cell: (c) => <span className="tabular-nums">{c.orders}{c.in_progress ? <span className="text-xs text-muted-foreground"> · {c.in_progress} on way</span> : null}</span> },
    {
      key: 'delivered', header: 'Delivered', align: 'right',
      cell: (c) => (
        <div className="tabular-nums">
          <span className="font-medium">{c.delivered}</span>
          <p className={cn('text-xs', c.delivery_rate === null ? 'text-muted-foreground' : c.delivery_rate >= 80 ? 'text-emerald-600' : c.delivery_rate >= 60 ? 'text-amber-600' : 'text-red-600')}>{pct(c.delivery_rate)}</p>
        </div>
      ),
    },
    { key: 'returned', header: 'Returned', align: 'right', cell: (c) => <div className="tabular-nums">{c.returned}<p className="text-xs text-muted-foreground">{pct(c.return_rate)}</p></div> },
    { key: 'cancelled', header: 'Cancelled', align: 'right', hideOnMobile: true, cell: (c) => <div className="tabular-nums">{c.cancelled}<p className="text-xs text-muted-foreground">{pct(c.cancel_rate)}</p></div> },
    { key: 'cpd', header: 'Cost / delivered', align: 'right', hideOnMobile: true, cell: (c) => (c.cost_per_delivered === null ? '—' : <Money value={c.cost_per_delivered} />) },
    { key: 'roas', header: 'ROAS', align: 'right', hideOnMobile: true, cell: (c) => <span className="tabular-nums" title="Delivered revenue ÷ spend">{ratio(c.roas)}</span> },
    { key: 'profit', header: 'Est. profit', align: 'right', cell: (c) => <Money value={c.profit} signed className={toNumber(c.profit) < 0 ? 'text-red-600' : 'text-emerald-600'} /> },
  ]
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1">
          {(['', 'SCALE', 'KEEP', 'FIX', 'STOP', 'WAIT'] as const).map((v) => (
            <button key={v || 'all'} type="button" onClick={() => setVerdict(v)} aria-pressed={verdict === v}
              className={cn('press rounded-full border px-3 py-1 text-xs', verdict === v ? 'border-foreground bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>
              {v ? `${VERDICT[v].label} · ${campaigns.filter((c) => c.verdict === v).length}` : `All · ${campaigns.length}`}
            </button>
          ))}
        </div>
        <Select value={sort} onValueChange={setSort}>
          <SelectTrigger size="sm" className="ml-auto w-40" aria-label="Sort"><SelectValue /></SelectTrigger>
          <SelectContent>{Object.entries(SORTS).map(([k, s]) => <SelectItem key={k} value={k}>{s.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>
      <DataTable columns={columns} rows={rows} rowKey={(c) => `${c.platform}:${c.key}`}
        empty={<EmptyState title="No ad campaigns in this period" description="Connect an ad account or widen the dates." />} />
      <Card>
        <CardContent className="grid gap-2 text-xs text-muted-foreground md:grid-cols-2">
          <p><strong className="text-foreground">How quality is scored (0–100):</strong> 60 points for the delivery rate (delivered ÷ delivered + returned), 20 for orders not cancelled, 20 for ROAS on delivered revenue (4× or better earns all 20). A ≥ 80, B ≥ 65, C ≥ 50, D below. Campaigns need 3 settled orders before they are graded.</p>
          <p><strong className="text-foreground">Est. profit</strong> = delivered revenue − cost of goods − courier charges (including return charges) − ad spend. Orders count for a campaign only when their link carried its campaign ID.</p>
        </CardContent>
      </Card>
    </div>
  )
}

function Profit({ r }: { r: AdsReport }) {
  const t = r.totals
  const steps = [
    { label: 'Delivered revenue', value: toNumber(t.revenue), tone: 'text-foreground' },
    { label: 'Cost of goods', value: -toNumber(t.cogs), tone: 'text-muted-foreground' },
    { label: 'Courier charges', value: -toNumber(t.courier_cost), tone: 'text-muted-foreground' },
    { label: 'Ad spend', value: -toNumber(t.spend), tone: 'text-muted-foreground' },
  ]
  const ranked = [...r.campaigns].filter((c) => !c.unknown).sort((a, b) => toNumber(b.profit) - toNumber(a.profit))
  const max = Math.max(1, ...ranked.map((c) => Math.abs(toNumber(c.profit))))
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[360px_1fr] [&>*]:min-w-0">
        <Card>
          <CardHeader><CardTitle className="text-sm">Where the money went</CardTitle></CardHeader>
          <CardContent>
            <dl className="space-y-2 text-sm">
              {steps.map((s) => (
                <div key={s.label} className="flex justify-between"><dt className={s.tone}>{s.label}</dt><dd className="tabular-nums"><Money value={s.value} signed={s.value < 0} /></dd></div>
              ))}
              <div className="flex justify-between border-t pt-2 font-semibold">
                <dt>Profit from ads</dt><dd className={cn('tabular-nums', toNumber(t.profit) < 0 ? 'text-red-600' : 'text-emerald-600')}><Money value={t.profit} signed /></dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-muted-foreground">Only orders with an ad campaign are counted. Returned and cancelled orders earn nothing but their courier charges still count.</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Profit by platform</CardTitle></CardHeader>
          <CardContent>
            <BarsChart data={r.platforms.map((p) => ({ name: PLATFORM_STYLE[p.platform].label, revenue: toNumber(p.revenue), spend: toNumber(p.spend), profit: toNumber(p.profit) }))}
              xKey="name" format="money" height={220}
              series={[{ key: 'revenue', label: 'Delivered revenue', slot: 2 }, { key: 'spend', label: 'Ad spend', slot: 4 }, { key: 'profit', label: 'Profit', slot: 1 }]} />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">Profit by campaign</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {ranked.length === 0 ? <p className="text-sm text-muted-foreground">No campaigns in this period.</p> : ranked.map((c) => {
            const v = toNumber(c.profit)
            return (
              <div key={`${c.platform}:${c.key}`} className="grid grid-cols-[minmax(0,14rem)_1fr_auto] items-center gap-3 text-sm">
                <span className="truncate" title={c.name}>{c.name}</span>
                <div className="relative h-2 rounded-full bg-muted">
                  <div className={cn('absolute top-0 h-2 rounded-full', v < 0 ? 'right-1/2 bg-red-500' : 'left-1/2 bg-emerald-500')} style={{ width: `${(50 * Math.abs(v)) / max}%` }} />
                  <div className="absolute top-[-2px] left-1/2 h-3 w-px bg-border" />
                </div>
                <Money value={v} signed className={cn('w-28 text-right tabular-nums', v < 0 ? 'text-red-600' : 'text-emerald-600')} />
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}

function Sales({ r }: { r: AdsReport }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2 [&>*]:min-w-0">
      <Card>
        <CardHeader><CardTitle className="text-sm">Orders from ads by hour</CardTitle></CardHeader>
        <CardContent>
          <BarsChart data={r.hours.map((h) => ({ hour: `${String(h.hour).padStart(2, '0')}:00`, orders: h.orders, delivered: h.delivered }))} xKey="hour" height={260}
            series={[{ key: 'orders', label: 'Orders', slot: 1 }, { key: 'delivered', label: 'Delivered', slot: 2 }]} />
          <p className="mt-2 text-xs text-muted-foreground">When ad customers order (store time) — useful for ad scheduling and when to staff the call team.</p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">Products sold through ads</CardTitle></CardHeader>
        <CardContent className="p-0">
          {r.products.length === 0 ? <p className="px-6 pb-6 text-sm text-muted-foreground">No ad orders in this period.</p> : (
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground"><tr className="border-b"><th className="px-6 py-2 text-left font-medium">Product</th><th className="px-3 py-2 text-right font-medium">Qty</th><th className="px-3 py-2 text-right font-medium">Delivered</th><th className="px-6 py-2 text-right font-medium">Returned</th></tr></thead>
              <tbody>
                {r.products.map((p) => (
                  <tr key={p.name} className="border-b last:border-0">
                    <td className="max-w-56 truncate px-6 py-2">{p.name}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.quantity}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{p.delivered}/{p.orders}</td>
                    <td className={cn('px-6 py-2 text-right tabular-nums', p.returned > 0 && 'text-red-600')}>{p.returned}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Spend({ r }: { r: AdsReport }) {
  const days = [...r.days].reverse().filter((d) => toNumber(d.spend) > 0 || d.orders > 0)
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-sm">Daily ad spend</CardTitle>
          <Button size="sm" variant="outline" asChild><Link to="/admin/finance/income-expense?tab=expense"><Receipt /> Go to expenses</Link></Button>
        </CardHeader>
        <CardContent>
          <TrendChart data={r.days} xKey="date" format="money" height={220} area series={[{ key: 'spend', label: 'Ad spend', slot: 4 }]} />
        </CardContent>
      </Card>
      <Card className="gap-0 py-0">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted-foreground">
            <tr className="border-b"><th className="px-4 py-2.5 text-left font-medium">Date</th><th className="px-3 py-2.5 text-right font-medium">Spend</th><th className="px-3 py-2.5 text-right font-medium">Orders</th>
              <th className="px-3 py-2.5 text-right font-medium">Delivered</th><th className="px-3 py-2.5 text-right font-medium">Cost / order</th><th className="px-4 py-2.5 text-right font-medium">Delivered revenue</th></tr>
          </thead>
          <tbody>
            {days.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No ad spend in this period.</td></tr>}
            {days.map((d) => (
              <tr key={d.date} className="border-b last:border-0">
                <td className="px-4 py-2 text-muted-foreground">{formatDate(d.date)}</td>
                <td className="px-3 py-2 text-right font-medium tabular-nums">{formatMoney(d.spend)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{d.orders}</td>
                <td className="px-3 py-2 text-right tabular-nums">{d.delivered}</td>
                <td className="px-3 py-2 text-right tabular-nums">{d.orders > 0 && toNumber(d.spend) > 0 ? formatMoney(toNumber(d.spend) / d.orders) : '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums">{formatMoney(d.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  )
}
