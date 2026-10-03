import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, Trash2, X, Zap } from 'lucide-react'
import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { EmptyState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { useStoreConfig } from '@/hooks/use-store-config'
import { formatMoney, isoDateToday } from '@/lib/format'
import { listCouriers } from '@/services/couriers'
import { deleteSmsRule, listSmsRules, saveSmsRule, setSmsRuleEnabled, type SmsRule, type SmsSettings } from '@/services/sms'
import { useSmsOverview } from './sms-overview'
import {
  type Condition, CONDITION_FIELDS, conditionProblem, type ConditionField, describeCondition, newCondition, PAYMENT_OPTIONS,
  renderTemplate, SMS_EVENTS, type SmsEvent, smsParts, smsVariables, SOURCE_OPTIONS,
} from './sms-text'

const ORDER = new Map(SMS_EVENTS.map((e, i) => [e.value as string, i]))
const eventName = (event: string) => SMS_EVENTS.find((e) => e.value === event)?.label ?? event

/** Which message goes out on which event, under which conditions. */
export function SmsAutomationsTab() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const today = isoDateToday()
  const overview = useSmsOverview(today, today)
  const rules = useQuery({ queryKey: ['sms-rules'], queryFn: listSmsRules })
  const couriers = useQuery({ queryKey: ['couriers'], queryFn: () => listCouriers() })
  const [editing, setEditing] = useState<SmsRule | 'new' | null>(null)
  const [deleting, setDeleting] = useState<SmsRule | null>(null)
  const manage = can('sms.manage')
  const settings = overview.data?.settings
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['sms-rules'] })
    void queryClient.invalidateQueries({ queryKey: ['sms-overview'] })
  }
  const toggle = useMutation({
    mutationFn: ({ rule, enabled }: { rule: SmsRule; enabled: boolean }) => setSmsRuleEnabled(rule, enabled),
    onSuccess: refresh,
  })

  if (rules.isLoading) return <LoadingState />
  const sorted = [...(rules.data ?? [])].sort((a, b) => (ORDER.get(a.event) ?? 99) - (ORDER.get(b.event) ?? 99))

  return (
    <div className="space-y-3">
      {settings && !settings.enabled && (
        <div className="rounded-lg border border-dashed p-3 text-sm text-muted-foreground">
          Automatic SMS is off, so nothing below is sent yet. {settings.connected ? 'Turn it on' : 'Connect a provider and turn it on'} under{' '}
          <Link to="/admin/sms" className="font-medium text-foreground underline-offset-4 hover:underline">Overview</Link>.
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Each customer gets a message once per order and event, even if a status is set twice.</p>
        {manage && <Button onClick={() => setEditing('new')}><Plus /> New automation</Button>}
      </div>
      {sorted.length === 0 ? <EmptyState icon={<Zap className="size-5" />} title="No automations yet" /> : (
        <div className="grid gap-2">
          {sorted.map((rule) => {
            const parts = smsParts(rule.template)
            return (
              <Card key={rule.id} className="gap-0 py-0">
                <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start">
                  <Switch className="mt-0.5" checked={rule.is_enabled} disabled={!manage || toggle.isPending}
                    onCheckedChange={(enabled) => toggle.mutate({ rule, enabled })} aria-label={`${rule.name} on or off`} />
                  <div className="min-w-0 flex-1 space-y-1.5">
                    <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                      {rule.name}
                      {rule.name !== eventName(rule.event) && <span className="text-xs font-normal text-muted-foreground">when: {eventName(rule.event)}</span>}
                    </p>
                    {rule.conditions.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {rule.conditions.map((c, i) => (
                          <Badge key={i} variant="outline">{describeCondition(c, { couriers: couriers.data, currency: settings?.currency_text })}</Badge>
                        ))}
                      </div>
                    )}
                    <p className="line-clamp-2 text-sm text-muted-foreground">{rule.template}</p>
                    <p className="text-xs text-muted-foreground">
                      About {parts.segments} SMS{parts.encoding === 'UNICODE' ? ' · Unicode (Bangla or symbols)' : ''} before details are filled in
                    </p>
                  </div>
                  {manage && (
                    <div className="flex gap-1 sm:flex-col">
                      <Button size="icon-sm" variant="ghost" aria-label={`Edit ${rule.name}`} onClick={() => setEditing(rule)}><Pencil /></Button>
                      <Button size="icon-sm" variant="ghost" aria-label={`Delete ${rule.name}`} onClick={() => setDeleting(rule)}><Trash2 /></Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
      {editing && settings && (
        <RuleDialog rule={editing === 'new' ? null : editing} settings={settings} couriers={couriers.data ?? []}
          onClose={() => setEditing(null)} onSaved={refresh} />
      )}
      <ConfirmDialog open={deleting !== null} onOpenChange={(o) => !o && setDeleting(null)} title={`Delete "${deleting?.name}"?`} destructive
        confirmLabel="Delete" description="Messages already sent stay in the log."
        onConfirm={async () => { await deleteSmsRule(deleting!.id); toast.success('Automation deleted'); refresh() }} />
    </div>
  )
}

function RuleDialog({ rule, settings, couriers, onClose, onSaved }: {
  rule: SmsRule | null
  settings: SmsSettings
  couriers: Array<{ id: string; name: string }>
  onClose: () => void
  onSaved: () => void
}) {
  const { data: config } = useStoreConfig()
  const [event, setEvent] = useState<SmsEvent>((rule?.event as SmsEvent) ?? 'ORDER_CREATED')
  const [name, setName] = useState(rule?.name ?? '')
  const [template, setTemplate] = useState(rule?.template ?? 'Hi {{customer_first_name}}, ')
  const [conditions, setConditions] = useState<Condition[]>(rule?.conditions ?? [])
  const [enabled, setEnabled] = useState(rule?.is_enabled ?? true)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const variables = smsVariables(settings.currency_text, { name: config?.store.name, phone: config?.store.phone, website: config?.store.website_url })
  const preview = renderTemplate(template, Object.fromEntries(variables.map((v) => [v.key, v.sample])))
  const parts = smsParts(preview)
  const problem = conditionProblem(conditions)
  const save = useMutation({
    mutationFn: () => saveSmsRule({ id: rule?.id, event, name, template, conditions, enabled }),
    onSuccess: () => { toast.success('Automation saved'); onSaved(); onClose() },
  })

  const insert = (key: string) => {
    const el = textarea.current
    const token = `{{${key}}}`
    if (!el) return setTemplate((t) => t + token)
    const start = el.selectionStart ?? template.length
    const end = el.selectionEnd ?? template.length
    setTemplate(template.slice(0, start) + token + template.slice(end))
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + token.length, start + token.length) })
  }
  const setCondition = (i: number, c: Condition) => setConditions((list) => list.map((x, j) => (j === i ? c : x)))

  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} wide title={rule ? 'Edit automation' : 'New automation'} submitLabel="Save"
      busy={save.isPending} disabled={!template.trim() || problem !== null} onSubmit={() => save.mutate()}>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Send when">
          <Select value={event} onValueChange={(v) => setEvent(v as SmsEvent)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{SMS_EVENTS.map((e) => <SelectItem key={e.value} value={e.value}>{e.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Name (for you)" htmlFor="rule-name">
          <Input id="rule-name" value={name} maxLength={80} placeholder={SMS_EVENTS.find((e) => e.value === event)?.label} onChange={(e) => setName(e.target.value)} />
        </Field>
      </div>
      <p className="-mt-2 text-xs text-muted-foreground">{SMS_EVENTS.find((e) => e.value === event)?.when}.</p>

      <Field label="Only if (optional)">
        <div className="grid gap-2">
          {conditions.map((c, i) => (
            <ConditionRow key={i} condition={c} couriers={couriers} currency={settings.currency_text}
              onChange={(next) => setCondition(i, next)} onRemove={() => setConditions((list) => list.filter((_, j) => j !== i))} />
          ))}
          <Select value="" onValueChange={(v) => setConditions((list) => [...list, newCondition(v as ConditionField)])}>
            <SelectTrigger size="sm" className="w-fit"><span className="flex items-center gap-1"><Plus className="size-3.5" /> Add a condition</span></SelectTrigger>
            <SelectContent>{CONDITION_FIELDS.map((f) => <SelectItem key={f.value} value={f.value}>{f.label}</SelectItem>)}</SelectContent>
          </Select>
          {problem && <p className="text-xs text-destructive">{problem}</p>}
        </div>
      </Field>

      <Field label="Message" htmlFor="rule-template">
        <Textarea id="rule-template" ref={textarea} rows={4} maxLength={1000} value={template} onChange={(e) => setTemplate(e.target.value)} />
      </Field>
      <div className="-mt-2 flex flex-wrap gap-1">
        {variables.filter((v) => v.key !== 'payment_amount' || event === 'PAYMENT_RECEIVED' || event === 'PAYMENT_FAILED').map((v) => (
          <button key={v.key} type="button" onClick={() => insert(v.key)} title={`Example: ${v.sample}`}
            className="rounded-md border px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
            {v.label}
          </button>
        ))}
      </div>
      <div className="rounded-lg bg-muted p-3">
        <p className="mb-1 text-xs font-medium text-muted-foreground">Preview with example details</p>
        <p className="text-sm whitespace-pre-wrap">{preview || '—'}</p>
        <p className="mt-2 text-xs text-muted-foreground">
          {preview.length} characters · {parts.segments} SMS · about {formatMoney(parts.segments * settings.cost_per_sms)} per message
          {parts.encoding === 'UNICODE'
            ? ' · Unicode (Bangla, ৳ or emoji): 70 characters per SMS'
            : ` · ${parts.remaining} characters left in this SMS`}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm"><Switch checked={enabled} onCheckedChange={setEnabled} /> Send this message</label>
    </FormDialog>
  )
}

function ConditionRow({ condition: c, couriers, currency, onChange, onRemove }: {
  condition: Condition
  couriers: Array<{ id: string; name: string }>
  currency: string
  onChange: (c: Condition) => void
  onRemove: () => void
}) {
  const label = CONDITION_FIELDS.find((f) => f.value === c.field)?.label
  const toggle = (value: string, on: boolean) => {
    const list = (c.value as string[]).filter((v) => v !== value)
    onChange({ ...c, value: on ? [...list, value] : list })
  }
  const checks = (options: Array<{ value: string; label: string }>) => (
    <div className="flex flex-wrap gap-x-4 gap-y-1">
      {options.map((o) => (
        <label key={o.value} className="flex items-center gap-1.5 text-sm">
          <Checkbox checked={(c.value as string[]).includes(o.value)} onCheckedChange={(v) => toggle(o.value, v === true)} /> {o.label}
        </label>
      ))}
    </div>
  )
  const isNot = (
    <Select value={c.op} onValueChange={(op) => onChange({ ...c, op: op as Condition['op'] })}>
      <SelectTrigger size="sm" className="w-28"><SelectValue /></SelectTrigger>
      <SelectContent><SelectItem value="in">is</SelectItem><SelectItem value="not_in">is not</SelectItem></SelectContent>
    </Select>
  )

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
      <span className="w-24 text-sm font-medium">{label}</span>
      {c.field === 'payment_method' && <>{isNot}{checks(PAYMENT_OPTIONS)}</>}
      {c.field === 'source' && <>{isNot}{checks(SOURCE_OPTIONS)}</>}
      {c.field === 'courier' && <>{isNot}{couriers.length ? checks(couriers.map((x) => ({ value: x.id, label: x.name }))) : <span className="text-sm text-muted-foreground">No couriers yet</span>}</>}
      {c.field === 'district' && (
        <>
          {isNot}
          <Input className="h-8 min-w-48 flex-1" placeholder="Dhaka, Gazipur, Narayanganj" value={(c.value as string[]).join(', ')}
            onChange={(e) => onChange({ ...c, value: e.target.value.split(',').map((x) => x.trimStart()) })}
            onBlur={(e) => onChange({ ...c, value: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} />
        </>
      )}
      {c.field === 'total' && (
        <>
          <Select value={c.op} onValueChange={(op) => onChange({ ...c, op: op as Condition['op'] })}>
            <SelectTrigger size="sm" className="w-28"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="gte">at least</SelectItem><SelectItem value="lte">at most</SelectItem></SelectContent>
          </Select>
          <span className="text-sm text-muted-foreground">{currency}</span>
          <Input type="number" min={0} className="h-8 w-28" value={String(c.value)} onChange={(e) => onChange({ ...c, value: Number(e.target.value) })} />
        </>
      )}
      {c.field === 'first_order' && (
        <Select value={c.value ? 'first' : 'repeat'} onValueChange={(v) => onChange({ ...c, value: v === 'first' })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="first">First order</SelectItem><SelectItem value="repeat">Repeat customer</SelectItem></SelectContent>
        </Select>
      )}
      <Button type="button" size="icon-sm" variant="ghost" className="ml-auto" aria-label={`Remove ${label} condition`} onClick={onRemove}><X /></Button>
    </div>
  )
}
