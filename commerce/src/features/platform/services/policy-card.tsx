import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from '@/lib/toast'
import { saveUsagePolicy, type Service, type ServiceStatus, type UsagePolicy } from '@/services/credits'

const STATUSES = [['ACTIVE', 'Paid up'], ['TRIALING', 'On trial'], ['PAST_DUE', 'Past due'], ['PAUSED', 'Paused']] as const

/** Free allowance, eligibility, what counts as one use, and charging after the allowance — enforced by the database. */
export function UsagePolicyCard({ service, status }: { service: Service; status: ServiceStatus }) {
  const queryClient = useQueryClient()
  const [p, setP] = useState<UsagePolicy>(status.policy)
  const [confirm, setConfirm] = useState(false)
  const edit = status.can.edit
  const dirty = JSON.stringify(p) !== JSON.stringify(status.policy)
  const save = useMutation({
    mutationFn: (reason: string) => saveUsagePolicy(service, p, reason),
    onSuccess: () => { toast.success('Policy saved'); void queryClient.invalidateQueries({ queryKey: ['platform-service', service] }) },
  })
  const unit = service === 'SMS' ? (p.unit === 'MESSAGE' ? 'message' : 'SMS part') : 'lookup'
  const togglePlan = (list: string[], code: string, on: boolean) => (on ? [...new Set([...list, code])] : list.filter((c) => c !== code))
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Free use and charging</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3 rounded-md border p-3">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Switch disabled={!edit} checked={p.free.enabled} onCheckedChange={(v) => setP({ ...p, free: { ...p.free, enabled: v } })} /> Free allowance
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={`Free ${unit}s`}>
              <Input type="number" min={0} disabled={!edit || !p.free.enabled} value={p.free.limit} onChange={(e) => setP({ ...p, free: { ...p.free, limit: Math.max(0, Math.floor(Number(e.target.value) || 0)) } })} />
            </Field>
            <Field label="Given">
              <Select disabled={!edit || !p.free.enabled} value={p.free.period} onValueChange={(v) => setP({ ...p, free: { ...p.free, period: v as 'ONCE' | 'MONTH' } })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="ONCE">Once per merchant</SelectItem><SelectItem value="MONTH">Every month</SelectItem></SelectContent>
              </Select>
            </Field>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">For merchants whose subscription is</p>
            <div className="flex flex-wrap gap-3">
              {STATUSES.map(([code, label]) => (
                <label key={code} className="flex items-center gap-1.5 text-sm">
                  <Checkbox disabled={!edit || !p.free.enabled} checked={p.free.statuses.includes(code)}
                    onCheckedChange={(v) => setP({ ...p, free: { ...p.free, statuses: togglePlan(p.free.statuses, code, v === true) } })} /> {label}
                </label>
              ))}
            </div>
          </div>
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">On plans (none ticked = every plan that includes the feature)</p>
            <div className="flex flex-wrap gap-3">
              {status.plans.filter((pl) => pl.includes).map((pl) => (
                <label key={pl.code} className="flex items-center gap-1.5 text-sm">
                  <Checkbox disabled={!edit || !p.free.enabled} checked={p.free.plans.includes(pl.code)}
                    onCheckedChange={(v) => setP({ ...p, free: { ...p.free, plans: togglePlan(p.free.plans, pl.code, v === true) } })} /> {pl.name}
                </label>
              ))}
            </div>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {service === 'SMS' && (
            <Field label="One use is">
              <Select disabled={!edit} value={p.unit} onValueChange={(v) => setP({ ...p, unit: v as UsagePolicy['unit'] })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="SEGMENT">One SMS part (160 / 70 characters)</SelectItem><SelectItem value="MESSAGE">One message, however long</SelectItem></SelectContent>
              </Select>
            </Field>
          )}
          <Field label="After the free allowance">
            <Select disabled={!edit} value={p.after_free} onValueChange={(v) => setP({ ...p, after_free: v as UsagePolicy['after_free'] })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="CREDITS">Pay with credits</SelectItem><SelectItem value="BLOCK">Stop (no paid use)</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label={`Credits per ${unit}`}>
            <Input type="number" min={0} disabled={!edit || p.after_free !== 'CREDITS'} value={p.credits_per_unit}
              onChange={(e) => setP({ ...p, credits_per_unit: Math.max(0, Math.floor(Number(e.target.value) || 0)) })} />
          </Field>
          <Field label="Monthly cap per merchant" hint="Empty = no cap. Applies to free, paid and unmetered use.">
            <Input type="number" min={0} disabled={!edit} value={p.monthly_cap ?? ''} placeholder="No cap"
              onChange={(e) => setP({ ...p, monthly_cap: e.target.value === '' ? null : Math.max(0, Math.floor(Number(e.target.value))) })} />
          </Field>
          {service === 'SMS' && (
            <Field label="Messages wait for credits up to (hours)">
              <Input type="number" min={0} max={72} disabled={!edit} value={p.hold_hours ?? 6} onChange={(e) => setP({ ...p, hold_hours: Math.min(72, Math.max(0, Math.floor(Number(e.target.value) || 0))) })} />
            </Field>
          )}
        </div>
        {service === 'SMS' && (
          <label className="flex items-center gap-2 text-sm">
            <Switch disabled={!edit} checked={p.refund_undelivered === true} onCheckedChange={(v) => setP({ ...p, refund_undelivered: v })} /> Refund messages the delivery report says were not delivered
          </label>
        )}
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Unmetered plans (use is recorded but never charged)</p>
          <div className="flex flex-wrap gap-3">
            {status.plans.map((pl) => (
              <label key={pl.code} className="flex items-center gap-1.5 text-sm">
                <Checkbox disabled={!edit} checked={p.unmetered_plans.includes(pl.code)} onCheckedChange={(v) => setP({ ...p, unmetered_plans: togglePlan(p.unmetered_plans, pl.code, v === true) })} /> {pl.name}
              </label>
            ))}
          </div>
        </div>
        {edit && (
          <div className="flex gap-2">
            <Button size="sm" disabled={!dirty} onClick={() => setConfirm(true)}>Save policy</Button>
            {dirty && <Button size="sm" variant="ghost" onClick={() => setP(status.policy)}>Undo changes</Button>}
          </div>
        )}
      </CardContent>
      {confirm && (
        <ConfirmDialog open onOpenChange={(o) => !o && setConfirm(false)} reason reasonRequired title="Save the new policy?"
          description="It applies from the next use. The previous policy stays in the configuration history." confirmLabel="Save"
          onConfirm={async (reason) => {
            try { await save.mutateAsync(reason) } catch (e) { toast.error((e as Error).message); throw e }
          }} />
      )}
    </Card>
  )
}
