import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, PhoneOff, PhoneOutgoing, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { PageHeader } from '@/components/common/page-header'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type DateRange, rangeFor } from '@/lib/dates'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { callsReport } from '@/services/calls'

/** The range as times: from the first day's start to the end of the last day, on this device's clock. */
function bounds(r: DateRange) {
  const to = new Date(`${r.to}T00:00:00`)
  to.setDate(to.getDate() + 1)
  return { from: new Date(`${r.from}T00:00:00`).toISOString(), to: to.toISOString() }
}

function Stat({ label, value, hint, warn = false }: { label: string; value: number; hint: string; warn?: boolean }) {
  return (
    <Card className={cn(warn && value > 0 && 'border-amber-400/60')}>
      <CardContent className="space-y-1 p-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className={cn('text-2xl font-semibold tabular-nums', warn && value > 0 && 'text-amber-600 dark:text-amber-400')}>{formatNumber(value)}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  )
}

const num = (v: number) => <span className="tabular-nums">{formatNumber(v)}</span>

/**
 * Call tracking for the Owner and Admins (calls.view): per staff member, how often Call was tapped,
 * call statuses set and orders approved or closed, and which orders were closed without a tap.
 */
export default function CallTrackingPage() {
  const [range, setRange] = useState<DateRange>(() => rangeFor('today'))
  const q = useQuery({ queryKey: ['calls-report', range], queryFn: () => callsReport(bounds(range)), refetchInterval: 60_000 })
  const r = q.data
  const totals = (r?.staff ?? []).reduce((t, s) => ({ taps: t.taps + s.taps, statuses: t.statuses + s.statuses, without: t.without + s.without_call }),
    { taps: 0, statuses: 0, without: 0 })

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<ShieldCheck />}
        title="Call Tracking"
        description="Who called which customer, how often, and which orders were closed without a call. Only the Owner and Admins see this page."
        actions={<DateRangeFilter value={range} onChange={setRange} align="end" />}
      />

      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : r && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Taps on Call" value={totals.taps} hint="Call buttons tapped on orders" />
            <Stat label="Call statuses set" value={totals.statuses} hint="No response, Follow-up, Cancelled…" />
            <Stat label="Closed without a call" value={totals.without} hint="Approved or cancelled, Call never tapped" warn />
            <Stat label="Waiting, never called" value={Number(r.never_called.count)} hint="Web orders over 1 hour old, now" warn />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">By staff member</CardTitle>
              <CardDescription>“Closed without a call” counts orders this person approved or cancelled when nobody had tapped Call on them.</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {r.staff.length === 0 ? <EmptyState icon={<PhoneOutgoing />} title="No calls in this period" description="Taps on Call and call statuses show here as staff work." /> : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
                      <tr>
                        <th className="px-4 py-2 font-medium">Staff member</th>
                        <th className="px-3 py-2 text-right font-medium">Taps on Call</th>
                        <th className="px-3 py-2 text-right font-medium">Orders called</th>
                        <th className="px-3 py-2 text-right font-medium">Call statuses</th>
                        <th className="px-3 py-2 text-right font-medium">Not reached</th>
                        <th className="px-3 py-2 text-right font-medium">Approved</th>
                        <th className="px-3 py-2 text-right font-medium">Cancelled / closed</th>
                        <th className="px-4 py-2 text-right font-medium">Closed without a call</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y">
                      {r.staff.map((s) => (
                        <tr key={s.user_id}>
                          <td className="px-4 py-2.5"><p className="font-medium">{s.name ?? 'Staff'}</p>{s.role && <p className="text-xs text-muted-foreground">{s.role}</p>}</td>
                          <td className="px-3 py-2.5 text-right">{num(s.taps)}</td>
                          <td className="px-3 py-2.5 text-right">{num(s.orders_called)}</td>
                          <td className="px-3 py-2.5 text-right">{num(s.statuses)}</td>
                          <td className="px-3 py-2.5 text-right">{num(s.not_reached)}</td>
                          <td className="px-3 py-2.5 text-right">{num(s.approved)}</td>
                          <td className="px-3 py-2.5 text-right">{num(s.closed)}</td>
                          <td className="px-4 py-2.5 text-right">
                            {s.without_call > 0 ? <Badge variant="warning" className="tabular-nums">{formatNumber(s.without_call)}</Badge> : num(0)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {r.automatic_approvals > 0 && <p className="border-t px-4 py-2 text-xs text-muted-foreground">{formatNumber(r.automatic_approvals)} order{r.automatic_approvals === 1 ? '' : 's'} approved automatically (no staff member).</p>}
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><AlertTriangle className="size-4 text-amber-500" /> Approved or cancelled without a call</CardTitle>
                <CardDescription>Nobody tapped Call on these before. The staff member may have called from another phone.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {r.without_call.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">None in this period.</p> : (
                  <ul className="divide-y">
                    {r.without_call.map((o) => (
                      <li key={`${o.order_id}-${o.at}`} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                        <div className="min-w-0">
                          <Link to={`/admin/orders/${o.order_id}`} className="font-medium hover:underline">{o.order_number}</Link>
                          <span className="text-muted-foreground"> · {o.customer_name}</span>
                          <p className="text-xs text-muted-foreground">{o.outcome} by {o.actor_name ?? 'staff'}</p>
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatDateTime(o.at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-sm"><PhoneOff className="size-4 text-muted-foreground" /> Waiting, never called</CardTitle>
                <CardDescription>Web orders over 1 hour old that nobody has tapped Call on yet, right now. Oldest first.</CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                {r.never_called.items.length === 0 ? <p className="px-4 pb-4 text-sm text-muted-foreground">Every waiting order has been called.</p> : (
                  <ul className="divide-y">
                    {r.never_called.items.map((o) => (
                      <li key={o.order_id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm">
                        <div className="min-w-0">
                          <Link to={`/admin/orders/${o.order_id}`} className="font-medium hover:underline">{o.order_number}</Link>
                          <span className="text-muted-foreground"> · {o.customer_name}</span>
                        </div>
                        <span className="shrink-0 text-xs text-muted-foreground">ordered {timeAgo(o.created_at)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          </div>

          <p className="text-xs text-muted-foreground">
            A tap shows the Call button was used in Fullfilio, not that the customer answered. Calls made through Cloud Calling are recorded by the phone system itself, with the answer and how long it lasted.
          </p>
        </>
      )}
    </div>
  )
}
