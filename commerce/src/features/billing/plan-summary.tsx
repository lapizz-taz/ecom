import { useMutation, useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { ErrorState, LoadingState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDate, formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { cn } from '@/lib/utils'
import { ACCESS_MODE, ENTITLEMENT, LIMIT_KEYS, LIMIT_LABEL, myPlan, type MyPlan, renewNow, SUBSCRIPTION_STATUS } from '@/services/billing'
import { toast } from '@/lib/toast'
import { payInvoice } from '@/services/credits'
import { PayDialog, useMyCredits } from './credits-section'

/** Why the account is limited, in the merchant's words. */
function accessExplanation(p: MyPlan): string | null {
  if (p.access_mode === 'FULL') return null
  if (p.merchant.status === 'SUSPENDED') return `Your account is suspended by the platform${p.merchant.status_reason ? `: ${p.merchant.status_reason}` : ''}.`
  if (p.merchant.status === 'CLOSED') return 'Your account is closed.'
  const s = p.subscription
  if (!s) return 'Your subscription has ended.'
  if (trialEnded(s)) {
    if (s.current_period_end) return `Your ${s.intro_trial ? `${formatMoney(s.intro_price!)} offer` : 'introductory price'} has ended. Pay your invoice to continue.`
    return `Your free trial has ended. Pay ${formatMoney(s.intro_price!)} for your first ${s.billing_interval === 'YEAR' ? 'year' : 'month'} to continue (${afterIntro(s)}).`
  }
  if (s.status === 'PAST_DUE') return `An invoice is unpaid${s.grace_until ? ` since before ${formatDate(s.grace_until)}` : ''}. Pay it to restore full access.`
  if (s.status === 'PAUSED') return 'Your subscription is paused.'
  if (s.status === 'CANCELLED') return 'Your subscription is cancelled.'
  if (s.status === 'EXPIRED') return 'Your subscription expired unpaid.'
  return null
}

/** "then a one-time ৳1,000 fee + ৳990 a month": what follows the introductory price. */
export function afterIntro(s: NonNullable<MyPlan['subscription']>): string {
  return `then ${s.setup_fee_pending ? `a one-time ${formatMoney(s.setup_fee_pending)} fee + ` : ''}${formatMoney(s.price)} a ${s.billing_interval === 'YEAR' ? 'year' : 'month'}`
}

/**
 * The new-business offer is over and the payment to continue is not made: the first invoice
 * after a free trial, or the first at the plan's price after a paid trial or introductory price.
 */
export function trialEnded(s: NonNullable<MyPlan['subscription']>): boolean {
  if (s.status !== 'PAST_DUE' || s.intro_price == null) return false
  return !s.current_period_end || (!!s.intro_until && new Date(s.current_period_end) <= new Date(s.intro_until))
}

function usePlan() {
  return useQuery({ queryKey: ['my-plan'], queryFn: myPlan, staleTime: 60_000 })
}

/** Plan, usage, features and invoices — what the merchant's owner sees (and pays from). */
export function PlanSummary({ compact }: { compact?: boolean }) {
  const plan = usePlan()
  const credits = useMyCredits()
  const [paying, setPaying] = useState<Pick<MyPlan['invoices'][number], 'id' | 'number' | 'total' | 'amount_paid'> | null>(null)
  const renew = useMutation({ mutationFn: renewNow, onSuccess: (inv) => setPaying(inv), onError: (e) => toast.error(e) })
  const canPayOnline = !!credits.data?.can_pay && (credits.data?.gateways.length ?? 0) > 0
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
            {open.length > 0 ? (canPayOnline ? ' Pay the open invoice below to restore full access.' : ' To pay, e-mail help@fullfilio.com (bank or bKash); the payment is applied once it is confirmed.') : ' Contact the platform team to change this.'}
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
              {s.status === 'TRIALING' && (
                <p className="text-muted-foreground">
                  Free trial until {formatDateTime(s.trial_ends_at)}
                  {s.intro_price != null && ` — then ${formatMoney(s.intro_price)} for your first ${s.billing_interval === 'YEAR' ? 'year' : 'month'}`}
                </p>
              )}
              {s.status === 'ACTIVE' && s.intro_price != null && s.intro_until && s.current_period_end && new Date(s.current_period_end) <= new Date(s.intro_until) && (
                <p className="text-muted-foreground">
                  {s.intro_trial ? `${formatMoney(s.intro_price)} offer until ${formatDateTime(s.intro_until)}` : `Introductory price ${formatMoney(s.intro_price)} until ${formatDate(s.intro_until)}`}; {afterIntro(s)}
                </p>
              )}
              {s.status === 'ACTIVE' && s.current_period_end && <p className="text-muted-foreground">Renews {formatDate(s.current_period_end)}{s.cancel_at_period_end && ' — set to end then'}</p>}
              {canPayOnline && s.price > 0 && ['ACTIVE', 'TRIALING'].includes(s.status) && !s.cancel_at_period_end && open.length === 0 && (
                <Button size="sm" variant="outline" className="mt-2" disabled={renew.isPending} onClick={() => renew.mutate()}>
                  {s.status === 'TRIALING' ? `Pay ${formatMoney(s.intro_price ?? s.price)} now` : 'Renew now'}
                </Button>
              )}
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
                  {k === 'products' && limit != null && used >= limit && <p className="text-xs text-muted-foreground">{used > limit ? 'Over the limit: ' : 'At the limit: '}products from your Shopify or WooCommerce store keep syncing, but you can't add more by hand until you upgrade.</p>}
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
              <span><span className="font-mono text-xs">{i.number}</span> <span className="text-muted-foreground">· {i.period_start ? `${formatDate(i.period_start)} – ${formatDate(i.period_end)}` : i.lines.map((l) => l.label).join(', ')}</span></span>
              <span className="flex items-center gap-2">
                <span className="tabular-nums">{formatMoney(i.total)}</span>
                <Badge variant={i.status === 'PAID' ? 'success' : i.status === 'OPEN' ? (new Date(i.due_at) < new Date() ? 'danger' : 'warning') : 'neutral'}>
                  {i.status === 'OPEN' ? `due ${formatDate(i.due_at)}` : i.status.toLowerCase()}
                </Badge>
                {i.status === 'OPEN' && canPayOnline && <Button size="sm" onClick={() => setPaying(i)}>Pay</Button>}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
      {paying && credits.data && (
        <PayDialog title={`Pay ${paying.number}`} amount={paying.total - paying.amount_paid} gateways={credits.data.gateways}
          onClose={() => setPaying(null)} start={(gateway) => payInvoice(paying.id, gateway)} />
      )}
    </div>
  )
}
