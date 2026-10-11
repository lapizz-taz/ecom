import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { InvoiceTable, PendingPayments } from '@/features/platform/billing/invoices'
import { usePlatform } from '@/features/platform/platform-context'
import { formatDate, formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  ACCESS_MODE, ENTITLEMENT, type Entitlement, LIMIT_KEYS, LIMIT_LABEL, listPlans, merchantBilling, type MerchantBilling, setMerchantFeature,
  SUBSCRIPTION_STATUS, subscriptionAction,
} from '@/services/billing'
import type { MerchantDetail } from '@/services/platform'

type Action = 'change_plan' | 'extend_trial' | 'pause' | 'resume' | 'cancel' | 'undo_cancel' | 'add_addon' | 'remove_addon'
const ACTION_TITLE: Record<Action, string> = {
  change_plan: 'Change plan', extend_trial: 'Extend the trial', pause: 'Pause the subscription', resume: 'Resume the subscription',
  cancel: 'Cancel the subscription', undo_cancel: 'Keep the subscription', add_addon: 'Add an add-on', remove_addon: 'Remove the add-on',
}
const ACTION_HELP: Partial<Record<Action, string>> = {
  change_plan: 'The new plan and price apply from the next invoice. Invoices already raised are not changed.',
  pause: 'No invoices while paused; the account follows the "paused" access rule. The paused time is added back to the period on resume.',
  cancel: 'At the end of the period the subscription ends and the account follows the "cancelled" access rule.',
}

function SubscriptionActionDialog({ merchantId, action, billing, addonId, onClose }: { merchantId: string; action: Action; billing: MerchantBilling; addonId?: string; onClose: () => void }) {
  const queryClient = useQueryClient()
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: listPlans, enabled: action === 'change_plan' || action === 'add_addon' })
  const [form, setForm] = useState({ plan_id: '', price: '', trial: true, days: '7', immediately: false, addon_id: '', quantity: '1', reason: '' })
  const run = useMutation({
    mutationFn: () => subscriptionAction(merchantId, action, {
      reason: form.reason.trim(),
      ...(action === 'change_plan' ? { plan_id: form.plan_id, ...(form.price ? { price: Number(form.price) } : {}), ...(billing.subscription ? {} : { trial: form.trial }) } : {}),
      ...(action === 'extend_trial' ? { days: Number(form.days) } : {}),
      ...(action === 'cancel' ? { immediately: form.immediately } : {}),
      ...(action === 'add_addon' ? { addon_id: form.addon_id, quantity: Number(form.quantity) } : {}),
      ...(action === 'remove_addon' ? { subscription_addon_id: addonId } : {}),
    }),
    onSuccess: (data) => {
      queryClient.setQueryData(['platform-merchant-billing', merchantId], data)
      void queryClient.invalidateQueries({ queryKey: ['platform-merchant', merchantId] })
      toast.success('Done')
      onClose()
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const chosen = plans.data?.plans.find((p) => p.id === form.plan_id)
  const valid = form.reason.trim().length >= 3 && (action !== 'change_plan' || Boolean(form.plan_id)) && (action !== 'add_addon' || Boolean(form.addon_id))
    && (action !== 'extend_trial' || (Number(form.days) >= 1 && Number(form.days) <= 90))
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title={ACTION_TITLE[action]} description={ACTION_HELP[action]} busy={run.isPending} disabled={!valid}
      destructive={action === 'cancel'} onSubmit={() => run.mutate()} submitLabel={ACTION_TITLE[action]}>
      {action === 'change_plan' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan" required className="sm:col-span-2">
            <Select value={form.plan_id} onValueChange={(plan_id) => setForm((f) => ({ ...f, plan_id }))}>
              <SelectTrigger><SelectValue placeholder="Choose a plan" /></SelectTrigger>
              <SelectContent>
                {(plans.data?.plans ?? []).filter((p) => p.status === 'ACTIVE' && p.id !== billing.subscription?.plan_id).map((p) => (
                  <SelectItem key={p.id} value={p.id}>{p.name} — {formatMoney(p.price)}/{p.billing_interval === 'YEAR' ? 'year' : 'month'}{!p.is_public && ' (hidden)'}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Special price (BDT)" hint={chosen ? `Plan price ${formatMoney(chosen.price)}; empty keeps it` : 'Empty: the plan price'}>
            <Input type="number" min={0} step="0.01" value={form.price} onChange={(e) => setForm((f) => ({ ...f, price: e.target.value }))} />
          </Field>
          {!billing.subscription && chosen && chosen.trial_days > 0 && (
            <label className="flex items-center gap-2 self-end pb-2 text-sm"><Checkbox checked={form.trial} onCheckedChange={(v) => setForm((f) => ({ ...f, trial: v === true }))} /> Start with the {chosen.trial_days}-day trial</label>
          )}
          {!billing.subscription && chosen && chosen.price > 0 && !(form.trial && chosen.trial_days > 0) && (
            <p className="text-xs text-amber-600 sm:col-span-2">The first invoice is raised now; the period starts when it is paid.</p>
          )}
        </div>
      )}
      {action === 'extend_trial' && (
        <Field label="Extra days" hint="1 to 90"><Input type="number" min={1} max={90} value={form.days} onChange={(e) => setForm((f) => ({ ...f, days: e.target.value }))} /></Field>
      )}
      {action === 'cancel' && (
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={form.immediately} onCheckedChange={(v) => setForm((f) => ({ ...f, immediately: v === true }))} /> End it now instead of at the end of the period</label>
      )}
      {action === 'add_addon' && (
        <div className="grid grid-cols-3 gap-3">
          <Field label="Add-on" required className="col-span-2">
            <Select value={form.addon_id} onValueChange={(addon_id) => setForm((f) => ({ ...f, addon_id }))}>
              <SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
              <SelectContent>{(plans.data?.addons ?? []).filter((a) => a.status === 'ACTIVE').map((a) => <SelectItem key={a.id} value={a.id}>{a.name} — {formatMoney(a.price)}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Quantity"><Input type="number" min={1} max={1000} value={form.quantity} onChange={(e) => setForm((f) => ({ ...f, quantity: e.target.value }))} /></Field>
        </div>
      )}
      <Field label="Reason" required hint="Recorded in the subscription history and the audit log"><Textarea rows={2} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} /></Field>
    </FormDialog>
  )
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number | undefined }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0
  return (
    <div className="space-y-1 text-sm">
      <div className="flex justify-between"><span className="text-muted-foreground">{label}</span><span className="tabular-nums">{formatNumber(used)} / {limit != null ? formatNumber(limit) : 'no limit'}</span></div>
      {limit != null && <div className="h-1.5 rounded-full bg-muted"><div className={cn('h-full rounded-full', pct >= 100 ? 'bg-red-500' : pct >= 80 ? 'bg-amber-500' : 'bg-emerald-500')} style={{ width: `${pct}%` }} /></div>}
    </div>
  )
}

export function MerchantBillingTab({ detail }: { detail: MerchantDetail }) {
  const id = detail.merchant.id
  const { can, me } = usePlatform()
  const queryClient = useQueryClient()
  const [action, setAction] = useState<{ action: Action; addonId?: string } | null>(null)
  const billing = useQuery({ queryKey: ['platform-merchant-billing', id], queryFn: () => merchantBilling(id) })
  if (billing.error) return <ErrorState error={billing.error} onRetry={() => billing.refetch()} />
  if (!billing.data) return <LoadingState />
  const b = billing.data
  const s = b.subscription
  const manage = can('subscriptions', 'manage', id)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['platform-merchant-billing', id] })
  const pending = b.payments.filter((p) => p.status === 'PENDING').map((p) => ({
    ...p, invoice_number: b.invoices.find((i) => i.id === p.invoice_id)?.number, can_verify: p.recorded_by !== me?.user_id && can('subscriptions', 'approve', id),
  }))
  const act = (a: Action, addonId?: string) => setAction({ action: a, addonId })

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-sm">Subscription <Badge variant={ACCESS_MODE[b.access_mode].variant}>{ACCESS_MODE[b.access_mode].label}</Badge></CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {!s ? <p className="text-sm text-muted-foreground">No current subscription. The account follows the "never had a subscription" or "expired/cancelled" access rule.</p> : (
              <div className="space-y-1 text-sm">
                <p className="flex items-center gap-2 text-base font-semibold">{s.plan.name} <StatusBadge value={s.status} map={SUBSCRIPTION_STATUS} /></p>
                <p>{formatMoney(s.price)} / {s.billing_interval === 'YEAR' ? 'year' : 'month'}{s.price !== s.plan.price && <span className="text-muted-foreground"> (plan price {formatMoney(s.plan.price)})</span>}</p>
                {s.status === 'TRIALING' && <p className="text-muted-foreground">Trial ends {formatDateTime(s.trial_ends_at)}</p>}
                {s.current_period_end && s.status !== 'TRIALING' && <p className="text-muted-foreground">Current period ends {formatDate(s.current_period_end)}</p>}
                {s.status === 'PAST_DUE' && s.grace_until && <p className="text-amber-600">Unpaid — grace period until {formatDateTime(s.grace_until)}</p>}
                {s.status === 'PAUSED' && <p className="text-muted-foreground">Paused since {formatDateTime(s.paused_at)}</p>}
                {s.cancel_at_period_end && <p className="text-amber-600">Ends at the end of this period</p>}
              </div>
            )}
            {manage && (
              <div className="flex flex-wrap gap-2 border-t pt-3">
                <Button size="sm" variant="outline" onClick={() => act('change_plan')}>{s ? 'Change plan' : 'Start a subscription'}</Button>
                {s && ['TRIALING', 'PAST_DUE'].includes(s.status) && <Button size="sm" variant="outline" onClick={() => act('extend_trial')}>Extend trial</Button>}
                {s && ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(s.status) && <Button size="sm" variant="outline" onClick={() => act('pause')}>Pause</Button>}
                {s?.status === 'PAUSED' && <Button size="sm" variant="outline" onClick={() => act('resume')}>Resume</Button>}
                {s && <Button size="sm" variant="outline" onClick={() => act('add_addon')}>Add add-on</Button>}
                {s && !s.cancel_at_period_end && <Button size="sm" variant="ghost" onClick={() => act('cancel')}>Cancel…</Button>}
                {s?.cancel_at_period_end && <Button size="sm" variant="ghost" onClick={() => act('undo_cancel')}>Keep subscription</Button>}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-sm">Usage against limits</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {LIMIT_KEYS.map((k) => <Meter key={k} label={LIMIT_LABEL[k]} used={Number(b.usage[k] ?? 0)} limit={b.limits[k]} />)}
            {b.addons.length > 0 && (
              <div className="space-y-1 border-t pt-2 text-sm">
                {b.addons.map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-2">
                    <span>{a.name} × {a.quantity} <span className="text-muted-foreground">· {formatMoney(a.price * a.quantity)}</span></span>
                    {manage && <Button size="sm" variant="ghost" onClick={() => act('remove_addon', a.id)}>Remove</Button>}
                  </div>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">New stores, staff logins and products are refused by the database once a limit is reached. Orders are never refused for the monthly limit; extra orders are charged only if the plan has an overage price.</p>
          </CardContent>
        </Card>
      </div>
      <PendingPayments payments={pending} onChanged={refresh} />
      <Card className="gap-0 overflow-hidden py-0">
        <p className="border-b px-4 py-2 text-sm font-medium">Invoices</p>
        {b.invoices.length === 0 ? <EmptyState title="No invoices yet" /> : (
          <InvoiceTable invoices={b.invoices} payments={b.payments} canManage={() => manage} onChanged={refresh} />
        )}
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">History</CardTitle></CardHeader>
        <CardContent className="space-y-1.5">
          {b.events.length === 0 && <p className="text-sm text-muted-foreground">Nothing yet.</p>}
          {b.events.map((e) => (
            <div key={e.id} className="flex justify-between gap-3 text-xs">
              <span className="min-w-0 truncate"><code>{e.event}</code>{typeof e.detail.reason === 'string' && <span className="ml-2 text-muted-foreground">“{e.detail.reason}”</span>}</span>
              <span className="shrink-0 text-muted-foreground">{formatDateTime(e.created_at)}</span>
            </div>
          ))}
        </CardContent>
      </Card>
      {action && <SubscriptionActionDialog merchantId={id} action={action.action} addonId={action.addonId} billing={b} onClose={() => setAction(null)} />}
    </div>
  )
}

export function MerchantFeaturesTab({ detail }: { detail: MerchantDetail }) {
  const id = detail.merchant.id
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const billing = useQuery({ queryKey: ['platform-merchant-billing', id], queryFn: () => merchantBilling(id) })
  const [change, setChange] = useState<{ code: string; feature: Entitlement; to: boolean | null } | null>(null)
  const [expires, setExpires] = useState('')
  if (billing.error) return <ErrorState error={billing.error} onRetry={() => billing.refetch()} />
  if (!billing.data) return <LoadingState />
  const edit = can('features', 'edit', id)
  const entries = Object.entries(billing.data.entitlements)
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">What this merchant can use right now, and why. An exception here overrides the plan for this merchant only; "Follow plan" removes it.</p>
      <Card className="gap-0 py-0">
        {entries.map(([code, f]) => (
          <div key={code} className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5 text-sm last:border-0">
            <span className="min-w-0">
              <span className="font-medium">{f.name}</span>
              <span className="block text-xs text-muted-foreground">{ENTITLEMENT[f.state].explain}{f.override != null && ` · exception: ${f.override_reason ?? 'no reason'}`}</span>
            </span>
            <span className="flex items-center gap-2">
              <Badge variant={ENTITLEMENT[f.state].variant}>{ENTITLEMENT[f.state].label}</Badge>
              {edit && f.state !== 'CORE' && (
                <Select value={f.override == null ? 'plan' : f.override ? 'on' : 'off'}
                  onValueChange={(v) => setChange({ code, feature: f, to: v === 'plan' ? null : v === 'on' })}>
                  <SelectTrigger size="sm" className="w-36" aria-label={`${f.name} for this merchant`}><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="plan">Follow plan</SelectItem>
                    <SelectItem value="on">Always on</SelectItem>
                    <SelectItem value="off">Switched off</SelectItem>
                  </SelectContent>
                </Select>
              )}
            </span>
          </div>
        ))}
      </Card>
      {change && (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) { setChange(null); setExpires('') } }} reason reasonRequired
          title={`${change.feature.name}: ${change.to === null ? 'follow the plan' : change.to ? 'switch on' : 'switch off'} for ${detail.merchant.name}?`}
          description={change.to === false ? 'The backend refuses it for this merchant from now on (for example: store connections, imports, reports).' : 'Takes effect immediately.'}
          confirmLabel="Apply" destructive={change.to === false}
          onConfirm={async (reason) => {
            try {
              await setMerchantFeature(id, change.code, change.to, reason, expires ? new Date(expires).toISOString() : null)
              toast.success('Feature access changed')
              void queryClient.invalidateQueries({ queryKey: ['platform-merchant-billing', id] })
              setExpires('')
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }}>
          {change.to !== null && (
            <Field label="Until (optional)" hint="After this date the merchant follows the plan again">
              <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
            </Field>
          )}
        </ConfirmDialog>
      )}
    </div>
  )
}
