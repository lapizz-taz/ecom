import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BadgeCheck, Check, Minus } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { formatDate, formatMoney, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { choosePlan, LIMIT_KEYS, LIMIT_LABEL, planOptions, type PlanOption } from '@/services/billing'
import { payInvoice } from '@/services/credits'
import { PayDialog, useMyCredits } from './credits-section'

/** One ring colour per plan, in order (like the reference: orange, teal, violet, blue). */
const RINGS = ['border-orange-500', 'border-teal-500', 'border-violet-500', 'border-blue-600', 'border-rose-500']

const per = (interval: string) => (interval === 'YEAR' ? 'year' : 'month')
function limitLine(p: PlanOption) {
  const parts = [
    p.limits.orders_per_month != null ? `${formatNumber(p.limits.orders_per_month)} orders a month` : 'Unlimited orders',
    p.limits.stores != null ? `${formatNumber(p.limits.stores)} store${p.limits.stores === 1 ? '' : 's'}` : null,
    p.limits.staff != null ? `${formatNumber(p.limits.staff)} staff` : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

/**
 * The plans a business can pick, as cards with the price, and a feature table under them.
 * Choosing a paid plan raises its invoice; the plan changes only once the payment is
 * confirmed by bKash or PayStation (checked on the server, never by this page).
 */
export function PlanPicker() {
  const qc = useQueryClient()
  const options = useQuery({ queryKey: ['plan-options'], queryFn: planOptions, staleTime: 60_000 })
  const credits = useMyCredits()
  const [paying, setPaying] = useState<{ id: string; number: string; total: number; amount_paid: number; plan: string } | null>(null)
  const choose = useMutation({
    mutationFn: (p: PlanOption) => choosePlan(p.code).then((r) => ({ r, p })),
    onSuccess: ({ r, p }) => {
      qc.invalidateQueries({ queryKey: ['plan-options'] })
      qc.invalidateQueries({ queryKey: ['my-plan'] })
      if (r.applied) toast.success(`You are on the ${p.name} plan now`)
      else setPaying({ id: r.id, number: r.number, total: r.total, amount_paid: r.amount_paid, plan: p.name })
    },
    onError: (e) => toast.error((e as Error).message.replace(/^[A-Z_]+: /, '')),
  })
  const o = options.data
  if (!o || o.plans.length === 0) return null
  const gateways = credits.data?.gateways ?? []
  const canPayOnline = o.can_pay && gateways.length > 0
  const current = o.current?.code
  const recommended = o.plans.length > 1 ? o.plans[Math.min(1, o.plans.length - 1)].code : null

  return (
    <section className="space-y-4" aria-labelledby="plans-title">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b pb-4">
        <div>
          <h2 id="plans-title" className="text-xl font-semibold tracking-tight">Plans</h2>
          <p className="mt-1 text-sm text-muted-foreground">Pick the plan that fits your business. Pay online and it starts the moment the payment is confirmed.</p>
        </div>
        {o.current?.current_period_end && (
          <p className="text-xs text-muted-foreground">Current period ends {formatDate(o.current.current_period_end)}</p>
        )}
      </div>

      {o.pending && (
        <Card className="flex flex-row flex-wrap items-center justify-between gap-3 border-amber-500/40 px-4 py-3 text-sm">
          <span><span className="font-medium">{o.pending.plan_name} plan</span> is waiting for its payment · {o.pending.number} · {formatMoney(o.pending.total)}</span>
          {canPayOnline && (
            <Button size="sm" onClick={() => setPaying({ id: o.pending!.invoice_id, number: o.pending!.number, total: o.pending!.total, amount_paid: o.pending!.amount_paid, plan: o.pending!.plan_name })}>Pay now</Button>
          )}
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {o.plans.map((p, i) => {
          const isCurrent = p.code === current
          return (
            <Card key={p.code} className={cn('relative gap-0 p-6', isCurrent && 'ring-1 ring-foreground/10')}>
              <div className="flex items-start justify-between gap-3">
                <span className={cn('block size-8 rounded-full border-[7px] bg-transparent', RINGS[i % RINGS.length])} aria-hidden />
                {p.code === recommended && !isCurrent && (
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                    Recommended <BadgeCheck className="size-4" />
                  </span>
                )}
              </div>
              <h3 className="mt-4 text-xl font-semibold">{p.name}</h3>
              <p className="mt-1 min-h-10 text-sm text-muted-foreground">{p.description || limitLine(p)}</p>
              <p className="mt-5 flex items-baseline gap-1.5">
                <span className="text-4xl font-semibold tracking-tight tabular-nums">{p.price > 0 ? formatMoney(p.price) : 'Free'}</span>
                {p.price > 0 && <span className="text-muted-foreground">/{per(p.billing_interval)}</span>}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">{limitLine(p)}</p>
              <div className="mt-6">
                {isCurrent ? (
                  <Button variant="secondary" size="lg" className="w-full" disabled>Your current plan</Button>
                ) : !o.can_pay ? (
                  <Button variant="secondary" size="lg" className="w-full" disabled>Ask the owner to change the plan</Button>
                ) : p.price > 0 && !canPayOnline ? (
                  <Button variant="secondary" size="lg" className="w-full" disabled>Contact the platform team to switch</Button>
                ) : (
                  <Button size="lg" className="w-full" disabled={choose.isPending}
                    onClick={() => confirm(p.price > 0
                      ? `Switch to ${p.name} for ${formatMoney(p.price)} a ${per(p.billing_interval)}? The new plan starts as soon as the payment is confirmed.`
                      : `Switch to the free ${p.name} plan now?`) && choose.mutate(p)}>
                    {!current && p.trial_days > 0 ? `Try free for ${p.trial_days} days` : `Choose ${p.name}`}
                  </Button>
                )}
              </div>
            </Card>
          )
        })}
      </div>

      <FeatureTable plans={o.plans} features={o.all_features} current={current} />

      {paying && (
        <PayDialog title={`Pay for the ${paying.plan} plan · ${paying.number}`} amount={paying.total - paying.amount_paid} gateways={gateways}
          onClose={() => setPaying(null)} start={(gateway) => payInvoice(paying.id, gateway)} />
      )}
    </section>
  )
}

function FeatureTable({ plans, features, current }: { plans: PlanOption[]; features: Array<{ code: string; name: string }>; current?: string }) {
  if (!features.length && !plans.some((p) => Object.keys(p.limits).length)) return null
  const has = (p: PlanOption, code: string) => p.features.some((f) => f.code === code)
  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="px-5 py-4 text-left text-base font-semibold">Plan features</th>
              {plans.map((p, i) => (
                <th key={p.code} className="px-4 py-4 text-left font-semibold">
                  <span className="inline-flex items-center gap-2">
                    <span className={cn('size-3.5 rounded-full border-[3.5px]', RINGS[i % RINGS.length])} aria-hidden />
                    {p.name}{p.code === current && <span className="text-xs font-normal text-muted-foreground">(yours)</span>}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y">
            {LIMIT_KEYS.map((k) => (
              <tr key={k}>
                <td className="px-5 py-3 text-muted-foreground">{LIMIT_LABEL[k]}</td>
                {plans.map((p) => <td key={p.code} className="px-4 py-3 tabular-nums">{p.limits[k] != null ? formatNumber(p.limits[k]!) : 'Unlimited'}</td>)}
              </tr>
            ))}
            {features.map((f) => (
              <tr key={f.code}>
                <td className="px-5 py-3 text-muted-foreground">{f.name}</td>
                {plans.map((p) => (
                  <td key={p.code} className="px-4 py-3">
                    {has(p, f.code)
                      ? <Check className="size-4 text-emerald-600" aria-label="Included" />
                      : <Minus className="size-4 text-muted-foreground/50" aria-label="Not included" />}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}
