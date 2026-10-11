import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Archive, ArchiveRestore, Pencil, Plus } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { Pagination } from '@/components/common/pagination'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState, TableSkeleton } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { GatewaysCard } from '@/features/platform/billing/gateways-card'
import { InvoiceTable, PendingPayments } from '@/features/platform/billing/invoices'
import { AddonDialog, PlanDialog } from '@/features/platform/billing/plan-dialog'
import { usePlatform } from '@/features/platform/platform-context'
import { useUrlState } from '@/hooks/use-url-state'
import { formatMoney, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  type AccessMode, type Addon, LIMIT_KEYS, LIMIT_LABEL, listInvoices, listPlans, type Plan, platformSettings, savePlatformSetting, setPlanStatus,
} from '@/services/billing'

const PAGE_SIZE = 50

function Plans() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const data = useQuery({ queryKey: ['platform-plans'], queryFn: listPlans })
  const [editing, setEditing] = useState<Plan | 'new' | null>(null)
  const [archiving, setArchiving] = useState<Plan | null>(null)
  if (data.error) return <ErrorState error={data.error} onRetry={() => data.refetch()} />
  if (!data.data) return <LoadingState />
  const { plans, features } = data.data
  const mrr = plans.reduce((s, p) => s + Number(p.mrr ?? 0), 0)
  const paying = plans.filter((p) => p.price > 0).reduce((s, p) => s + (p.subscribers ?? 0), 0)
  const optional = features.filter((f) => !f.is_core)
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Monthly recurring revenue" value={formatMoney(mrr)} hint="Plan prices of active and past-due subscriptions (yearly ÷ 12). Billed, not necessarily collected." />
        <StatCard label="Merchants on a paid plan" value={formatNumber(paying)} />
        <StatCard label="Plans offered" value={formatNumber(plans.filter((p) => p.status === 'ACTIVE' && p.is_public).length)} />
        <StatCard label="Features you can sell" value={formatNumber(optional.length)} hint="Order handling, inventory, returns and fraud checks are in every plan" />
      </div>
      <div className="flex justify-end">
        {can('subscriptions', 'create') && <Button size="sm" onClick={() => setEditing('new')}><Plus /> New plan</Button>}
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {plans.map((p) => (
          <Card key={p.id} className={cn('gap-3 px-4 py-4', p.status === 'ARCHIVED' && 'opacity-60')}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-semibold">{p.name}</p>
                <p className="font-mono text-[11px] text-muted-foreground">{p.code}</p>
              </div>
              <div className="flex flex-wrap justify-end gap-1">
                {p.status === 'ARCHIVED' && <Badge variant="neutral">archived</Badge>}
                {!p.is_public && p.status === 'ACTIVE' && <Badge variant="violet">hidden</Badge>}
              </div>
            </div>
            <p className="text-2xl font-semibold tracking-tight">{formatMoney(p.price)}<span className="text-sm font-normal text-muted-foreground"> / {p.billing_interval === 'YEAR' ? 'year' : 'month'}</span></p>
            <p className="text-xs text-muted-foreground">{p.trial_days ? `${p.trial_days}-day free trial` : 'No trial'} · {p.subscribers ?? 0} merchant{p.subscribers === 1 ? '' : 's'}</p>
            <div className="space-y-1 text-xs">
              {LIMIT_KEYS.map((k) => (
                <div key={k} className="flex justify-between"><span className="text-muted-foreground">{LIMIT_LABEL[k]}</span><span>{p.limits[k] != null ? formatNumber(p.limits[k]) : 'No limit'}</span></div>
              ))}
              {p.overage.order_price != null && <div className="flex justify-between"><span className="text-muted-foreground">Each extra order</span><span>{formatMoney(p.overage.order_price)}</span></div>}
            </div>
            <div className="flex flex-wrap gap-1">
              {optional.map((f) => <Badge key={f.code} variant={p.features[f.code] ? 'success' : 'neutral'} className={cn(!p.features[f.code] && 'line-through opacity-60')}>{f.name}</Badge>)}
            </div>
            <div className="mt-auto flex gap-2 pt-1">
              {can('subscriptions', 'edit') && <Button size="sm" variant="outline" onClick={() => setEditing(p)}><Pencil /> Edit</Button>}
              {can('subscriptions', 'manage') && p.code !== 'FOUNDER' && (
                <Button size="sm" variant="ghost" onClick={() => setArchiving(p)}>{p.status === 'ACTIVE' ? <><Archive /> Archive</> : <><ArchiveRestore /> Restore</>}</Button>
              )}
            </div>
          </Card>
        ))}
      </div>
      {editing && <PlanDialog plan={editing === 'new' ? null : editing} features={features} open onOpenChange={(o) => !o && setEditing(null)} />}
      {archiving && (
        <ConfirmDialog open onOpenChange={(o) => !o && setArchiving(null)}
          title={archiving.status === 'ACTIVE' ? `Archive ${archiving.name}?` : `Restore ${archiving.name}?`}
          description={archiving.status === 'ACTIVE' ? `It is no longer offered. The ${archiving.subscribers ?? 0} merchant(s) on it keep it until you change their plan.` : 'It can be chosen again.'}
          confirmLabel={archiving.status === 'ACTIVE' ? 'Archive' : 'Restore'}
          onConfirm={async () => {
            try {
              await setPlanStatus(archiving.id, archiving.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE')
              void queryClient.invalidateQueries({ queryKey: ['platform-plans'] })
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }} />
      )}
    </div>
  )
}

function Addons() {
  const { can } = usePlatform()
  const data = useQuery({ queryKey: ['platform-plans'], queryFn: listPlans })
  const [editing, setEditing] = useState<Addon | 'new' | null>(null)
  if (data.error) return <ErrorState error={data.error} />
  if (!data.data) return <LoadingState />
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Extras on top of a plan, charged on each invoice while active (for example one more store or five more staff logins).</p>
        {can('subscriptions', 'edit') && <Button size="sm" onClick={() => setEditing('new')}><Plus /> New add-on</Button>}
      </div>
      {data.data.addons.length === 0 ? <EmptyState title="No add-ons yet" /> : (
        <Card className="gap-0 py-0">
          {data.data.addons.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 text-sm last:border-0">
              <span>
                <span className="font-medium">{a.name}</span> <span className="text-muted-foreground">· {formatMoney(a.price)} per period</span>
                <span className="block text-xs text-muted-foreground">Adds {Object.entries(a.grants).map(([k, v]) => `${v} ${LIMIT_LABEL[k as keyof typeof LIMIT_LABEL]?.toLowerCase() ?? k}`).join(', ') || 'nothing to the limits'}</span>
              </span>
              <span className="flex items-center gap-2">
                {a.status === 'ARCHIVED' && <Badge variant="neutral">archived</Badge>}
                {can('subscriptions', 'edit') && <Button size="sm" variant="outline" onClick={() => setEditing(a)}><Pencil /> Edit</Button>}
              </span>
            </div>
          ))}
        </Card>
      )}
      {editing && <AddonDialog addon={editing === 'new' ? null : editing} open onOpenChange={(o) => !o && setEditing(null)} />}
    </div>
  )
}

function Invoices() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'plans', status: 'OPEN', overdue: '', page: '1' })
  const page = Number(state.page) || 1
  const list = useQuery({
    queryKey: ['platform-invoices', state.status, state.overdue, page], placeholderData: keepPreviousData,
    queryFn: () => listInvoices({ status: state.status === 'ALL' ? undefined : state.status, overdue: state.overdue === '1' }, page, PAGE_SIZE),
  })
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['platform-invoices'] })
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Select value={state.status} onValueChange={(status) => update({ status, page: '1' })}>
          <SelectTrigger size="sm" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {['OPEN', 'PAID', 'VOID', 'ALL'].map((s) => <SelectItem key={s} value={s}>{s === 'ALL' ? 'All invoices' : s.toLowerCase()}</SelectItem>)}
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-sm"><Checkbox checked={state.overdue === '1'} onCheckedChange={(v) => update({ overdue: v === true ? '1' : '', page: '1' })} /> Overdue only</label>
        <p className="text-xs text-muted-foreground">Invoices are raised by the hourly billing run, once per period. Gateway payments mark them paid automatically; manual ones after verification.</p>
      </div>
      {list.data && <PendingPayments payments={list.data.pending_payments} onChanged={refresh} />}
      <Card className="gap-0 overflow-hidden py-0">
        {list.error ? <ErrorState error={list.error} onRetry={() => list.refetch()} /> : !list.data ? <TableSkeleton /> : list.data.items.length === 0 ? <EmptyState title="No invoices for these filters" /> : (
          <InvoiceTable invoices={list.data.items} showMerchant canManage={(i) => can('subscriptions', 'manage', i.merchant_id)} onChanged={refresh} />
        )}
        {list.data && <div className="border-t px-3 py-2"><Pagination page={page} pageSize={PAGE_SIZE} total={list.data.total} onPage={(p) => update({ page: String(p) })} /></div>}
      </Card>
    </div>
  )
}

const ACCESS_STATES: Array<{ key: string; label: string }> = [
  { key: 'TRIALING', label: 'On a free trial' },
  { key: 'ACTIVE', label: 'Paid up' },
  { key: 'PAST_DUE', label: 'Invoice unpaid, within the grace period' },
  { key: 'PAST_DUE_AFTER_GRACE', label: 'Invoice unpaid after the grace period' },
  { key: 'PAUSED', label: 'Subscription paused' },
  { key: 'CANCELLED', label: 'Subscription cancelled' },
  { key: 'EXPIRED', label: 'Subscription expired (unpaid)' },
  { key: 'NO_SUBSCRIPTION', label: 'Never had a subscription' },
  { key: 'MERCHANT_ONBOARDING', label: 'Merchant still onboarding' },
  { key: 'MERCHANT_SUSPENDED', label: 'Merchant suspended' },
]

function Rules() {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const settings = useQuery({ queryKey: ['platform-settings'], queryFn: platformSettings })
  const plans = useQuery({ queryKey: ['platform-plans'], queryFn: listPlans })
  const [billing, setBilling] = useState<Record<string, string> | null>(null)
  const [rules, setRules] = useState<Record<string, AccessMode> | null>(null)
  const [confirm, setConfirm] = useState<'billing' | 'rules' | null>(null)
  const save = useMutation({
    mutationFn: ({ key, value, reason }: { key: string; value: Record<string, unknown>; reason: string }) => savePlatformSetting(key, value, reason),
    onSuccess: () => { toast.success('Saved'); void queryClient.invalidateQueries({ queryKey: ['platform-settings'] }) },
  })
  if (settings.error) return <ErrorState error={settings.error} />
  if (!settings.data) return <LoadingState />
  const b = billing ?? Object.fromEntries(Object.entries(settings.data.billing?.value ?? {}).map(([k, v]) => [k, String(v)]))
  const r = rules ?? (settings.data.access_rules?.value ?? {}) as Record<string, AccessMode>
  const editable = can('settings', 'edit')
  const editRules = editable && can('subscriptions', 'manage')
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-sm">Billing</CardTitle></CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-2">
          <Field label="Invoice due after (days)"><Input type="number" min={0} disabled={!editable} value={b.invoice_due_days ?? ''} onChange={(e) => setBilling({ ...b, invoice_due_days: e.target.value })} /></Field>
          <Field label="Grace period (days)" hint="Unpaid but still on the trial/paid rules"><Input type="number" min={0} disabled={!editable} value={b.grace_days ?? ''} onChange={(e) => setBilling({ ...b, grace_days: e.target.value })} /></Field>
          <Field label="Expire unpaid after (days)" hint="From the invoice date; ends the subscription"><Input type="number" min={1} disabled={!editable} value={b.expire_after_days ?? ''} onChange={(e) => setBilling({ ...b, expire_after_days: e.target.value })} /></Field>
          <Field label="New merchants start on">
            <Select disabled={!editable} value={b.default_plan ?? ''} onValueChange={(v) => setBilling({ ...b, default_plan: v })}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>{(plans.data?.plans ?? []).filter((p) => p.status === 'ACTIVE').map((p) => <SelectItem key={p.code} value={p.code}>{p.name}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          {editable && <div className="sm:col-span-2"><Button size="sm" disabled={!billing} onClick={() => setConfirm('billing')}>Save billing settings</Button></div>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-sm">What each account state allows</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">Full: normal use. Read-only: staff can look and export but not change anything; customers can still order. Blocked: no admin access and no new orders. Applied by the database to every request.</p>
          {ACCESS_STATES.map((s) => (
            <div key={s.key} className="flex items-center justify-between gap-2 border-b py-1.5 text-sm last:border-0">
              <span>{s.label}</span>
              <Select disabled={!editRules} value={r[s.key] ?? 'FULL'} onValueChange={(v) => setRules({ ...r, [s.key]: v as AccessMode })}>
                <SelectTrigger size="sm" className="w-32"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="FULL">Full</SelectItem><SelectItem value="READ_ONLY">Read-only</SelectItem><SelectItem value="BLOCKED">Blocked</SelectItem></SelectContent>
              </Select>
            </div>
          ))}
          {editRules && <Button size="sm" disabled={!rules} onClick={() => setConfirm('rules')}>Save access rules</Button>}
        </CardContent>
      </Card>
      {can('subscriptions') && <GatewaysCard />}
      {confirm && (
        <ConfirmDialog open onOpenChange={(o) => !o && setConfirm(null)} reason reasonRequired
          title={confirm === 'rules' ? 'Change what account states allow?' : 'Save billing settings?'}
          description={confirm === 'rules' ? 'Takes effect immediately for every merchant in that state. The previous rules stay in the history and can be restored.' : 'Applies to invoices and subscriptions from the next billing run.'}
          confirmLabel="Save"
          onConfirm={async (reason) => {
            try {
              if (confirm === 'rules') {
                await save.mutateAsync({ key: 'access_rules', value: r, reason })
                setRules(null)
              } else {
                await save.mutateAsync({ key: 'billing', value: { ...settings.data.billing?.value, ...Object.fromEntries(Object.entries(b).map(([k, v]) => [k, /^\d+$/.test(v) ? Number(v) : v])) }, reason })
                setBilling(null)
              }
            } catch (e) {
              toast.error((e as Error).message)
              throw e
            }
          }} />
      )}
    </div>
  )
}

export default function SubscriptionsPage() {
  const { can } = usePlatform()
  const [state, update] = useUrlState({ tab: 'plans' })
  return (
    <div className="space-y-4">
      <PageHeader title="Subscriptions & Plans" description="Plans, add-ons, invoices and payments. Payments count only when a gateway confirms them or a second person verifies them." />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList>
          <TabsTrigger value="plans">Plans</TabsTrigger>
          <TabsTrigger value="addons">Add-ons</TabsTrigger>
          <TabsTrigger value="invoices">Invoices & payments</TabsTrigger>
          {can('settings') && <TabsTrigger value="rules">Billing rules</TabsTrigger>}
        </TabsList>
        <TabsContent value="plans"><Plans /></TabsContent>
        <TabsContent value="addons"><Addons /></TabsContent>
        <TabsContent value="invoices"><Invoices /></TabsContent>
        {can('settings') && <TabsContent value="rules"><Rules /></TabsContent>}
      </Tabs>
    </div>
  )
}
