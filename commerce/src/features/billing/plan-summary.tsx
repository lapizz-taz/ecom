import { useQuery } from '@tanstack/react-query'
import { ErrorState, LoadingState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDate, formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ACCESS_MODE, ENTITLEMENT, LIMIT_KEYS, LIMIT_LABEL, myPlan, type MyPlan, SUBSCRIPTION_STATUS } from '@/services/billing'

/** Why the account is limited, in the merchant's words. */
export function accessExplanation(p: MyPlan): string | null {
  if (p.access_mode === 'FULL') return null
  if (p.merchant.status === 'SUSPENDED') return `Your account is suspended by the platform${p.merchant.status_reason ? `: ${p.merchant.status_reason}` : ''}.`
  if (p.merchant.status === 'CLOSED') return 'Your account is closed.'
  const s = p.subscription
  if (!s) return 'Your subscription has ended.'
  if (s.status === 'PAST_DUE') return `An invoice is unpaid${s.grace_until ? ` since before ${formatDate(s.grace_until)}` : ''}. Pay it to restore full access.`
  if (s.status === 'PAUSED') return 'Your subscription is paused.'
  if (s.status === 'CANCELLED') return 'Your subscription is cancelled.'
  if (s.status === 'EXPIRED') return 'Your subscription expired unpaid.'
  return null
}

export function usePlan() {
  return useQuery({ queryKey: ['my-plan'], queryFn: myPlan, staleTime: 60_000 })
}

/** Plan, usage, features and invoices — what the merchant's owner sees (and pays from). */
export function PlanSummary({ compact }: { compact?: boolean }) {
  const plan = usePlan()
  if (plan.error) return <ErrorState error={plan.error} onRetry={() => plan.refetch()} />
  if (!plan.data) return <LoadingState />
  const p = plan.data
  const s = p.subscription
  const reason = accessExplanation(p)
  const open = p.invoices.filter((i) => i.status === 'OPEN')
  return (
    <div className="space-y-4">
      {reason && (
        <Card className={cn('px-4 py-3 text-sm', p.access_mode === 'BLOCKED' ? 'border-red-500/50' : 'border-amber-500/50')}>
          <p className="font-medium"><Badge variant={ACCESS_MODE[p.access_mode].variant}>{ACCESS_MODE[p.access_mode].label}</Badge> {reason}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {p.access_mode === 'READ_ONLY' ? 'You can view and export everything, but not change it. Your store keeps taking orders.' : 'The admin and new orders are paused until this is resolved.'}
            {open.length > 0 ? ' To pay, contact the platform team (bank or bKash); the payment is applied once it is confirmed.' : ' Contact the platform team to change this.'}
          </p>
        </Card>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="text-sm">Plan</CardTitle></CardHeader>
          <CardContent className="space-y-1 text-sm">
            {!s ? <p className="text-muted-foreground">No active plan.</p> : <>
              <p className="flex items-center gap-2 text-lg font-semibold">{s.plan.name} <StatusBadge value={s.status} map={SUBSCRIPTION_STATUS} /></p>
              {s.plan.description && <p className="text-muted-foreground">{s.plan.description}</p>}
              <p>{formatMoney(s.price)} / {s.billing_interval === 'YEAR' ? 'year' : 'month'}</p>
              {s.status === 'TRIALING' && <p className="text-muted-foreground">Free trial until {formatDateTime(s.trial_ends_at)}</p>}
              {s.status === 'ACTIVE' && s.current_period_end && <p className="text-muted-foreground">Renews {formatDate(s.current_period_end)}{s.cancel_at_period_end && ' — set to end then'}</p>}
            </>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Usage</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {LIMIT_KEYS.map((k) => {
              const limit = p.limits[k]
              const used = Number(p.usage[k] ?? 0)
              const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
              return (
                <div key={k} className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-muted-foreground">{LIMIT_LABEL[k]}</span><span className="tabular-nums">{formatNumber(used)} / {limit != null ? formatNumber(limit) : 'no limit'}</span></div>
                  {limit != null && <div className="h-1.5 rounded-full bg-muted"><div className={cn('h-full rounded-full', pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} /></div>}
                </div>
              )
            })}
          </CardContent>
        </Card>
      </div>
      {!compact && (
        <Card>
          <CardHeader><CardTitle className="text-sm">Features</CardTitle></CardHeader>
          <CardContent className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2">
            {Object.entries(p.features).map(([code, f]) => (
              <div key={code} className="flex items-center justify-between gap-2 text-sm">
                <span>{f.name}</span>
                <Badge variant={ENTITLEMENT[f.state].variant}>{f.state === 'CORE' ? 'Included' : ENTITLEMENT[f.state].label}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      <Card>
        <CardHeader><CardTitle className="text-sm">Invoices{open.length > 0 && <span className="ml-2 font-normal text-amber-600">{open.length} unpaid</span>}</CardTitle></CardHeader>
        <CardContent className="space-y-1.5">
          {p.invoices.length === 0 && <p className="text-sm text-muted-foreground">No invoices yet.</p>}
          {p.invoices.map((i) => (
            <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
              <span><span className="font-mono text-xs">{i.number}</span> <span className="text-muted-foreground">· {i.period_start ? `${formatDate(i.period_start)} – ${formatDate(i.period_end)}` : ''}</span></span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{formatMoney(i.total)}</span>
                <Badge variant={i.status === 'PAID' ? 'success' : i.status === 'OPEN' ? (new Date(i.due_at) < new Date() ? 'danger' : 'warning') : 'neutral'}>
                  {i.status === 'OPEN' ? `due ${formatDate(i.due_at)}` : i.status.toLowerCase()}
                </Badge>
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
