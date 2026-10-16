import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { EmptyState, LoadingState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/features/auth/auth-context'
import { CourierHistoryTable } from '@/features/fraud/courier-history'
import { ADVANCE_TYPE, FRAUD_DECISION } from '@/lib/status'
import { myCredits } from '@/services/credits'
import {
  type CourierHistoryResult, courierHistoryStatus, courierPanelStatus, deleteFraudRule, type FraudRule,
  listFraudRules, lookupCourierHistory, lookupCourierPanel, saveFraudRule, toggleFraudRule,
} from '@/services/settings'
import type { Enums } from '@/types/database'
import { ADVANCE_OPTIONS } from './payment-settings'
import { NumberSetting, SelectSetting, SettingCard, SwitchSetting, TextareaSetting, TextSetting, useSettingDraft } from './setting-form'

export function FraudSettings() {
  return (
    <div className="grid gap-4">
      <CourierHistorySettings />
      <CourierPanelSettings />
      <ReceiveRateSettings />
      <FraudGeneral />
      <FraudRules />
    </div>
  )
}

/**
 * Courier-history lookup (BD Courier: Pathao, Steadfast, RedX, Paperfly…)
 * behind the phone check. It runs on the platform's account: nothing to
 * connect here, and each lookup counts against free checks, then credits.
 */
function CourierHistorySettings() {
  const { can } = useAuth()
  const live = useQuery({ queryKey: ['courier-history-status'], queryFn: courierHistoryStatus, enabled: can('settings.view') })
  const credits = useQuery({ queryKey: ['my-credits'], queryFn: myCredits })
  const [phone, setPhone] = useState('')
  const [result, setResult] = useState<CourierHistoryResult | null>(null)
  const lookup = useMutation({
    meta: { silent: true },
    mutationFn: () => lookupCourierHistory(phone.trim()),
    onSuccess: (r) => { setResult(r.result); void credits.refetch() },
    onError: () => setResult(null),
  })
  const u = credits.data?.usage.bd_courier
  const connected = !!live.data?.connected
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Courier history check</CardTitle>
        <CardDescription>
          Looks up the customer's parcels on Pathao, Steadfast, RedX, Paperfly and other couriers the moment they type their number at checkout.
          The delivery success check below uses it to decide cash on delivery or advance. Customers never see these numbers.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {live.isLoading ? <LoadingState /> : (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
            <span className={`size-2.5 rounded-full ${connected && u?.feature_enabled ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{connected ? `${live.data?.service ?? 'BD Courier'} · provided by the platform` : 'Not available right now'}</p>
              <p className="text-xs text-muted-foreground">
                {!connected ? 'Checks use your own store history until it is back.'
                  : u && !u.feature_enabled ? 'Not included in your plan — checks use your own store history.'
                  : u?.unmetered ? 'Included in your plan.'
                  : u ? `${u.free.eligible ? `${u.free.remaining} free checks left${u.free.period === 'MONTH' ? ' this month' : ''} · ` : ''}${u.credits_available} courier check credits${u.monthly_cap != null ? ` · ${u.month_used} of ${u.monthly_cap} used this month` : ''}` : ''}
                {connected && live.data && !live.data.enabled && <span className="block text-amber-700">Turned off for checks — tick “Courier history” under Providers below.</span>}
              </p>
            </div>
            {connected && u && !u.unmetered && u.feature_enabled && <Button size="sm" variant="outline" asChild><Link to="/admin/settings/billing#credits">Buy check credits</Link></Button>}
          </div>
        )}
        {connected && u?.feature_enabled && can('fraud.review') && (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (phone.trim()) lookup.mutate() }}>
            <div className="flex gap-2">
              <Input aria-label="Mobile number to look up" inputMode="tel" placeholder="Look up a number, e.g. 01712345678" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <Button type="submit" variant="outline" disabled={!phone.trim() || lookup.isPending}>{lookup.isPending ? <Spinner /> : <Search />} Look up</Button>
            </div>
            <p className="text-xs text-muted-foreground">Each lookup counts as one check (free checks first, then credits). Failed lookups are not counted.</p>
            {lookup.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{lookup.error.message}</p>}
            {result && <CourierHistoryTable result={result} className="max-w-xl" />}
          </form>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The merchant's OWN logins to the courier merchant panels (Steadfast, Pathao,
 * RedX, Carrybee). We sign in to each panel and read its customer
 * success / fraud page — the real courier numbers, using the merchant's own
 * accounts, so it costs no credits. Unofficial: a courier can change its site
 * or lock an account from too many sign-ins, so each courier shows its own
 * status and one failing never blocks the others.
 */
function CourierPanelSettings() {
  const { can } = useAuth()
  const status = useQuery({ queryKey: ['courier-panel-status'], queryFn: courierPanelStatus, enabled: can('settings.view') })
  const [phone, setPhone] = useState('')
  const [result, setResult] = useState<CourierHistoryResult | null>(null)
  const connectedCount = (status.data?.providers ?? []).filter((p) => p.connected).length
  const connected = !!status.data?.connected
  const lookup = useMutation({
    meta: { silent: true },
    mutationFn: () => lookupCourierPanel(phone.trim()),
    onSuccess: (r) => setResult(r.result),
    onError: () => setResult(null),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Courier sign-in accounts</CardTitle>
        <CardDescription>
          A second delivery-history source next to BD Courier. Fullfilio signs in to Steadfast, Pathao, RedX and Carrybee
          with the company's own accounts and reads each courier's customer success page for the number. Connected and managed by the
          platform; each lookup counts as one check, the same as BD Courier.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {status.isLoading ? <LoadingState /> : (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3">
            <span className={`size-2.5 rounded-full ${connected && status.data?.enabled ? 'bg-emerald-500' : 'bg-zinc-300'}`} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{connected ? `Provided by the platform · ${connectedCount} courier${connectedCount === 1 ? '' : 's'} connected` : 'Not available right now'}</p>
              <p className="text-xs text-muted-foreground">
                {!connected ? 'Checks use BD Courier and your own store history until it is connected.'
                  : (status.data?.providers ?? []).filter((p) => p.connected).map((p) => (p.accounts > 1 ? `${p.label} (${p.accounts} accounts)` : p.label)).join(', ')}
                {connected && status.data && !status.data.enabled && <span className="block text-amber-700">Turned off for checks — tick “Courier sign-in accounts” under Providers below.</span>}
              </p>
            </div>
          </div>
        )}
        {connected && status.data?.enabled && can('fraud.review') && (
          <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); if (phone.trim()) lookup.mutate() }}>
            <div className="flex gap-2">
              <Input aria-label="Mobile number to look up" inputMode="tel" placeholder="Look up a number, e.g. 01712345678" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <Button type="submit" variant="outline" disabled={!phone.trim() || lookup.isPending}>{lookup.isPending ? <Spinner /> : <Search />} Look up</Button>
            </div>
            <p className="text-xs text-muted-foreground">Each lookup counts as one check (free checks first, then credits). Failed lookups are not counted.</p>
            {lookup.error && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-800" role="alert">{lookup.error.message}</p>}
            {result && <CourierHistoryTable result={result} className="max-w-xl" />}
          </form>
        )}
      </CardContent>
    </Card>
  )
}

const TIER_ACTIONS = [
  { value: 'COD', label: 'Cash on delivery' },
  { value: 'ADVANCE', label: 'Advance required' },
  { value: 'REVIEW', label: 'Manual review' },
  { value: 'BLOCK', label: 'Block online order' },
]

/** The phone check at checkout: delivery success rate decides COD vs advance. */
function ReceiveRateSettings() {
  const s = useSettingDraft('fraud')
  const rr = (k: string) => s.get(['receive_rate', k])
  const good = Number(rr('good_min') ?? 80)
  const mid = Number(rr('mid_min') ?? 50)
  const validate = () => (0 < mid && mid < good && good <= 100 ? null : 'Medium must be above 0 and below Good; Good at most 100')
  const tiers = [
    { key: 'GOOD', dot: 'bg-emerald-500', label: 'Good', range: `${good}% or more delivered` },
    { key: 'MID', dot: 'bg-amber-500', label: 'Medium', range: `${mid}% – ${Math.max(good - 1, mid)}%` },
    { key: 'LOW', dot: 'bg-red-500', label: 'Low', range: `below ${mid}%` },
    { key: 'NEW', dot: 'bg-sky-500', label: 'New customer', range: `no history, or fewer than ${Number(rr('min_parcels') ?? 1)} parcel${Number(rr('min_parcels') ?? 1) === 1 ? '' : 's'}` },
    { key: 'ERROR', dot: 'bg-zinc-400', label: 'Check failed', range: 'courier history could not be read (service down, sign-ins failing, no lookups left) and no history of our own' },
  ]
  return (
    <SettingCard setting={s} title="Delivery success check at checkout" validate={validate}
      description="When a customer types their phone number at checkout, we look up how many of their past parcels were actually received (your own orders plus Pathao, Steadfast, RedX and CarryBee through BD Courier and the courier sign-ins) and apply the action you choose for their level before the order is placed. An order that needs an advance stays at Advance required until the payment is verified. Customers only ever see what they need to do — never their rate.">
      <SwitchSetting s={s} path={['receive_rate', 'enabled']} label="Decide cash on delivery or advance from the delivery success rate"
        hint="Off: only your fraud rules below decide. On: the level decides first, rules can still ask for more." />
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberSetting s={s} path={['receive_rate', 'good_min']} label="Good from (%)" min={1} max={100} />
        <NumberSetting s={s} path={['receive_rate', 'mid_min']} label="Medium from (%)" min={1} max={99} />
        <NumberSetting s={s} path={['receive_rate', 'min_parcels']} label="Min. parcels to judge" min={1} />
      </div>
      <div className="divide-y rounded-xl border">
        {tiers.map((t) => (
          <div key={t.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
            <span className={`size-2.5 rounded-full ${t.dot}`} />
            <div className="min-w-40 flex-1">
              <p className="text-sm font-medium">{t.label}</p>
              <p className="text-xs text-muted-foreground">{t.range}</p>
            </div>
            <Select value={String(rr('actions') && (rr('actions') as Record<string, string>)[t.key] || (['MID', 'LOW', 'ERROR'].includes(t.key) ? 'ADVANCE' : 'COD'))}
              onValueChange={(v) => s.set(['receive_rate', 'actions', t.key], v)}>
              <SelectTrigger className="w-48"><SelectValue /></SelectTrigger>
              <SelectContent>{TIER_ACTIONS.map((a) => <SelectItem key={a.value} value={a.value}>{a.label}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectSetting s={s} path={['receive_rate', 'advance_type']} label="Advance amount" options={[
          { value: 'FIXED', label: 'Fixed amount' },
          { value: 'DELIVERY_CHARGE', label: "The order's delivery charge" },
          { value: 'DELIVERY_PLUS_RETURN', label: 'Delivery + return charge' },
          { value: 'PERCENTAGE', label: 'A percentage of the order' },
          { value: 'FULL', label: 'The full order (no cash on delivery)' },
        ]} />
        {(rr('advance_type') ?? 'FIXED') === 'FIXED' && (
          <NumberSetting s={s} path={['receive_rate', 'advance_amount']} label="Fixed advance (৳)" min={1} />
        )}
        {rr('advance_type') === 'PERCENTAGE' && (
          <NumberSetting s={s} path={['receive_rate', 'advance_amount']} label="Advance (% of the order)" min={1} max={100} />
        )}
      </div>
      <TextareaSetting s={s} path={['receive_rate', 'message']} label="Message shown at checkout" rows={2} hint="{amount} is replaced with the advance, e.g. ৳55" />
    </SettingCard>
  )
}

function FraudGeneral() {
  const s = useSettingDraft('fraud')
  const providers = (s.get(['providers']) as string[] | undefined) ?? []
  const toggleProvider = (name: string, on: boolean) => s.set(['providers'], on ? [...new Set([...providers, name])] : providers.filter((p) => p !== name))
  // BD Courier and the courier sign-ins run as one source, on unless the store switched it off.
  const courierRecord = s.get(['courier_record']) !== false
  const setCourierRecord = (on: boolean) => {
    s.set(['courier_record'], on)
    s.set(['providers'], on
      ? [...new Set([...providers.filter((p) => p !== 'courier_panel'), 'courier_history'])]
      : providers.filter((p) => p !== 'courier_history' && p !== 'courier_panel'))
  }
  const t = (k: string) => Number(s.get(['thresholds', k]))
  const validate = () => {
    if (!(0 <= t('medium') && t('medium') < t('high') && t('high') < t('critical') && t('critical') <= 100)) return 'Thresholds must satisfy 0 ≤ medium < high < critical ≤ 100'
    if (!providers.length) return 'Choose at least one provider'
    return null
  }
  return (
    <SettingCard setting={s} title="Fraud detection" validate={validate}
      description="Every storefront order is scored before it is accepted. Scores and provider data are only ever shown to staff.">
      <SwitchSetting s={s} path={['enabled']} label="Run fraud checks on new orders" />
      <div className="grid gap-2">
        <p className="text-sm font-medium">Providers</p>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={providers.includes('internal')} onCheckedChange={(v) => toggleProvider('internal', v === true)} className="mt-0.5" />
          <span>Store history<span className="block text-xs text-muted-foreground">This store's own delivered / cancelled / returned orders for the phone number</span></span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={courierRecord} onCheckedChange={(v) => setCourierRecord(v === true)} className="mt-0.5" />
          <span>
            Courier record (Pathao, Steadfast, RedX, CarryBee)
            <span className="block text-xs text-muted-foreground">BD Courier and the couriers' own panels, asked together and merged per courier — counts as one check</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox checked={providers.includes('http')} onCheckedChange={(v) => toggleProvider('http', v === true)} className="mt-0.5" />
          <span>
            Other courier-history API (advanced)
            <span className="block text-xs text-muted-foreground">
              A courier-ratio / fraud-check API. URL and key are Edge Function secrets (<code>FRAUD_API_URL</code> with a <code>{'{phone}'}</code> placeholder, <code>FRAUD_API_KEY</code>) — never stored in the database.
            </span>
          </span>
        </label>
      </div>
      {providers.includes('http') && (
        <div className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
          <SelectSetting s={s} path={['http', 'method']} label="Request method" options={[{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }]} />
          <NumberSetting s={s} path={['http', 'timeout_ms']} label="Timeout (ms)" min={1000} step={500} nullable />
          <p className="text-xs text-muted-foreground sm:col-span-2">Where each value is in the API's JSON response (dot paths, e.g. <code>summary.total_parcel</code>):</p>
          {['total', 'delivered', 'cancelled', 'returned', 'failed', 'success_ratio', 'risk_score'].map((k) => (
            <TextSetting key={k} s={s} path={['http', 'mapping', k]} label={k.replace('_', ' ')} mono nullable />
          ))}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-3">
        <NumberSetting s={s} path={['thresholds', 'medium']} label="Medium risk from score" min={0} max={100} />
        <NumberSetting s={s} path={['thresholds', 'high']} label="High risk from score" min={0} max={100} />
        <NumberSetting s={s} path={['thresholds', 'critical']} label="Critical risk from score" min={0} max={100} />
        <NumberSetting s={s} path={['new_customer_score']} label="Score for unknown numbers" min={0} max={100} hint="Used when there is no history at all" />
        <NumberSetting s={s} path={['cache_minutes']} label="Reuse a check for (minutes)" min={0} />
        <SelectSetting s={s} path={['on_provider_error']} label="If courier history can't be read" hint="Used when the delivery success check is off (when it is on, its “Check failed” action decides)"
          options={[{ value: 'REVIEW', label: 'Send to manual review' }, { value: 'ADVANCE', label: 'Ask for the default advance' }, { value: 'ALLOW', label: 'Continue with available data' }]} />
        <SelectSetting s={s} path={['block_mode']} label="When a rule blocks an order" options={[{ value: 'REJECT', label: 'Reject automatically' }, { value: 'REVIEW', label: 'Hold for review' }]} />
        <SelectSetting s={s} path={['default_advance', 'type']} label="Default advance (when a rule doesn't set one)" options={ADVANCE_OPTIONS.filter((o) => o.value !== 'NONE')} />
        {['FIXED', 'PERCENTAGE'].includes(String(s.get(['default_advance', 'type']))) && (
          <NumberSetting s={s} path={['default_advance', 'value']} label={s.get(['default_advance', 'type']) === 'PERCENTAGE' ? 'Default advance %' : 'Default advance amount'} min={0} />
        )}
      </div>
      <div className="grid gap-4">
        <p className="text-sm font-medium">Messages customers see <span className="font-normal text-muted-foreground">— no scores or provider details are ever shown</span></p>
        <TextareaSetting s={s} path={['messages', 'advance']} label="Advance required" rows={2} hint="{amount} is replaced with the advance" />
        <TextareaSetting s={s} path={['messages', 'review']} label="Under review" rows={2} />
        <TextareaSetting s={s} path={['messages', 'blocked']} label="Not accepted" rows={2} />
      </div>
    </SettingCard>
  )
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------
type FieldKind = 'number' | 'boolean' | 'enum' | 'text'
const FACTS: Array<{ key: string; label: string; kind: FieldKind; options?: string[]; unit?: string }> = [
  { key: 'risk_level', label: 'Risk level', kind: 'enum', options: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
  { key: 'risk_score', label: 'Risk score', kind: 'number', unit: '0–100' },
  { key: 'courier_score', label: 'Courier success score', kind: 'number', unit: '%' },
  { key: 'cancellation_rate', label: 'Cancellation rate', kind: 'number', unit: '%' },
  { key: 'return_rate', label: 'Return rate', kind: 'number', unit: '%' },
  { key: 'failed_delivery_rate', label: 'Failed delivery rate', kind: 'number', unit: '%' },
  { key: 'previous_orders', label: 'Previous orders', kind: 'number' },
  { key: 'delivered_orders', label: 'Delivered orders', kind: 'number' },
  { key: 'cancelled_orders', label: 'Cancelled orders', kind: 'number' },
  { key: 'failed_delivery_orders', label: 'Failed deliveries', kind: 'number' },
  { key: 'failed_cod_orders', label: 'Failed COD orders', kind: 'number' },
  { key: 'rejected_fraud_orders', label: 'Orders rejected for fraud', kind: 'number' },
  { key: 'open_orders', label: 'Open orders', kind: 'number' },
  { key: 'lifetime_value', label: 'Lifetime value', kind: 'number' },
  { key: 'order_value', label: 'Order value', kind: 'number' },
  { key: 'item_count', label: 'Items in order', kind: 'number' },
  { key: 'is_new_customer', label: 'Is a new customer', kind: 'boolean' },
  { key: 'phone_flagged', label: 'Phone is blocked', kind: 'boolean' },
  { key: 'district', label: 'District', kind: 'text' },
  { key: 'area', label: 'Area', kind: 'text' },
  { key: 'payment_method', label: 'Payment method', kind: 'enum', options: ['COD', 'ADVANCE', 'FULL_PAYMENT'] },
  { key: 'source', label: 'Order source', kind: 'enum', options: ['STOREFRONT', 'ADMIN', 'IMPORT', 'API'] },
  { key: 'customer_segment', label: 'Customer segment', kind: 'enum', options: ['NEW', 'REGULAR', 'VIP', 'HIGH_RISK', 'BLOCKED'] },
]
const OPS: Record<FieldKind, Array<{ value: string; label: string }>> = {
  number: [{ value: 'gte', label: '≥' }, { value: 'gt', label: '>' }, { value: 'lte', label: '≤' }, { value: 'lt', label: '<' }, { value: 'eq', label: '=' }, { value: 'neq', label: '≠' }],
  boolean: [{ value: 'is_true', label: 'is yes' }, { value: 'is_false', label: 'is no' }],
  enum: [{ value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }, { value: 'in', label: 'is one of' }, { value: 'not_in', label: 'is none of' }],
  text: [{ value: 'in', label: 'is one of' }, { value: 'not_in', label: 'is none of' }, { value: 'eq', label: 'is' }, { value: 'neq', label: 'is not' }],
}

interface Condition { field: string; op: string; value?: unknown }
interface Action { decision: Enums<'fraud_decision'>; advance_type: Enums<'advance_type'>; advance_value: number; customer_message: string; stop_processing: boolean }

const factOf = (key: string) => FACTS.find((f) => f.key === key)
const opLabel = (c: Condition) => {
  const kind = factOf(c.field)?.kind ?? 'text'
  return OPS[kind].find((o) => o.value === c.op)?.label ?? c.op
}
function describeCondition(c: Condition) {
  const fact = factOf(c.field)
  const value = Array.isArray(c.value) ? c.value.join(', ') : c.value === undefined ? '' : String(c.value)
  return `${fact?.label ?? c.field} ${opLabel(c)}${value ? ` ${value}${fact?.unit === '%' ? '%' : ''}` : ''}`
}

function FraudRules() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const rules = useQuery({ queryKey: ['fraud-rules'], queryFn: listFraudRules })
  const [editing, setEditing] = useState<Partial<FraudRule> | null>(null)
  const canEdit = can('fraud.rules')
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['fraud-rules'] })
  const toggle = useMutation({ mutationFn: ({ id, active }: { id: string; active: boolean }) => toggleFraudRule(id, active), onSuccess: refresh })
  const remove = useMutation({ mutationFn: deleteFraudRule, onSuccess: () => { toast.success('Rule deleted'); refresh() } })
  const move = useMutation({
    // Swap priorities with the neighbour (nudging past it when they are equal).
    mutationFn: async ({ rule, neighbour, up }: { rule: FraudRule; neighbour: FraudRule; up: boolean }) => {
      const mine = rule.priority === neighbour.priority ? neighbour.priority + (up ? -1 : 1) : neighbour.priority
      await saveFraudRule(toPayload(rule, { priority: mine }))
      if (rule.priority !== neighbour.priority) await saveFraudRule(toPayload(neighbour, { priority: rule.priority }))
    },
    onSuccess: refresh,
  })
  const list = rules.data ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Rules</CardTitle>
        <CardDescription>
          Every active rule is checked against each order. When several match, the most severe decision wins (block → review → advance → allow) and the
          largest advance applies. A rule marked “stop” ends evaluation.
        </CardDescription>
        {canEdit && <CardAction><Button size="sm" onClick={() => setEditing({ match_mode: 'ALL', is_active: true, priority: (list.at(-1)?.priority ?? 0) + 10 })}><Plus /> Add rule</Button></CardAction>}
      </CardHeader>
      <CardContent>
        {rules.isLoading ? <LoadingState /> : !list.length ? <EmptyState title="No rules" description="Without rules every order is allowed." /> : (
          <ol className="divide-y">
            {list.map((r, i) => (
              <li key={r.id} className="flex flex-wrap items-start gap-3 py-3 text-sm">
                <span className="w-8 pt-0.5 text-xs text-muted-foreground tabular-nums">{r.priority}</span>
                <div className="min-w-0 flex-1">
                  <p className={r.is_active ? 'font-medium' : 'font-medium text-muted-foreground line-through'}>{r.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {(r.conditions as unknown as Condition[]).length === 0 ? 'Always' : (r.conditions as unknown as Condition[]).map(describeCondition).join(r.match_mode === 'ANY' ? ' or ' : ' and ')}
                  </p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {r.fraud_rule_actions.map((a) => (
                      <span key={a.id} className="flex items-center gap-1">
                        <StatusBadge value={a.decision} map={FRAUD_DECISION} />
                        {a.advance_type !== 'NONE' && <Badge variant="outline">{ADVANCE_TYPE[a.advance_type]}{['FIXED', 'PERCENTAGE'].includes(a.advance_type) ? ` ${a.advance_value}${a.advance_type === 'PERCENTAGE' ? '%' : ''}` : ''}</Badge>}
                        {a.stop_processing && <Badge variant="neutral">stop</Badge>}
                      </span>
                    ))}
                  </div>
                </div>
                {canEdit && (
                  <div className="flex items-center gap-1">
                    <Switch checked={r.is_active} onCheckedChange={(v) => toggle.mutate({ id: r.id, active: v })} aria-label={r.is_active ? 'Disable rule' : 'Enable rule'} />
                    <Button size="icon-sm" variant="ghost" aria-label="Move up" disabled={i === 0 || move.isPending} onClick={() => move.mutate({ rule: r, neighbour: list[i - 1], up: true })}><ArrowUp /></Button>
                    <Button size="icon-sm" variant="ghost" aria-label="Move down" disabled={i === list.length - 1 || move.isPending} onClick={() => move.mutate({ rule: r, neighbour: list[i + 1], up: false })}><ArrowDown /></Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Edit ${r.name}`} onClick={() => setEditing(r)}><Pencil /></Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Delete ${r.name}`} onClick={() => confirm(`Delete rule "${r.name}"?`) && remove.mutate(r.id)}><Trash2 /></Button>
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
      </CardContent>
      <RuleDialog value={editing} onClose={() => setEditing(null)} onSaved={refresh} />
    </Card>
  )
}

function toPayload(r: Partial<FraudRule>, patch: Record<string, unknown> = {}) {
  return {
    id: r.id, name: r.name, description: r.description, priority: r.priority, match_mode: r.match_mode, is_active: r.is_active,
    conditions: r.conditions,
    actions: (r.fraud_rule_actions ?? []).map((a) => ({
      decision: a.decision, advance_type: a.advance_type, advance_value: a.advance_value, customer_message: a.customer_message, stop_processing: a.stop_processing,
    })),
    ...patch,
  }
}

const emptyAction: Action = { decision: 'REVIEW', advance_type: 'NONE', advance_value: 0, customer_message: '', stop_processing: false }

function RuleDialog({ value, onClose, onSaved }: { value: Partial<FraudRule> | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('100')
  const [matchMode, setMatchMode] = useState('ALL')
  const [conditions, setConditions] = useState<Condition[]>([])
  const [action, setAction] = useState<Action>(emptyAction)
  useEffect(() => {
    if (!value) return
    setName(value.name ?? '')
    setDescription(value.description ?? '')
    setPriority(String(value.priority ?? 100))
    setMatchMode(value.match_mode ?? 'ALL')
    setConditions(((value.conditions as unknown as Condition[] | undefined) ?? []).map((c) => ({ ...c })))
    const a = value.fraud_rule_actions?.[0]
    setAction(a ? { decision: a.decision, advance_type: a.advance_type, advance_value: Number(a.advance_value), customer_message: a.customer_message ?? '', stop_processing: a.stop_processing } : emptyAction)
  }, [value])

  const setCondition = (i: number, patch: Partial<Condition>) => setConditions((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))
  const incomplete = conditions.some((c) => {
    const kind = factOf(c.field)?.kind
    if (kind === 'boolean') return false
    if (c.op === 'in' || c.op === 'not_in') return !Array.isArray(c.value) || c.value.length === 0
    return c.value === undefined || c.value === ''
  })
  const save = useMutation({
    mutationFn: () => saveFraudRule({
      id: value?.id, name: name.trim(), description: description.trim() || null, priority: Number(priority) || 100, match_mode: matchMode,
      is_active: value?.is_active ?? true, conditions,
      actions: [{ ...action, advance_type: action.decision === 'ALLOW' || action.decision === 'BLOCK' ? 'NONE' : action.advance_type, customer_message: action.customer_message.trim() || null }],
    }),
    onSuccess: () => { toast.success('Rule saved'); onClose(); onSaved() },
  })

  return (
    <FormDialog open={value !== null} onOpenChange={(o) => !o && onClose()} title={value?.id ? 'Edit rule' : 'New fraud rule'} submitLabel="Save rule" wide
      busy={save.isPending} disabled={!name.trim() || incomplete} onSubmit={() => save.mutate()}>
      <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
        <Field label="Name" htmlFor="r-name" required><Input id="r-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Priority" htmlFor="r-prio" hint="Lower runs first"><Input id="r-prio" type="number" value={priority} onChange={(e) => setPriority(e.target.value)} /></Field>
      </div>
      <Field label="Description" htmlFor="r-desc"><Input id="r-desc" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>

      <div className="grid gap-2 rounded-lg border p-3">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="font-medium">When</span>
          <Select value={matchMode} onValueChange={setMatchMode}>
            <SelectTrigger size="sm" className="w-24"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="ALL">all</SelectItem><SelectItem value="ANY">any</SelectItem></SelectContent>
          </Select>
          <span>of these match{conditions.length === 0 && ' (no conditions = every order)'}</span>
        </div>
        {conditions.map((c, i) => {
          const fact = factOf(c.field)
          const kind = fact?.kind ?? 'text'
          const multi = c.op === 'in' || c.op === 'not_in'
          return (
            <div key={i} className="grid grid-cols-[1fr_7rem_1fr_auto] items-center gap-2">
              <Select value={c.field} onValueChange={(f) => {
                const k = factOf(f)?.kind ?? 'text'
                setCondition(i, { field: f, op: OPS[k][0].value, value: undefined })
              }}>
                <SelectTrigger size="sm" aria-label="Field"><SelectValue /></SelectTrigger>
                <SelectContent>{FACTS.map((f) => <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>)}</SelectContent>
              </Select>
              <Select value={c.op} onValueChange={(op) => setCondition(i, { op, value: (op === 'in' || op === 'not_in') !== multi ? undefined : c.value })}>
                <SelectTrigger size="sm" aria-label="Operator"><SelectValue /></SelectTrigger>
                <SelectContent>{OPS[kind].map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
              </Select>
              {kind === 'boolean' ? <span /> : kind === 'number' ? (
                <Input className="h-8" type="number" aria-label="Value" placeholder={fact?.unit} value={c.value === undefined ? '' : String(c.value)}
                  onChange={(e) => setCondition(i, { value: e.target.value === '' ? undefined : Number(e.target.value) })} />
              ) : kind === 'enum' && !multi ? (
                <Select value={String(c.value ?? '')} onValueChange={(v) => setCondition(i, { value: v })}>
                  <SelectTrigger size="sm" aria-label="Value"><SelectValue placeholder="Choose" /></SelectTrigger>
                  <SelectContent>{fact?.options?.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
                </Select>
              ) : (
                <Input key={`${c.field}-${multi}`} className="h-8" aria-label="Value" placeholder={multi ? 'Comma separated' : ''}
                  defaultValue={Array.isArray(c.value) ? c.value.join(', ') : String(c.value ?? '')}
                  onChange={(e) => setCondition(i, { value: multi ? e.target.value.split(',').map((x) => x.trim()).filter(Boolean) : e.target.value })} />
              )}
              <Button type="button" size="icon-sm" variant="ghost" aria-label="Remove condition" onClick={() => setConditions((cs) => cs.filter((_, j) => j !== i))}><Trash2 /></Button>
            </div>
          )
        })}
        <Button type="button" size="sm" variant="outline" className="w-fit" onClick={() => setConditions((cs) => [...cs, { field: 'risk_level', op: 'eq', value: 'HIGH' }])}><Plus /> Add condition</Button>
      </div>

      <div className="grid gap-4 rounded-lg border p-3 sm:grid-cols-2">
        <Field label="Then">
          <Select value={action.decision} onValueChange={(v) => setAction((a) => ({ ...a, decision: v as Action['decision'] }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(FRAUD_DECISION).map(([k, m]) => <SelectItem key={k} value={k}>{m.label}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        {(action.decision === 'ADVANCE_REQUIRED' || action.decision === 'REVIEW') && (
          <Field label={action.decision === 'REVIEW' ? 'Suggested advance' : 'Advance'}>
            <Select value={action.advance_type} onValueChange={(v) => setAction((a) => ({ ...a, advance_type: v as Action['advance_type'] }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{ADVANCE_OPTIONS.map((o) => <SelectItem key={o.value} value={o.value}>{o.value === 'NONE' && action.decision === 'ADVANCE_REQUIRED' ? 'Store default' : o.label}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
        )}
        {['FIXED', 'PERCENTAGE'].includes(action.advance_type) && action.decision !== 'ALLOW' && action.decision !== 'BLOCK' && (
          <Field label={action.advance_type === 'PERCENTAGE' ? 'Percentage' : 'Amount'} htmlFor="r-adv">
            <Input id="r-adv" type="number" min="0" value={action.advance_value} onChange={(e) => setAction((a) => ({ ...a, advance_value: Number(e.target.value) || 0 }))} />
          </Field>
        )}
        <Field label="Message to the customer" htmlFor="r-msg" className="sm:col-span-2" hint="Optional; replaces the default message for this decision">
          <Textarea id="r-msg" rows={2} value={action.customer_message} onChange={(e) => setAction((a) => ({ ...a, customer_message: e.target.value }))} />
        </Field>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <Switch checked={action.stop_processing} onCheckedChange={(v) => setAction((a) => ({ ...a, stop_processing: v }))} /> Stop checking further rules when this one matches
        </label>
      </div>
    </FormDialog>
  )
}
