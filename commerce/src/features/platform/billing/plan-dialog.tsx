import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { toast } from '@/lib/toast'
import { type Addon, type Feature, LIMIT_KEYS, LIMIT_LABEL, type Limits, type Plan, saveAddon, savePlan } from '@/services/billing'

const num = (v: string) => (v.trim() === '' ? undefined : Number(v))
const limitsFrom = (form: Record<string, string>): Limits =>
  Object.fromEntries(LIMIT_KEYS.map((k) => [k, num(form[k] ?? '')]).filter(([, v]) => v !== undefined && Number.isFinite(v))) as Limits

/** Create or edit a plan. Price changes apply to new invoices; invoices already raised never change. */
export function PlanDialog({ plan, features, open, onOpenChange }: { plan: Plan | null; features: Feature[]; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({
    name: plan?.name ?? '', code: plan?.code ?? '', description: plan?.description ?? '', price: String(plan?.price ?? ''),
    billing_interval: plan?.billing_interval ?? 'MONTH', trial_days: String(plan?.trial_days ?? 14),
    order_price: plan?.overage.order_price != null ? String(plan.overage.order_price) : '', note: '',
    ...Object.fromEntries(LIMIT_KEYS.map((k) => [k, plan?.limits[k] != null ? String(plan.limits[k]) : ''])),
  })
  const [isPublic, setIsPublic] = useState(plan?.is_public ?? true)
  const [included, setIncluded] = useState<Record<string, boolean>>(plan?.features ?? {})
  const save = useMutation({
    mutationFn: () => savePlan({
      ...(plan ? { id: plan.id } : { code: form.code || undefined }),
      name: form.name.trim(), description: form.description, price: Number(form.price || 0), billing_interval: form.billing_interval,
      trial_days: Number(form.trial_days || 0), is_public: isPublic, limits: limitsFrom(form),
      overage: form.order_price.trim() ? { order_price: Number(form.order_price) } : {},
      features: Object.fromEntries(Object.entries(included).filter(([, v]) => v)), note: form.note || undefined,
    }),
    onSuccess: () => {
      toast.success(plan ? 'Plan saved' : 'Plan created')
      void queryClient.invalidateQueries({ queryKey: ['platform-plans'] })
      onOpenChange(false)
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const optional = features.filter((f) => !f.is_core)
  const valid = form.name.trim().length >= 2 && Number(form.price || 0) >= 0 && Number(form.trial_days || 0) >= 0 && Number(form.trial_days || 0) <= 365

  return (
    <FormDialog open={open} onOpenChange={onOpenChange} wide title={plan ? `Edit ${plan.name}` : 'New plan'} busy={save.isPending} disabled={!valid}
      onSubmit={() => save.mutate()} submitLabel={plan ? 'Save plan' : 'Create plan'}
      description={plan ? 'Changes apply to invoices raised from now on. Invoices already raised and payments already made are not changed.' : undefined}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required><Input value={form.name} onChange={set('name')} /></Field>
        {!plan && <Field label="Code" hint="Optional; made from the name"><Input value={form.code} onChange={(e) => setForm((f) => ({ ...f, code: e.target.value.toUpperCase() }))} placeholder="GROWTH_PLUS" /></Field>}
        <Field label="Description" className={plan ? '' : 'sm:col-span-2'}><Input value={form.description} onChange={set('description')} /></Field>
        <Field label="Price (BDT)" required><Input type="number" min={0} step="0.01" value={form.price} onChange={set('price')} /></Field>
        <Field label="Billed every">
          <Select value={form.billing_interval} onValueChange={(v) => setForm((f) => ({ ...f, billing_interval: v }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="MONTH">Month</SelectItem><SelectItem value="YEAR">Year</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field label="Free trial (days)" hint="0 for no trial"><Input type="number" min={0} max={365} value={form.trial_days} onChange={set('trial_days')} /></Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <Switch checked={isPublic} onCheckedChange={setIsPublic} /> Offered to new merchants
        </label>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">Limits <span className="font-normal text-muted-foreground">— leave empty for no limit</span></p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {LIMIT_KEYS.map((k) => <Field key={k} label={LIMIT_LABEL[k]}><Input type="number" min={0} value={form[k]} onChange={set(k)} placeholder="No limit" /></Field>)}
        </div>
        <Field label="Charge per order over the monthly limit (BDT)" className="mt-3" hint="Counted from actual orders and added to the next invoice. Empty: orders over the limit are not charged.">
          <Input type="number" min={0} step="0.01" value={form.order_price} onChange={set('order_price')} disabled={!form.orders_per_month} />
        </Field>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">Included features <span className="font-normal text-muted-foreground">— order handling, inventory, returns and fraud checks are in every plan</span></p>
        <div className="grid gap-2 sm:grid-cols-2">
          {optional.map((f) => (
            <label key={f.code} className="flex items-start gap-2 rounded-md border p-2 text-sm">
              <Checkbox checked={included[f.code] === true} onCheckedChange={(v) => setIncluded((s) => ({ ...s, [f.code]: v === true }))} className="mt-0.5" />
              <span><span className="font-medium">{f.name}</span>{f.description && <span className="block text-xs text-muted-foreground">{f.description}</span>}</span>
            </label>
          ))}
        </div>
      </div>
      <Field label="Note for the history" hint="Why this change — shown in configuration history"><Textarea rows={2} value={form.note} onChange={set('note')} /></Field>
    </FormDialog>
  )
}

/** Create or edit an add-on: a price and what it adds to the plan's limits. */
export function AddonDialog({ addon, open, onOpenChange }: { addon: Addon | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState<Record<string, string>>({
    name: addon?.name ?? '', description: addon?.description ?? '', price: String(addon?.price ?? ''),
    ...Object.fromEntries(LIMIT_KEYS.map((k) => [k, addon?.grants[k] != null ? String(addon.grants[k]) : ''])),
  })
  const save = useMutation({
    mutationFn: () => saveAddon({ ...(addon ? { id: addon.id } : {}), name: form.name.trim(), description: form.description, price: Number(form.price || 0), grants: limitsFrom(form) }),
    onSuccess: () => {
      toast.success('Add-on saved')
      void queryClient.invalidateQueries({ queryKey: ['platform-plans'] })
      onOpenChange(false)
    },
    onError: (e) => toast.error((e as Error).message),
  })
  const set = (k: string) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  return (
    <FormDialog open={open} onOpenChange={onOpenChange} title={addon ? `Edit ${addon.name}` : 'New add-on'} busy={save.isPending}
      disabled={form.name.trim().length < 2 || form.price === ''} onSubmit={() => save.mutate()} submitLabel="Save add-on">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" required><Input value={form.name} onChange={set('name')} placeholder="Extra store" /></Field>
        <Field label="Price per billing period (BDT)" required><Input type="number" min={0} step="0.01" value={form.price} onChange={set('price')} /></Field>
        <Field label="Description" className="sm:col-span-2"><Input value={form.description} onChange={set('description')} /></Field>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium">Adds to the plan's limits</p>
        <div className="grid grid-cols-2 gap-3">
          {LIMIT_KEYS.map((k) => <Field key={k} label={LIMIT_LABEL[k]}><Input type="number" min={0} value={form[k]} onChange={set(k)} placeholder="0" /></Field>)}
        </div>
      </div>
    </FormDialog>
  )
}
