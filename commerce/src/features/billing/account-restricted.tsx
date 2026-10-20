import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Clock, Copy, Lock, MessageCircle, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { afterIntro, PlanSummary, trialEnded } from '@/features/billing/plan-summary'
import { formatDate, formatMoney } from '@/lib/format'
import { toast } from '@/lib/toast'
import { myPlan, type MyPlan, renewNow } from '@/services/billing'
import { payInvoice } from '@/services/credits'
import { PayDialog, useMyCredits } from './credits-section'

/** Shown instead of the admin when the account is blocked (waiting for activation, expired, suspended or closed). */
export function AccountRestricted({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const plan = useQuery({ queryKey: ['my-plan'], queryFn: myPlan })
  const activation = plan.data?.activation
  if (plan.isLoading) return <div className="mx-auto min-h-dvh max-w-3xl p-8"><LoadingState /></div>
  if (activation && plan.data) return <ActivationScreen plan={plan.data} email={email} onSignOut={onSignOut} />
  return (
    <div className="mx-auto min-h-dvh max-w-3xl space-y-4 p-4 sm:p-8">
      <div className="flex items-start gap-3">
        <div className="rounded-full bg-red-50 p-2.5 text-red-600"><Lock className="size-5" /></div>
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{plan.data?.subscription && trialEnded(plan.data.subscription)
            ? `Your ${!plan.data.subscription.current_period_end ? 'free trial' : plan.data.subscription.intro_trial ? 'trial' : 'introductory price'} has ended`
            : 'This account is restricted'}</h1>
          <p className="text-sm text-muted-foreground">
            Signed in as {email}. Your data is kept and nothing has been deleted.
            {plan.data?.subscription && trialEnded(plan.data.subscription) && ' Pay the invoice below to continue; everything opens as soon as the payment is confirmed.'}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={onSignOut}>Sign out</Button>
      </div>
      <PlanSummary compact />
    </div>
  )
}

const waLink = (number: string, text: string) => `https://wa.me/${number.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`

/**
 * The last step of sign-up: pay the first invoice online, or send the prefilled WhatsApp
 * message and wait for the team. The admin opens only once the payment is confirmed by the
 * gateway (server to server) or the team activates the account.
 */
function ActivationScreen({ plan, email, onSignOut }: { plan: MyPlan; email: string; onSignOut: () => void }) {
  const a = plan.activation!
  const queryClient = useQueryClient()
  const credits = useMyCredits()
  const [params] = useSearchParams()
  const [paying, setPaying] = useState(false)
  const invoice = a.state === 'awaiting_payment' ? plan.invoices.find((i) => i.id === a.invoice_id) ?? plan.invoices.find((i) => i.status === 'OPEN') : undefined
  const returned = params.get('payment')
  const check = useMutation({
    mutationFn: async () => {
      await queryClient.invalidateQueries({ queryKey: ['my-plan'] })
      await queryClient.invalidateQueries({ queryKey: ['my-access'] })
    },
  })
  // Back from the payment page: keep asking for a minute while the gateway's confirmation lands.
  useEffect(() => {
    if (!returned || returned === 'cancelled' || returned === 'failed') return
    let n = 0
    const t = setInterval(() => { n += 1; check.mutate(); if (n >= 12) clearInterval(t) }, 5000)
    return () => clearInterval(t)
  }, [returned]) // eslint-disable-line react-hooks/exhaustive-deps

  const s = plan.subscription
  const gateways = credits.data?.gateways ?? []
  return (
    <div className="mx-auto min-h-dvh max-w-xl space-y-5 p-4 sm:p-8">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">Signed in as {email}</p>
        <Button variant="ghost" size="sm" onClick={onSignOut}>Sign out</Button>
      </div>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{a.state === 'awaiting_payment' ? 'Activate your account' : 'Almost there'}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {plan.merchant.name}
          {s && (s.intro_price != null
            ? ` · ${s.plan.name} plan: ${formatMoney(s.intro_price)} for ${s.intro_trial ? 'the trial' : `the first ${s.billing_interval === 'YEAR' ? 'year' : 'month'}`}, ${afterIntro(s)}`
            : ` · ${s.plan.name} plan, ${formatMoney(s.price)} / ${s.billing_interval === 'YEAR' ? 'year' : 'month'}`)}
        </p>
      </div>

      {a.state === 'awaiting_payment' ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Pay to start</CardTitle>
            <CardDescription>Your admin opens as soon as the payment is confirmed by {gateways.length ? gateways.map((g) => ({ bkash: 'bKash', paystation: 'PayStation', sslcommerz: 'SSLCommerz' })[g] ?? g).join(' or ') : 'the payment gateway'}.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            {returned === 'cancelled' || returned === 'failed' ? (
              <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-400">The payment was not completed. You can try again.</p>
            ) : returned && (
              <p className="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
                <Clock className="size-4" /> Checking the payment with the gateway… this page updates by itself.
              </p>
            )}
            {invoice ? (
              <div className="flex items-center justify-between rounded-xl border px-4 py-3">
                <div>
                  <p className="font-mono text-xs text-muted-foreground">{invoice.number}</p>
                  <p className="text-sm">{invoice.period_start ? `${formatDate(invoice.period_start)} – ${formatDate(invoice.period_end)}` : 'First period'}</p>
                </div>
                <p className="text-xl font-semibold tabular-nums">{formatMoney(invoice.total - invoice.amount_paid)}</p>
              </div>
            ) : <p className="text-sm text-muted-foreground">Preparing your invoice…</p>}
            <div className="flex flex-wrap gap-2">
              <Button size="lg" disabled={!invoice || !credits.data?.can_pay || gateways.length === 0} onClick={() => setPaying(true)}>Pay now</Button>
              <Button size="lg" variant="outline" onClick={() => check.mutate()} disabled={check.isPending}><RefreshCw className={check.isPending ? 'animate-spin' : ''} /> I have paid — check again</Button>
            </div>
            {credits.data && gateways.length === 0 && <p className="text-xs text-muted-foreground">Online payment is not switched on yet. Contact the Fullfilio team to pay another way.</p>}
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Send us your details on WhatsApp</CardTitle>
            <CardDescription>The Fullfilio team activates your account after a quick chat. Your message is ready; just press send.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <pre className="rounded-xl border bg-muted/40 p-3 font-sans text-sm whitespace-pre-wrap">{a.whatsapp_message}</pre>
            <div className="flex flex-wrap gap-2">
              {a.whatsapp_number ? (
                <Button size="lg" asChild className="bg-emerald-600 text-white hover:bg-emerald-700">
                  <a href={waLink(a.whatsapp_number, a.whatsapp_message)} target="_blank" rel="noreferrer"><MessageCircle /> Open WhatsApp</a>
                </Button>
              ) : <p className="text-sm text-muted-foreground">The WhatsApp number is not set yet; please contact the Fullfilio team.</p>}
              <Button size="lg" variant="outline" onClick={() => {
                void navigator.clipboard.writeText(a.whatsapp_message).then(() => toast.success('Message copied'), () => undefined)
              }}><Copy /> Copy message</Button>
            </div>
            {a.whatsapp_number && <p className="text-xs text-muted-foreground">WhatsApp: +{a.whatsapp_number.replace(/^\+/, '')}</p>}
            <div className="flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-sm">
              <span className="flex items-center gap-2 text-muted-foreground"><Clock className="size-4" /> Waiting for activation</span>
              <Button size="sm" variant="ghost" onClick={() => check.mutate()} disabled={check.isPending}><RefreshCw className={check.isPending ? 'animate-spin' : ''} /> Check</Button>
            </div>
          </CardContent>
        </Card>
      )}
      {paying && invoice && credits.data && (
        <PayDialog title={`Pay ${invoice.number}`} amount={invoice.total - invoice.amount_paid} gateways={gateways}
          onClose={() => setPaying(false)} start={(gateway) => payInvoice(invoice.id, gateway)} />
      )}
    </div>
  )
}

/** "Expires in N days": from the reminder days Super Admin set, with Renew now for people who can pay. */
export function RenewalBanner() {
  const plan = useQuery({ queryKey: ['my-plan'], queryFn: myPlan, staleTime: 10 * 60_000 })
  const credits = useMyCredits()
  const [paying, setPaying] = useState<{ id: string; number: string; total: number; amount_paid: number } | null>(null)
  const renew = useMutation({ mutationFn: renewNow, onSuccess: (inv) => setPaying(inv), onError: (e) => toast.error(e) })
  const p = plan.data
  const s = p?.subscription
  if (!p || !s || s.cancel_at_period_end || p.activation) return null
  const ends = s.status === 'TRIALING' ? s.trial_ends_at : s.status === 'ACTIVE' ? s.current_period_end : null
  if (!ends) return null
  const days = Math.max(1, Math.ceil((new Date(ends).getTime() - Date.now()) / 86_400_000))
  const window = Math.max(...(p.reminder_days?.length ? p.reminder_days : [3]))
  if (new Date(ends).getTime() < Date.now() || days > window) return null
  const paid = p.invoices.some((i) => i.status === 'PAID' && i.period_start && new Date(i.period_start).getTime() >= new Date(ends).getTime() - 60_000)
  if (paid) return null
  const canPay = !!credits.data?.can_pay && (credits.data?.gateways.length ?? 0) > 0
  return (
    <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <span className="flex items-center gap-2">
        <CalendarClock className="size-4 text-amber-600" />
        {s.status === 'TRIALING' ? 'Your free trial ends' : 'Your plan expires'} in {days} day{days === 1 ? '' : 's'} ({formatDate(ends)}).
      </span>
      {canPay ? <Button size="sm" onClick={() => renew.mutate()} disabled={renew.isPending}>Renew now</Button>
        : <Link to="/admin/settings/billing" className="font-medium underline">Plan & Billing</Link>}
      {paying && credits.data && (
        <PayDialog title={`Renew · ${paying.number}`} amount={paying.total - paying.amount_paid} gateways={credits.data.gateways}
          onClose={() => setPaying(null)} start={(gateway) => payInvoice(paying.id, gateway)} />
      )}
    </div>
  )
}

/** A thin bar over every page while the account is read-only. */
export function ReadOnlyBanner() {
  return (
    <div className="no-print mb-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm">
      <span>Read-only: you can view and export, but changes are paused. Your store still takes orders.</span>
      <Link to="/admin/settings/billing" className="font-medium underline">See why</Link>
    </div>
  )
}
