import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowRight, Check, Clock, Loader2, RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { LogoMark } from '@/components/brand/logo'
import { Button } from '@/components/ui/button'
import { planLimits } from '@/features/onboarding/signup-parts'
import { formatMoney } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { choosePlan, type MyPlan } from '@/services/billing'
import { payInvoice } from '@/services/credits'
import { signupOptions, type SignupPlan } from '@/services/onboarding'
import { PayDialog, useMyCredits } from './credits-section'

const STEPS = ['Account', 'Business info', 'Plan & payment']
const GATEWAY_LABEL: Record<string, string> = { bkash: 'bKash', paystation: 'PayStation', sslcommerz: 'SSLCommerz' }

/** What the business pays first on this plan, for what, and what follows. */
function charges(p: SignupPlan): { amount: number; per: string; then: string | null } {
  const month = p.billing_interval?.toUpperCase() === 'YEAR' ? 'yr' : 'mo'
  const fee = p.offer?.setup_fee ? `${formatMoney(p.offer.setup_fee)} once + ` : ''
  const then = `then ${fee}${formatMoney(Number(p.price))}/${month}`
  if (p.offer?.trial_price) return { amount: Number(p.offer.trial_price), per: `${p.trial_days}-day trial`, then }
  if (p.offer?.first_price != null) return { amount: Number(p.offer.first_price), per: 'first month', then }
  return { amount: Number(p.price), per: month === 'yr' ? 'year' : 'month', then: null }
}

/** A still, blurred picture of the admin behind the popup (nothing in it is real or clickable). */
function AdminBackdrop() {
  const bar = 'rounded bg-foreground/10'
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden bg-background select-none">
      <div className="flex h-full scale-[1.03] blur-[6px]">
        <aside className="hidden w-56 shrink-0 flex-col gap-2 border-r bg-muted/40 p-4 md:flex">
          <div className="mb-3 flex items-center gap-2"><LogoMark className="size-6" /><div className={cn(bar, 'h-3 w-20 bg-foreground/20')} /></div>
          {[62, 80, 55, 74, 68, 50, 77, 58, 70].map((w, i) => (
            <div key={i} className={cn('flex items-center gap-2.5 rounded-md px-2 py-1.5', i === 0 && 'bg-foreground/[0.06]')}>
              <div className={cn(bar, 'size-4')} /><div className={cn(bar, 'h-2.5')} style={{ width: `${w}%` }} />
            </div>
          ))}
        </aside>
        <div className="flex-1 space-y-5 p-6">
          <div className="flex items-center justify-between"><div className={cn(bar, 'h-5 w-44 bg-foreground/15')} /><div className="h-8 w-28 rounded-lg bg-brand/25" /></div>
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="space-y-3 rounded-xl border bg-card p-4"><div className={cn(bar, 'h-2.5 w-16')} /><div className={cn(bar, 'h-6 w-24 bg-foreground/15')} /><div className={cn(bar, 'h-2 w-20')} /></div>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="flex h-56 items-end gap-2 rounded-xl border bg-card p-5 lg:col-span-2">
              {[40, 65, 52, 80, 58, 72, 90, 66, 76, 60, 84, 70].map((h, i) => <div key={i} className="flex-1 rounded-t bg-brand/20" style={{ height: `${h}%` }} />)}
            </div>
            <div className="h-56 space-y-3 rounded-xl border bg-card p-5">{[70, 55, 80, 45, 65].map((w, i) => <div key={i} className={cn(bar, 'h-3')} style={{ width: `${w}%` }} />)}</div>
          </div>
          <div className="divide-y rounded-xl border bg-card">
            {[0, 1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="flex items-center gap-4 px-5 py-3.5"><div className={cn(bar, 'size-8 rounded-full')} /><div className={cn(bar, 'h-2.5 w-40')} /><div className={cn(bar, 'ml-auto h-2.5 w-16')} /></div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * The last sign-up step as a setup popup over the (blurred) admin: the plans with the
 * new-business offer, the chosen one marked, and Proceed to payment for its first invoice.
 * Choosing another plan before paying switches the plan and the invoice on the server.
 */
export function ActivationSetup({ plan, email, returned, checking, onCheck, onSignOut }: {
  plan: MyPlan; email: string; returned: string | null; checking: boolean; onCheck: () => void; onSignOut: () => void
}) {
  const queryClient = useQueryClient()
  const credits = useMyCredits()
  const options = useQuery({ queryKey: ['signup-options'], queryFn: signupOptions, staleTime: 60_000 })
  const [paying, setPaying] = useState(false)
  const [switching, setSwitching] = useState<string | null>(null)
  const a = plan.activation?.state === 'awaiting_payment' ? plan.activation : null
  const invoice = plan.invoices.find((i) => i.id === a?.invoice_id && i.status === 'OPEN') ?? plan.invoices.find((i) => i.status === 'OPEN')
  const current = plan.subscription?.plan.code
  const plans = (options.data?.plans ?? []).filter((p) => Number(p.price) > 0)
  const popular = plans.length > 2 ? plans[1]?.code : null
  const gateways = credits.data?.gateways ?? []
  const due = invoice ? invoice.total - invoice.amount_paid : null

  const choose = useMutation({
    mutationFn: choosePlan,
    onMutate: (code) => setSwitching(code),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ['my-plan'] }) },
    onError: (e) => toast.error(e),
    onSettled: () => setSwitching(null),
  })

  return (
    <div className="fixed inset-0 z-40">
      <AdminBackdrop />
      <div className="absolute inset-0 bg-black/25" />
      <div className="absolute inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center justify-center p-3 sm:p-6">
          <div role="dialog" aria-modal="true" aria-labelledby="setup-title" className="w-full max-w-[800px] overflow-hidden rounded-2xl border bg-background shadow-2xl">
            <header className="bg-[#0b0d12] px-6 pt-4 pb-4 text-white">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2"><LogoMark className="size-5 shrink-0" /><span className="truncate text-sm font-medium">Fullfilio setup</span></div>
                <span className="shrink-0 text-xs text-white/60">Step 3 of 3 · Plan &amp; payment</span>
              </div>
              <ol className="mt-3 grid grid-cols-3 gap-1.5" aria-label="Steps">
                {STEPS.map((s, i) => (
                  <li key={s} aria-current={i === 2 ? 'step' : undefined} title={s}>
                    <span className={cn('block h-1 rounded-full', i < 2 ? 'bg-emerald-500' : 'bg-brand')} /><span className="sr-only">{s}</span>
                  </li>
                ))}
              </ol>
            </header>

            <div className="px-6 pt-6 pb-5">
              <h1 id="setup-title" className="text-lg font-semibold tracking-tight">Choose your plan</h1>
              <p className="mt-0.5 text-[13px] text-muted-foreground">You can switch until you pay.</p>
              {returned === 'cancelled' || returned === 'failed' ? (
                <p className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">The payment was not completed. You can try again.</p>
              ) : returned && (
                <p className="mt-4 flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                  <Clock className="size-4 shrink-0" /> Checking the payment with the gateway… this page updates by itself.
                </p>
              )}

              <div className="mt-5 grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Plan">
                {plans.map((p) => {
                  const selected = p.code === current
                  const c = charges(p)
                  return (
                    <button key={p.code} type="button" role="radio" aria-checked={selected} disabled={choose.isPending}
                      onClick={() => { if (!selected) choose.mutate(p.code) }}
                      className={cn('relative flex flex-col rounded-xl border p-4 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-brand/40 disabled:cursor-wait',
                        selected ? 'border-brand bg-brand-soft/40' : 'hover:border-foreground/30')}>
                      <span className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium">
                          {p.name}
                          {p.code === popular && <span className="ml-1.5 text-[11px] font-normal text-brand">Popular</span>}
                        </span>
                        <span className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', selected ? 'border-brand bg-brand text-brand-foreground' : 'border-foreground/25')}>
                          {switching === p.code ? <Loader2 className="size-3 animate-spin text-brand" /> : selected && <Check className="size-2.5" strokeWidth={3.5} />}
                        </span>
                      </span>
                      <span className="mt-3 text-2xl font-semibold tracking-tight tabular-nums">{formatMoney(c.amount)}<span className="ml-1 text-xs font-normal text-muted-foreground">/ {c.per}</span></span>
                      {c.then && <span className="mt-0.5 text-[11px] text-muted-foreground">{c.then}</span>}
                      <span className="mt-4 space-y-1.5 border-t pt-3">
                        {planLimits(p).slice(0, 3).map((f) => (
                          <span key={f} className="flex items-center gap-1.5 text-xs text-muted-foreground"><Check className="size-3 shrink-0 text-brand" strokeWidth={3} />{f}</span>
                        ))}
                      </span>
                    </button>
                  )
                })}
                {options.isLoading && <p className="col-span-full py-6 text-center text-sm text-muted-foreground">Loading plans…</p>}
              </div>
            </div>

            <footer className="flex flex-col-reverse gap-3 border-t px-6 py-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="truncate">{email}</span>
                <button type="button" className="hover:text-foreground" onClick={onSignOut}>Sign out</button>
                <button type="button" className="inline-flex items-center gap-1 hover:text-foreground disabled:opacity-50" onClick={onCheck} disabled={checking}>
                  <RefreshCw className={cn('size-3', checking && 'animate-spin')} /> Check payment
                </button>
              </div>
              <div className="flex items-center justify-between gap-4 sm:justify-end">
                {due != null && (
                  <p className="text-right text-xs leading-tight text-muted-foreground">
                    Due now<span className="block text-base font-semibold text-foreground tabular-nums">{formatMoney(due)}</span>
                  </p>
                )}
                <Button disabled={!invoice || choose.isPending || !credits.data?.can_pay || gateways.length === 0} onClick={() => setPaying(true)}>
                  Proceed to payment <ArrowRight />
                </Button>
              </div>
            </footer>
            {credits.data && (gateways.length === 0
              ? <p className="border-t px-6 py-2 text-center text-xs text-muted-foreground">Online payment is not switched on yet. Contact the Fullfilio team to pay another way.</p>
              : <p className="sr-only">Pay with {gateways.map((g) => GATEWAY_LABEL[g] ?? g).join(', ')}</p>)}
          </div>
        </div>
      </div>
      {paying && invoice && credits.data && (
        <PayDialog title={`Pay ${invoice.number}`} amount={invoice.total - invoice.amount_paid} gateways={gateways}
          onClose={() => setPaying(false)} start={(gateway) => payInvoice(invoice.id, gateway)} />
      )}
    </div>
  )
}
