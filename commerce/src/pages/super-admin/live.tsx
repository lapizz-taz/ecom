import { useQuery } from '@tanstack/react-query'
import { Activity, Gauge, Globe, Radio, ShieldCheck, Store, Users } from 'lucide-react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { CAPACITY_BENCHMARK } from '@/features/platform/capacity-benchmark'
import { formatNumber, timeAgo } from '@/lib/format'
import { ORDER_STATUS } from '@/lib/status'
import { cn } from '@/lib/utils'
import { capacity, type LivePerson, liveUsers } from '@/services/platform-live'
import type { OrderStatus } from '@/types/domain'

const bytes = (n: number | null) => (!n ? 'not reported' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`)

/** Super Admin: who is using Fullfilio right now, and how much order traffic it carries and can carry. */
export default function LivePage() {
  const live = useQuery({ queryKey: ['platform-live'], queryFn: liveUsers, refetchInterval: 15_000 })
  const cap = useQuery({ queryKey: ['platform-capacity'], queryFn: capacity, refetchInterval: 30_000, retry: false })
  const l = live.data
  const c = cap.data
  const visitors = l?.visitors.reduce((s, v) => s + v.visitors, 0) ?? 0

  return (
    <div className="space-y-5">
      <PageHeader title="Live & Capacity" description="People using Fullfilio right now (a heartbeat every minute while a tab is open), store visitors, today's order traffic, and what the system sustained under load." />

      {live.error ? <ErrorState error={live.error} onRetry={() => live.refetch()} /> : !l ? <CardsSkeleton count={4} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard label="Online now" value={formatNumber(l.online_now)} hint="active in the last 2 minutes" icon={<Radio />} tone={l.online_now ? 'positive' : 'default'} />
            <StatCard label="Stores working now" value={formatNumber(l.stores_online)} hint="with someone in the admin" icon={<Store />} />
            <StatCard label="Last 15 minutes" value={formatNumber(l.last_15_min)} hint="people" icon={<Users />} />
            <StatCard label="Today" value={formatNumber(l.last_24h)} hint="people in 24 hours" icon={<Activity />} />
            <StatCard label="Store visitors now" value={formatNumber(visitors)} hint="last 5 minutes, all stores" icon={<Globe />} className="col-span-2 lg:col-span-1" />
          </div>

          <section className="overflow-hidden rounded-2xl border bg-card">
            <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <h2 className="text-sm font-semibold">People</h2>
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground"><span className="size-2 animate-pulse rounded-full bg-emerald-500" /> updates every 15 s</span>
            </header>
            {l.people.length === 0 ? <EmptyState icon={<Users />} title="Nobody in the last 24 hours" description="People appear here as soon as they open the admin or Super Admin." /> : (
              <ul className="divide-y">{l.people.map((p) => <PersonRow key={`${p.user_id}-${p.area}`} p={p} />)}</ul>
            )}
          </section>

          {l.visitors.length > 0 && (
            <section className="rounded-2xl border bg-card p-4">
              <h2 className="mb-3 text-sm font-semibold">Store visitors right now</h2>
              <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {l.visitors.map((v) => (
                  <li key={v.merchant.id} className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 px-3 py-2 text-sm">
                    <Link className="min-w-0 truncate hover:underline" to={`/super-admin/merchants/${v.merchant.id}`}>#{v.merchant.number} {v.merchant.name}</Link>
                    <span className="shrink-0 font-semibold tabular-nums">{formatNumber(v.visitors)}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      <section className="space-y-3">
        <h2 className="flex items-center gap-2 text-base font-semibold"><Gauge className="size-4" /> Order traffic and capacity</h2>
        {cap.error ? <ErrorState error={cap.error} onRetry={() => cap.refetch()} /> : !c ? <CardsSkeleton count={4} /> : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <StatCard label="Orders, last hour" value={formatNumber(c.orders.last_hour)} />
              <StatCard label="Orders, last 24 h" value={formatNumber(c.orders.last_24h)} hint={`${formatNumber(c.stores_with_orders_24h)} ${c.stores_with_orders_24h === 1 ? 'store' : 'stores'}`} />
              <StatCard label="Busiest minute (24 h)" value={formatNumber(c.orders.peak_minute_24h)} hint="orders in one minute" />
              <StatCard label="Busiest hour (7 days)" value={formatNumber(c.orders.peak_hour_7d)} hint="orders in one hour" />
              <StatCard label="Status changes, last hour" value={formatNumber(c.status_changes.last_hour)} hint={`${formatNumber(c.status_changes.last_24h)} in 24 h`} className="col-span-2 lg:col-span-1" />
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-2xl border bg-card p-4">
                <h3 className="mb-3 text-sm font-semibold">Orders in each status</h3>
                {Object.keys(c.by_status).length === 0 ? <p className="text-sm text-muted-foreground">No orders yet.</p> : (
                  <ul className="flex flex-wrap gap-2">
                    {Object.entries(c.by_status).sort((a, b) => b[1] - a[1]).map(([s, n]) => (
                      <li key={s} className="flex items-center gap-1.5 rounded-full border px-2 py-1 text-xs">
                        <StatusBadge value={s as OrderStatus} map={ORDER_STATUS} /> <span className="font-semibold tabular-nums">{formatNumber(n)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="rounded-2xl border bg-card p-4">
                <h3 className="mb-3 text-sm font-semibold">Database</h3>
                {c.database.max_connections ? (
                  <>
                    <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                      <span>Connections in use</span><span className="tabular-nums">{c.database.connections} of {c.database.max_connections}</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-muted">
                      <div className={cn('h-full rounded-full', (c.database.connections ?? 0) / c.database.max_connections > 0.8 ? 'bg-red-500' : 'bg-emerald-500')}
                        style={{ width: `${Math.min(100, ((c.database.connections ?? 0) / c.database.max_connections) * 100)}%` }} />
                    </div>
                    <p className="mt-3 text-xs text-muted-foreground">Size {bytes(c.database.size_bytes)}. Requests go through a connection pool, so these numbers stay low even under heavy traffic.</p>
                  </>
                ) : <p className="text-sm text-muted-foreground">Not measurable on this database.</p>}
              </div>
            </div>

            <div className="rounded-2xl border bg-card p-4">
              <h3 className="mb-1 flex items-center gap-2 text-sm font-semibold"><ShieldCheck className="size-4" /> What it sustained under load</h3>
              {CAPACITY_BENCHMARK ? (
                <>
                  <p className="mb-3 text-xs text-muted-foreground">Load test on {CAPACITY_BENCHMARK.measuredAt}: {CAPACITY_BENCHMARK.environment}, {CAPACITY_BENCHMARK.concurrency} clients at once, {formatNumber(CAPACITY_BENCHMARK.ordersInDatabase)} orders in the database, {CAPACITY_BENCHMARK.errors} errors.</p>
                  <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                    <Bench label="Orders per second" value={formatNumber(CAPACITY_BENCHMARK.ordersPerSecond)} hint={`≈ ${formatNumber(CAPACITY_BENCHMARK.ordersPerSecond * 3600)} an hour`} />
                    <Bench label="Status changes per second" value={formatNumber(CAPACITY_BENCHMARK.statusChangesPerSecond)} hint="with stock and money" />
                    <Bench label="Search at that load" value={`${formatNumber(CAPACITY_BENCHMARK.searchP95Ms)} ms`} hint="95% of searches faster" />
                    <Bench label="Today's busiest minute" value={formatNumber(c.orders.peak_minute_24h)}
                      hint={`${Math.max(0, Math.round(100 - (c.orders.peak_minute_24h / 60 / CAPACITY_BENCHMARK.ordersPerSecond) * 100))}% headroom`} />
                  </dl>
                </>
              ) : <p className="text-sm text-muted-foreground">No load test recorded yet.</p>}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

function Bench({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="rounded-xl bg-muted/50 px-3 py-2">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
      <dd className="text-[11px] text-muted-foreground">{hint}</dd>
    </div>
  )
}

function PersonRow({ p }: { p: LivePerson }) {
  const initials = (p.name || p.email || '?').trim().split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase()
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <span className="relative grid size-9 shrink-0 place-items-center rounded-full bg-muted text-xs font-semibold">
        {initials}
        <span className={cn('absolute -right-0.5 -bottom-0.5 size-3 rounded-full border-2 border-card', p.online ? 'bg-emerald-500' : 'bg-zinc-300 dark:bg-zinc-600')} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="truncate font-medium">{p.name ?? p.email ?? 'Someone'}</span>
          <Badge variant={p.area === 'super-admin' ? 'info' : 'neutral'}>{p.area === 'super-admin' ? 'Super Admin' : p.role ?? 'Staff'}</Badge>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          {p.merchant ? <Link className="hover:underline" to={`/super-admin/merchants/${p.merchant.id}`}>#{p.merchant.number} {p.merchant.name}</Link> : 'Platform team'}
          {p.path && <> · {p.path}</>}{p.device && <> · {p.device}</>}
        </p>
      </div>
      <span className={cn('shrink-0 text-xs', p.online ? 'font-medium text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground')}>{p.online ? 'online' : timeAgo(p.last_seen_at)}</span>
    </li>
  )
}
