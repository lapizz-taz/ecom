import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CreditCard, LifeBuoy, MessageSquare, PhoneCall, ShoppingBag, Store, Truck, UserPlus, Wallet } from 'lucide-react'
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, ErrorState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Kind } from '@/features/platform/kind-badge'
import { usePlatform } from '@/features/platform/platform-context'
import { useUrlState } from '@/hooks/use-url-state'
import { rangeFor } from '@/lib/dates'
import { formatMoney, formatNumber, formatShortDate, timeAgo } from '@/lib/format'
import { overviewBusiness } from '@/services/analytics'
import { platformOverview } from '@/services/platform'


export default function PlatformOverviewPage() {
  const initial = rangeFor('30d')
  const [range, setRange] = useUrlState({ from: initial.from, to: initial.to })
  const { can } = usePlatform()
  const overview = useQuery({ queryKey: ['platform-overview', range.from, range.to], queryFn: () => platformOverview(range.from, range.to) })
  const business = useQuery({ queryKey: ['platform-overview-business', range.from, range.to], queryFn: () => overviewBusiness(range.from, range.to) })
  const o = overview.data
  const b = business.data
  const status = o?.merchants.by_status ?? {}
  const gatewaySeen = o?.pbx.gateway_seen_at ? Date.now() - new Date(o.pbx.gateway_seen_at).getTime() < 5 * 60_000 : false

  return (
    <div className="space-y-5">
      <PageHeader title="Overview" description="The whole platform at a glance. Figures come from the database; estimates are labelled."
        actions={<DateRangeFilter value={range} onChange={(r) => setRange({ from: r.from, to: r.to })} />} />
      {overview.error ? <ErrorState error={overview.error} onRetry={() => overview.refetch()} /> : !o ? <CardsSkeleton count={8} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Merchants" value={formatNumber(o.merchants.total)} icon={<Store />} to={can('merchants') ? '/super-admin/merchants' : undefined}
              hint={`${formatNumber(status.ACTIVE ?? 0)} active · ${formatNumber(status.ONBOARDING ?? 0)} onboarding${o.merchants.demo ? ` · ${o.merchants.demo} demo` : ''}`} />
            <StatCard label="New in range" value={formatNumber(o.merchants.new)} icon={<UserPlus />} hint={`${formatNumber(o.merchants.onboarded)} finished onboarding`} />
            <StatCard label="Suspended" value={formatNumber(status.SUSPENDED ?? 0)} tone={status.SUSPENDED ? 'warning' : 'default'}
              hint={`${formatNumber(status.CLOSED ?? 0)} closed`} to={can('merchants') ? '/super-admin/merchants?status=SUSPENDED' : undefined} />
            <StatCard label="Quiet for 30 days" value={formatNumber(o.merchants.quiet_30d)} tone={o.merchants.quiet_30d ? 'warning' : 'default'}
              hint="Active, ordered before, no order since — a signal, not a churn decision" />
            <StatCard label="Orders processed" value={formatNumber(o.orders.count)} icon={<ShoppingBag />} hint={`${formatMoney(o.orders.value)} order value (merchants' sales)`} />
            <StatCard label="SMS sent" value={formatNumber(o.sms.sent)} icon={<MessageSquare />}
              hint={`${formatNumber(o.sms.segments)} parts · ${formatNumber(o.sms.failed)} failed · ${formatNumber(o.sms.queued)} waiting`} tone={o.sms.failed ? 'warning' : 'default'} />
            <StatCard label="Courier history checks" value={formatNumber(o.courier.history_checks)} icon={<Truck />}
              hint={`${formatNumber(o.courier.bookings)} parcels booked by API · ${formatNumber(o.courier.accounts_connected)} courier accounts`} />
            <StatCard label="Integration errors" value={formatNumber(o.integrations.errors)} icon={<AlertTriangle />}
              tone={o.integrations.errors ? 'negative' : 'positive'} to={can('health') ? '/super-admin/health' : undefined}
              hint={`${formatNumber(o.integrations.webhook_errors)} webhook · ${formatNumber(o.integrations.failed_jobs)} failed store jobs · ${formatNumber(o.courier.webhook_failures)} courier webhooks`} />
          </div>

          {b && (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              {b.billing && <>
                <StatCard label="MRR" value={formatMoney(b.billing.mrr)} icon={<CreditCard />} to={can('subscriptions') ? '/super-admin/usage?tab=revenue' : undefined}
                  hint={<span className="flex items-center gap-1"><Kind kind="calculated" /> {formatNumber(b.billing.active)} active · {formatNumber(b.billing.trialing)} on trial</span>} />
                <StatCard label="Money received" value={formatMoney(b.billing.revenue_in_range)}
                  hint={<span className="flex items-center gap-1"><Kind kind="actual" /> {formatMoney(b.billing.subscription_revenue_in_range)} from plans</span>} />
                <StatCard label="Needs billing attention" value={formatNumber(b.billing.past_due + b.billing.overdue_invoices)} tone={b.billing.past_due + b.billing.overdue_invoices ? 'warning' : 'default'}
                  to={can('subscriptions') ? '/super-admin/subscriptions' : undefined}
                  hint={`${b.billing.past_due} past due · ${b.billing.overdue_invoices} overdue invoices · ${b.billing.failed_payments} failed payments`} />
                <StatCard label="Trials ending in 7 days" value={formatNumber(b.billing.trials_ending_7d)}
                  hint={`${b.billing.cancelling} cancelling · ${b.billing.cancelled_in_range} ended in range`} />
              </>}
              <StatCard label="Credits left (merchants)" value={formatNumber(b.credits.sms_outstanding)} icon={<Wallet />} to={can('credits') ? '/super-admin/credits' : undefined}
                hint={`SMS credits · ${formatNumber(b.credits.courier_outstanding)} courier credits`} />
              <StatCard label="Metered BD Courier lookups" value={formatNumber(b.metered.bd_lookups)} icon={<Truck />} to={can('bd_courier') ? '/super-admin/bd-courier?tab=usage' : undefined}
                tone={b.services.bd_courier_connected ? 'default' : 'negative'}
                hint={b.services.bd_courier_connected ? `${b.metered.bd_failed} failed · ${b.metered.bd_refused} refused by policy` : 'Company account not connected'} />
              <StatCard label="Provider costs" value={formatMoney(b.metered.provider_cost_reported)}
                hint={<span className="flex items-center gap-1"><Kind kind="actual" /> + {b.metered.provider_cost_estimated == null ? 'unknown' : formatMoney(b.metered.provider_cost_estimated)} <Kind kind="estimate" /></span>} />
              <StatCard label="Support tickets" value={formatNumber(b.support.open)} icon={<LifeBuoy />} to={can('support') ? '/super-admin/support' : undefined}
                tone={b.support.overdue ? 'negative' : 'default'} hint={`${b.support.overdue} overdue · ${b.support.urgent} urgent`} />
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-3">
            <Card className="lg:col-span-2">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">Orders and sign-ups per day <Kind kind="actual" /></CardTitle>
                <CardDescription>Across every merchant you can see.</CardDescription>
              </CardHeader>
              <CardContent className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={o.series} margin={{ left: -20, right: 4 }}>
                    <CartesianGrid vertical={false} strokeOpacity={0.1} />
                    <XAxis dataKey="day" tickFormatter={(d) => formatShortDate(d)} fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
                    <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(d) => formatShortDate(String(d))} />
                    <Bar dataKey="orders" name="Orders" fill="var(--chart-1, #a1a1aa)" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="merchants" name="New merchants" fill="var(--chart-2, #52525b)" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Connected stores <Kind kind="actual" /></CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                {Object.keys(o.stores).length === 0 && <p className="text-muted-foreground">No store connected yet.</p>}
                {Object.entries(o.stores).map(([platform, s]) => (
                  <div key={platform} className="flex items-center justify-between">
                    <span className="capitalize">{platform.toLowerCase()}</span>
                    <span className="tabular-nums">{formatNumber(s.connected)} connected{s.error > 0 && <span className="ml-2 text-red-500">{s.error} with errors</span>}</span>
                  </div>
                ))}
                <div className="border-t pt-3">
                  <div className="flex items-center justify-between"><span className="flex items-center gap-2"><PhoneCall className="size-4" /> PBX gateway</span>
                    <Badge variant={o.pbx.gateway_seen_at ? (gatewaySeen ? 'success' : 'danger') : 'neutral'}>
                      {o.pbx.gateway_seen_at ? (gatewaySeen ? 'Reporting' : `Last seen ${timeAgo(o.pbx.gateway_seen_at)}`) : 'Never reported'}
                    </Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{formatNumber(o.pbx.businesses)} merchants with PBX switched on. Status is the gateway's own heartbeat.</p>
                </div>
                <div className="flex items-center justify-between border-t pt-3">
                  <span className="flex items-center gap-2"><LifeBuoy className="size-4" /> Open support tickets</span>
                  <span className="tabular-nums">{formatNumber(o.support.open)}</span>
                </div>
                {o.approvals_pending > 0 && (
                  <p className="rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800">{o.approvals_pending} change(s) waiting for a second person's approval.</p>
                )}
              </CardContent>
            </Card>
          </div>
          {b && b.growth.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm">Growth and retention, last 6 months <Kind kind="actual" /></CardTitle>
                <CardDescription>New merchants, merchants who took orders, and paid subscriptions that ended (demo merchants left out).</CardDescription>
              </CardHeader>
              <CardContent className="h-52">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={b.growth} margin={{ left: -20, right: 4 }}>
                    <CartesianGrid vertical={false} strokeOpacity={0.1} />
                    <XAxis dataKey="month" tickFormatter={(d) => String(d).slice(0, 7)} fontSize={11} tickLine={false} axisLine={false} />
                    <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                    <Tooltip contentStyle={{ background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} cursor={{ fill: 'var(--muted)', opacity: 0.4 }} />
                    <Bar dataKey="active" name="Took orders" fill="#a1a1aa" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="new" name="New" fill="#52525b" radius={[3, 3, 0, 0]} />
                    <Bar dataKey="churned" name="Churned" fill="#ef4444" radius={[3, 3, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </CardContent>
            </Card>
          )}
          <p className="text-xs text-muted-foreground">
            Range {o.range.from} – {o.range.to}. Recorded figures come straight from the records; calculated ones are arithmetic on them; estimates use the cost assumptions in Usage &amp; Analytics.
          </p>
        </>
      )}
    </div>
  )
}
