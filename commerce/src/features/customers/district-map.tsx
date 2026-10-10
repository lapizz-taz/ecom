import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, MapPinned, Sparkles, Users } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { toast } from '@/lib/toast'
import { Money } from '@/components/common/money'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/features/auth/auth-context'
import { formatMoney, formatNumber, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  assignCustomerDistrict, autoAssignDistricts, customersNeedingDistrict, type DistrictStat, districtStats, type UnassignedCustomer,
} from '@/services/customers'
import { BD_DISTRICTS, BD_VIEWBOX } from './bd-districts'

type Metric = 'customers' | 'orders' | 'revenue'
const METRICS: Array<{ key: Metric; label: string }> = [{ key: 'customers', label: 'Customers' }, { key: 'orders', label: 'Orders' }, { key: 'revenue', label: 'Delivered value' }]
const PERIODS: Array<{ key: string; label: string; days: number | null }> = [
  { key: '30', label: '30 days', days: 30 }, { key: '90', label: '90 days', days: 90 }, { key: '365', label: '12 months', days: 365 }, { key: 'all', label: 'All time', days: null },
]
const DISTRICT_NAMES = BD_DISTRICTS.map((d) => d.name).sort()
const value = (s: DistrictStat | undefined, m: Metric) => (s ? Number(s[m === 'revenue' ? 'revenue' : m]) : 0)
const show = (n: number, m: Metric) => (m === 'revenue' ? formatMoney(n) : formatNumber(n))

/** Customers on a map of Bangladesh's 64 districts, plus fixing orders with an unknown district. */
export function DistrictMap() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const [period, setPeriod] = useState('all')
  const [metric, setMetric] = useState<Metric>('customers')
  const [hover, setHover] = useState<{ name: string; x: number; y: number } | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const days = PERIODS.find((p) => p.key === period)?.days ?? null
  const stats = useQuery({ queryKey: ['customers', 'districts', days], queryFn: () => districtStats(days), staleTime: 60_000 })
  const byName = useMemo(() => new Map((stats.data?.districts ?? []).map((d) => [d.district, d])), [stats.data])
  const max = useMemo(() => Math.max(1, ...(stats.data?.districts ?? []).map((d) => value(d, metric))), [stats.data, metric])
  const top = useMemo(() => [...(stats.data?.districts ?? [])].sort((a, b) => value(b, metric) - value(a, metric)).slice(0, 8), [stats.data, metric])

  const auto = useMutation({
    mutationFn: autoAssignDistricts,
    onSuccess: (r) => {
      toast.success(r.customers ? `Matched ${r.customers} customer${r.customers === 1 ? '' : 's'} (${r.orders} orders) from their address` : 'No address named a district')
      if (r.left) toast.info(`${r.left} still need a district: pick it below`)
      void queryClient.invalidateQueries({ queryKey: ['customers'] })
    },
    onError: (e) => toast.error((e as Error).message),
  })

  if (stats.isLoading) return <LoadingState />
  if (stats.error || !stats.data) return <ErrorState error={stats.error} onRetry={() => stats.refetch()} />
  const t = stats.data.totals
  const sel = picked ? byName.get(picked) : undefined
  const hov = hover ? byName.get(hover.name) : undefined

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex rounded-lg border p-0.5">
          {METRICS.map((m) => (
            <button key={m.key} type="button" onClick={() => setMetric(m.key)}
              className={cn('rounded-md px-3 py-1 text-sm', metric === m.key ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground')}>{m.label}</button>
          ))}
        </div>
        <Select value={period} onValueChange={setPeriod}>
          <SelectTrigger size="sm" className="w-36" aria-label="Period"><SelectValue /></SelectTrigger>
          <SelectContent>{PERIODS.map((p) => <SelectItem key={p.key} value={p.key}>{p.label}</SelectItem>)}</SelectContent>
        </Select>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="relative gap-0 p-3 sm:p-4">
          <div ref={box} className="relative mx-auto aspect-[1555/2140] max-h-[640px] w-full max-w-[470px]">
            <svg viewBox={BD_VIEWBOX} className="h-full w-full" role="img" aria-label={`Map of Bangladesh coloured by ${metric}`}
              onMouseLeave={() => setHover(null)}>
              {BD_DISTRICTS.map((d) => {
                const v = value(byName.get(d.name), metric)
                const pct = v > 0 ? 22 + Math.round(78 * Math.sqrt(v / max)) : 0
                return (
                  <path key={d.name} d={d.path} tabIndex={0} aria-label={`${d.name}: ${show(v, metric)}`}
                    style={{ fill: v > 0 ? `color-mix(in oklab, #14b8a6 ${pct}%, var(--muted))` : 'var(--muted)' }}
                    className={cn('cursor-pointer stroke-background stroke-[2] transition-[fill,opacity] outline-none hover:opacity-80 focus-visible:opacity-80',
                      picked === d.name && 'stroke-foreground stroke-[5]')}
                    onMouseMove={(e) => {
                      const r = box.current?.getBoundingClientRect()
                      if (r) setHover({ name: d.name, x: e.clientX - r.left, y: e.clientY - r.top })
                    }}
                    onClick={() => setPicked(picked === d.name ? null : d.name)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setPicked(d.name) } }} />
                )
              })}
            </svg>
            {hover && (
              <div className="pointer-events-none absolute z-10 w-44 -translate-x-1/2 -translate-y-full rounded-lg border bg-popover px-3 py-2 text-xs shadow-md"
                style={{ left: hover.x, top: hover.y - 10 }}>
                <p className="font-medium">{hover.name}</p>
                {hov ? (
                  <p className="text-muted-foreground">{formatNumber(hov.customers)} customers · {formatNumber(hov.orders)} orders<br />{formatMoney(hov.revenue)} delivered{hov.success_rate !== null ? ` · ${hov.success_rate}% success` : ''}</p>
                ) : <p className="text-muted-foreground">No orders yet</p>}
              </div>
            )}
          </div>
          <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-muted-foreground">
            <span>Fewer</span>
            <span className="h-2 w-28 rounded-full" style={{ background: 'linear-gradient(to right, color-mix(in oklab, #14b8a6 18%, var(--muted)), #14b8a6)' }} />
            <span>More {METRICS.find((m) => m.key === metric)?.label.toLowerCase()}</span>
          </div>
        </Card>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <Tile label="Customers" value={formatNumber(t.customers)} />
            <Tile label="Total orders" value={formatNumber(t.orders)} />
            <Tile label="Unassigned customers" value={formatNumber(t.unassigned_customers)} tone={t.unassigned_customers ? 'warn' : undefined} />
            <Tile label="Delivered value" value={formatMoney(t.revenue)} />
          </div>
          {can('orders.update') && (
            <Button className="w-full" variant="outline" onClick={() => auto.mutate()} disabled={auto.isPending || !t.unassigned_customers}>
              {auto.isPending ? <Spinner /> : <Sparkles />} Auto-assign districts from address
            </Button>
          )}
          {sel && (
            <Card className="gap-1 p-3 text-sm">
              <div className="flex items-center justify-between"><p className="font-semibold">{sel.district}</p><button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => setPicked(null)}>Clear</button></div>
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                <dt className="text-muted-foreground">Customers</dt><dd className="text-right tabular-nums">{formatNumber(sel.customers)}</dd>
                <dt className="text-muted-foreground">Orders</dt><dd className="text-right tabular-nums">{formatNumber(sel.orders)}</dd>
                <dt className="text-muted-foreground">Delivered / returned</dt><dd className="text-right tabular-nums">{sel.delivered} / {sel.returned}</dd>
                <dt className="text-muted-foreground">Success rate</dt><dd className="text-right tabular-nums">{sel.success_rate === null ? '—' : `${sel.success_rate}%`}</dd>
                <dt className="text-muted-foreground">Delivered value</dt><dd className="text-right"><Money value={sel.revenue} /></dd>
                <dt className="text-muted-foreground">Order value</dt><dd className="text-right"><Money value={sel.order_value} /></dd>
              </dl>
            </Card>
          )}
          <Card className="gap-2 p-3">
            <p className="flex items-center gap-1.5 text-sm font-medium"><MapPinned className="size-4" /> Top districts by {METRICS.find((m) => m.key === metric)?.label.toLowerCase()}</p>
            {top.length === 0 ? <p className="text-xs text-muted-foreground">No orders in this period.</p> : (
              <ul className="space-y-1.5">
                {top.map((d) => (
                  <li key={d.district}>
                    <button type="button" onClick={() => setPicked(d.district)} className="w-full text-left">
                      <div className="flex justify-between text-xs"><span className="font-medium">{d.district}</span><span className="tabular-nums text-muted-foreground">{show(value(d, metric), metric)}</span></div>
                      <div className="mt-0.5 h-1.5 rounded-full bg-muted"><div className="h-full rounded-full bg-teal-500" style={{ width: `${(100 * value(d, metric)) / max}%` }} /></div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>

      <UnassignedList canEdit={can('orders.update')} />
    </div>
  )
}

function Tile({ label, value: v, tone }: { label: string; value: string; tone?: 'warn' }) {
  return (
    <div className="rounded-xl border bg-card px-3 py-2.5">
      <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
      <p className={cn('text-lg font-semibold tabular-nums', tone === 'warn' && 'text-amber-600')}>{v}</p>
    </div>
  )
}

/** Customers whose district we could not read: pick it and save. */
function UnassignedList({ canEdit }: { canEdit: boolean }) {
  const list = useQuery({ queryKey: ['customers', 'needing-district'], queryFn: () => customersNeedingDistrict(200) })
  return (
    <Card className="gap-0 p-0">
      <div className="border-b px-4 py-3">
        <p className="flex items-center gap-2 font-medium"><Users className="size-4" /> Manual district assignment {list.data && <span className="text-sm font-normal text-muted-foreground">· {list.data.length} customers</span>}</p>
        <p className="text-xs text-muted-foreground">Their order has a district that is not one of the 64. Pick the right one so the map, delivery charges and courier booking use it.</p>
      </div>
      {list.isLoading ? <LoadingState /> : list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} />
        : !list.data?.length ? <EmptyState title="All customers have a district" description="Nothing to fix." className="py-8" />
          : <ul className="divide-y">{list.data.map((c) => <UnassignedRow key={c.phone} c={c} canEdit={canEdit} />)}</ul>}
    </Card>
  )
}

function UnassignedRow({ c, canEdit }: { c: UnassignedCustomer; canEdit: boolean }) {
  const queryClient = useQueryClient()
  const [district, setDistrict] = useState(c.suggestion ?? '')
  const save = useMutation({
    mutationFn: () => assignCustomerDistrict(c.phone, district),
    onSuccess: (r) => { toast.success(`${c.name ?? c.phone}: ${r.district} (${r.orders} order${r.orders === 1 ? '' : 's'})`); void queryClient.invalidateQueries({ queryKey: ['customers'] }) },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5 sm:flex-nowrap">
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-sm font-medium">{c.name ?? 'Customer'} <span className="font-normal text-muted-foreground tabular-nums">{c.phone}</span></p>
        <p className="truncate text-xs text-muted-foreground" title={c.address ?? ''}>{c.address || 'No address'} · given as “{c.district_text}”</p>
        <p className="text-[11px] text-muted-foreground">{c.orders} order{c.orders === 1 ? '' : 's'} · last {timeAgo(c.last_order_at)}{c.suggestion ? ` · suggested ${c.suggestion}` : ''}</p>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1.5">
          <Select value={district} onValueChange={setDistrict}>
            <SelectTrigger size="sm" className="w-44" aria-label={`District for ${c.phone}`}><SelectValue placeholder="Select district…" /></SelectTrigger>
            <SelectContent>{DISTRICT_NAMES.map((d) => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
          </Select>
          <Button size="icon" className="size-8" disabled={!district || save.isPending} onClick={() => save.mutate()} aria-label="Save district">
            {save.isPending ? <Spinner /> : <Check />}
          </Button>
        </div>
      )}
    </li>
  )
}
