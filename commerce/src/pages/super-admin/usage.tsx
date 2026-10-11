import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Download, Info, Plus } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { SearchInput } from '@/components/common/search-input'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, EmptyState, ErrorState, TableSkeleton } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Kind } from '@/features/platform/kind-badge'
import { usePlatform } from '@/features/platform/platform-context'
import { UsageReportPanel } from '@/features/platform/services/usage-report'
import { useUrlState } from '@/hooks/use-url-state'
import { downloadCsv } from '@/lib/csv'
import { recordExport } from '@/services/platform-data'
import { rangeFor } from '@/lib/dates'
import { formatDate, formatMoney, formatNumber } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  addCostEntry, businessReport, COST_CATEGORIES, type CostCategory, costEntries, type HealthBand, type HealthNeed, merchantHealth, saveCostAssumptions,
  usageOverview, type UsageOverviewRow,
} from '@/services/analytics'

const tooltipStyle = { contentStyle: { background: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }, cursor: { fill: 'var(--muted)', opacity: 0.4 } }
const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—')
const left = (v: number | null | undefined, unmetered?: boolean) => (unmetered ? 'unmetered' : v == null ? '—' : formatNumber(v))

function UsageTab() {
  const { can } = usePlatform()
  const initial = rangeFor('30d')
  const [state, update] = useUrlState({ from: initial.from, to: initial.to, detail: 'merchants', q: '' })
  const q = useQuery({ queryKey: ['platform-usage-overview', state.from, state.to], placeholderData: keepPreviousData, queryFn: () => usageOverview(state.from, state.to) })
  const t = q.data?.totals
  const rows = (q.data?.merchants ?? []).filter((m) => !state.q || m.name.toLowerCase().includes(state.q.toLowerCase()) || String(m.number) === state.q.replace('#', ''))
  const exportCsv = async () => {
    if (!q.data) return
    await recordExport('USAGE', { rows: q.data.merchants.length, from: state.from, to: state.to })
    downloadCsv<UsageOverviewRow>(`usage-${state.from}-${state.to}.csv`, q.data.merchants, [
    { header: 'Merchant', value: (m) => `#${m.number} ${m.name}` },
    { header: 'SMS attempted', value: (m) => m.sms_attempted }, { header: 'SMS sent', value: (m) => m.sms_sent },
    { header: 'SMS delivered', value: (m) => m.sms_delivered }, { header: 'SMS failed or undelivered', value: (m) => m.sms_failed },
    { header: 'SMS refused by policy', value: (m) => m.sms_refused }, { header: 'SMS billable parts', value: (m) => m.sms_billable },
    { header: 'SMS free parts', value: (m) => m.sms_free }, { header: 'SMS credits used', value: (m) => m.sms_credits },
    { header: 'SMS credits left', value: (m) => m.sms_state?.credits ?? '' }, { header: 'SMS free left', value: (m) => m.sms_state?.free_remaining ?? '' },
    { header: 'BD Courier attempted', value: (m) => m.bd_attempted }, { header: 'BD Courier succeeded', value: (m) => m.bd_succeeded },
    { header: 'BD Courier failed', value: (m) => m.bd_failed }, { header: 'BD Courier refused by policy', value: (m) => m.bd_refused },
    { header: 'BD Courier billable', value: (m) => m.bd_billable }, { header: 'BD Courier credits used', value: (m) => m.bd_credits },
    { header: 'BD Courier free left', value: (m) => m.bd_state?.free_remaining ?? '' }, { header: 'BD Courier this month / cap', value: (m) => `${m.bd_state?.month_used ?? ''} / ${m.bd_state?.monthly_cap ?? 'none'}` },
    ])
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DateRangeFilter value={{ from: state.from, to: state.to }} onChange={(r) => update({ from: r.from, to: r.to })} />
        <div className="flex gap-1 rounded-lg border p-1 text-xs">
          {[['merchants', 'All services by merchant'], ['sms', 'SMS detail'], ['bd', 'BD Courier detail']].map(([k, l]) => (
            <button key={k} type="button" onClick={() => update({ detail: k })} className={cn('rounded-md px-2.5 py-1', state.detail === k ? 'bg-muted font-medium' : 'text-muted-foreground')}>{l}</button>
          ))}
        </div>
      </div>
      {state.detail === 'sms' ? <UsageReportPanel service="SMS" /> : state.detail === 'bd' ? <UsageReportPanel service="BD_COURIER" /> : (
        q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data || !t ? <CardsSkeleton count={8} /> : (
          <>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <StatCard label="SMS sent" value={formatNumber(t.sms_sent)} hint={`${formatNumber(t.sms_attempted)} attempted · ${formatNumber(t.sms_refused)} refused by policy`} />
              <StatCard label="SMS delivered" value={pct(t.sms_delivered, t.sms_sent)} hint={`${formatNumber(t.sms_delivered)} confirmed · ${formatNumber(t.sms_failed)} failed or undelivered`}
                tone={t.sms_failed > 0 ? 'warning' : 'default'} />
              <StatCard label="SMS billable parts" value={formatNumber(t.sms_billable)} hint={`${formatNumber(t.sms_free)} free · ${formatNumber(t.sms_credits)} credits used`} />
              <StatCard label="SMS credits left" value={formatNumber(t.sms_credits_outstanding)} hint="All merchants' balances" />
              <StatCard label="BD Courier lookups" value={formatNumber(t.bd_succeeded)} hint={`${formatNumber(t.bd_attempted)} attempted · ${formatNumber(t.bd_refused)} refused by policy`} />
              <StatCard label="BD Courier failed" value={formatNumber(t.bd_failed)} hint={`${pct(t.bd_failed, t.bd_attempted)} of attempts · refunded`} tone={t.bd_failed > 0 ? 'warning' : 'default'} />
              <StatCard label="BD Courier billable" value={formatNumber(t.bd_billable)} hint={`${formatNumber(t.bd_credits)} credits used`} />
              <StatCard label="Courier credits left" value={formatNumber(t.courier_credits_outstanding)} hint="All merchants' balances" />
            </div>
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-sm">Platform-wide trend <Kind kind="actual" /></CardTitle></CardHeader>
              <CardContent className="h-56">
                {q.data.daily.length === 0 ? <EmptyState title="No usage in this range" /> : (
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={q.data.daily} margin={{ left: -20, right: 4 }}>
                      <CartesianGrid vertical={false} strokeOpacity={0.1} />
                      <XAxis dataKey="day" tickFormatter={(d) => formatDate(d)} fontSize={11} tickLine={false} axisLine={false} minTickGap={24} />
                      <YAxis fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip {...tooltipStyle} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Bar dataKey="sms" name="SMS sent" stackId="s" fill="#a1a1aa" />
                      <Bar dataKey="sms_failed" name="SMS failed" stackId="s" fill="#ef4444" />
                      <Bar dataKey="bd" name="BD lookups" stackId="b" fill="#52525b" />
                      <Bar dataKey="bd_failed" name="BD failed" stackId="b" fill="#f59e0b" radius={[3, 3, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
            <Card className="gap-0 overflow-hidden py-0">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b px-3 py-2">
                <SearchInput value={state.q} onChange={(v) => update({ q: v })} placeholder="Merchant name or #" />
                {can('usage', 'export') && <Button size="sm" variant="outline" onClick={exportCsv}><Download /> Export CSV</Button>}
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Merchant</TableHead>
                      <TableHead className="text-right">SMS sent</TableHead><TableHead className="text-right">Delivered</TableHead><TableHead className="text-right">Billable</TableHead>
                      <TableHead className="text-right">Credits left</TableHead><TableHead className="text-right">Free left</TableHead>
                      <TableHead className="text-right">Lookups</TableHead><TableHead className="text-right">Failed</TableHead><TableHead className="text-right">This month / cap</TableHead>
                      <TableHead className="text-right">Courier credits</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="text-sm"><Link className="hover:underline" to={`/super-admin/merchants/${m.id}?tab=credits`}>#{m.number} {m.name}</Link>{m.is_demo && <Badge variant="violet" className="ml-1">demo</Badge>}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(m.sms_sent)}{m.sms_refused > 0 && <span className="block text-[11px] text-amber-500">{m.sms_refused} refused</span>}</TableCell>
                        <TableCell className="text-right tabular-nums">{pct(m.sms_delivered, m.sms_sent)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(m.sms_billable)}</TableCell>
                        <TableCell className="text-right tabular-nums">{left(m.sms_state?.credits, m.sms_state?.unmetered)}</TableCell>
                        <TableCell className="text-right tabular-nums">{left(m.sms_state?.free_remaining)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(m.bd_succeeded)}{m.bd_refused > 0 && <span className="block text-[11px] text-amber-500">{m.bd_refused} refused</span>}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(m.bd_failed)}</TableCell>
                        <TableCell className="text-right tabular-nums">{m.bd_state ? `${formatNumber(m.bd_state.month_used)} / ${m.bd_state.monthly_cap ?? '∞'}` : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{left(m.bd_state?.credits, m.bd_state?.unmetered)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <p className="border-t px-3 py-2 text-xs text-muted-foreground">
                Attempted = allowed and sent to the provider. Refused = stopped by policy before any provider call (no credits, cap reached, feature off). Billable = paid in credits or by the plan; failed ones are refunded. Free and cap figures are as of now.
              </p>
            </Card>
          </>
        )
      )}
    </div>
  )
}

function CostDialog({ onClose }: { onClose: () => void }) {
  const queryClient = useQueryClient()
  const [form, setForm] = useState({ month: new Date().toISOString().slice(0, 7), category: 'INFRASTRUCTURE' as CostCategory, amount: '', note: '' })
  const add = useMutation({
    meta: { silent: true },
    mutationFn: () => addCostEntry({ month: `${form.month}-01`, category: form.category, amount: Number(form.amount), note: form.note.trim() }),
    onSuccess: () => { toast.success('Cost recorded'); void queryClient.invalidateQueries({ queryKey: ['platform-business'] }); void queryClient.invalidateQueries({ queryKey: ['platform-costs'] }); onClose() },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Record a cost" submitLabel="Record" busy={add.isPending}
      disabled={!form.amount || Number(form.amount) <= 0 || form.note.trim().length < 3} onSubmit={() => add.mutate()}
      description="From a bill the company paid. Entries cannot be edited; to fix one, record a correction from the list.">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Month"><Input type="month" value={form.month} onChange={(e) => setForm((f) => ({ ...f, month: e.target.value }))} /></Field>
        <Field label="Kind">
          <Select value={form.category} onValueChange={(v) => setForm((f) => ({ ...f, category: v as CostCategory }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{(Object.keys(COST_CATEGORIES) as CostCategory[]).map((c) => <SelectItem key={c} value={c}>{COST_CATEGORIES[c]}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Amount (BDT)" required><Input type="number" min={0} step="0.01" value={form.amount} onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} /></Field>
        <Field label="What it is" required><Input value={form.note} maxLength={300} placeholder="e.g. Supabase Pro, October" onChange={(e) => setForm((f) => ({ ...f, note: e.target.value }))} /></Field>
      </div>
      {add.error && <p className="mt-2 text-sm text-red-500" role="alert">{add.error.message}</p>}
    </FormDialog>
  )
}

function AssumptionsCard() {
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['platform-costs'], queryFn: () => costEntries() })
  const [lookup, setLookup] = useState<string | null>(null)
  const [fee, setFee] = useState<string | null>(null)
  const [correcting, setCorrecting] = useState<number | null>(null)
  const save = useMutation({
    mutationFn: () => saveCostAssumptions({
      bd_courier_per_lookup: (lookup ?? String(q.data?.assumptions.bd_courier_per_lookup ?? '')) === '' ? null : Number(lookup ?? q.data?.assumptions.bd_courier_per_lookup),
      payment_fee_percent: (fee ?? String(q.data?.assumptions.payment_fee_percent ?? '')) === '' ? null : Number(fee ?? q.data?.assumptions.payment_fee_percent),
    }, 'Cost assumptions'),
    onSuccess: () => { toast.success('Saved'); setLookup(null); setFee(null); void queryClient.invalidateQueries({ queryKey: ['platform-business'] }); void q.refetch() },
  })
  const correct = useMutation({
    mutationFn: (e: { id: number; amount: number; category: CostCategory; month: string }) =>
      addCostEntry({ month: e.month, category: e.category, amount: -e.amount, note: `Correction of entry ${e.id}`, corrects: e.id }),
    onSuccess: () => { toast.success('Correction recorded'); setCorrecting(null); void q.refetch(); void queryClient.invalidateQueries({ queryKey: ['platform-business'] }) },
  })
  if (!q.data) return null
  const a = q.data.assumptions
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle className="text-sm">Cost assumptions</CardTitle><CardDescription>Used only where no real cost was recorded; every use is listed with the figures.</CardDescription></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p className="text-xs text-muted-foreground">SMS cost per part: {a.sms_per_part == null ? 'not set' : `${a.sms_per_part} BDT`} — set in SMS Management.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="BD Courier cost per lookup (BDT)" hint="Empty = unknown">
              <Input type="number" min={0} step="0.01" disabled={!q.data.can_manage} value={lookup ?? String(a.bd_courier_per_lookup ?? '')} onChange={(e) => setLookup(e.target.value)} />
            </Field>
            <Field label="Payment gateway fee (%)" hint="Empty = unknown">
              <Input type="number" min={0} max={20} step="0.01" disabled={!q.data.can_manage} value={fee ?? String(a.payment_fee_percent ?? '')} onChange={(e) => setFee(e.target.value)} />
            </Field>
          </div>
          {q.data.can_manage && <Button size="sm" disabled={save.isPending || (lookup === null && fee === null)} onClick={() => save.mutate()}>Save</Button>}
        </CardContent>
      </Card>
      <Card className="gap-0 py-0">
        <CardHeader className="border-b py-3"><CardTitle className="text-sm">Recorded costs</CardTitle></CardHeader>
        <div className="max-h-72 overflow-y-auto">
          {q.data.entries.length === 0 ? <p className="p-4 text-sm text-muted-foreground">No costs recorded yet. Record hosting, provider and other bills to see a real margin.</p> : (
            <Table>
              <TableBody>
                {q.data.entries.map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="text-xs whitespace-nowrap">{e.month.slice(0, 7)}</TableCell>
                    <TableCell className="text-xs">{COST_CATEGORIES[e.category]}<p className="text-muted-foreground">{e.note}</p></TableCell>
                    <TableCell className={cn('text-right text-xs tabular-nums', e.amount < 0 && 'text-red-500')}>{formatMoney(e.amount)}</TableCell>
                    <TableCell className="text-right">
                      {q.data.can_manage && e.amount > 0 && !q.data.entries.some((x) => x.corrects === e.id) && (
                        correcting === e.id
                          ? <Button size="sm" variant="destructive" className="h-7" disabled={correct.isPending} onClick={() => correct.mutate(e)}>Reverse it</Button>
                          : <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setCorrecting(e.id)}>Correct</Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>
    </div>
  )
}

function RevenueTab() {
  const { can } = usePlatform()
  const initial = rangeFor('month')
  const [state, update] = useUrlState({ from: initial.from, to: initial.to })
  const [recording, setRecording] = useState(false)
  const q = useQuery({ queryKey: ['platform-business', state.from, state.to], placeholderData: keepPreviousData, queryFn: () => businessReport(state.from, state.to) })
  const r = q.data
  if (!can('subscriptions')) return <EmptyState title="Revenue and costs need billing access" description="Ask a Super Admin for Subscriptions & Plans view access." />
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DateRangeFilter value={{ from: state.from, to: state.to }} onChange={(x) => update({ from: x.from, to: x.to })} />
        {can('subscriptions', 'manage') && <Button size="sm" variant="outline" onClick={() => setRecording(true)}><Plus /> Record a cost</Button>}
      </div>
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !r ? <CardsSkeleton count={8} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="MRR" value={formatMoney(r.mrr.mrr)} hint={<span className="flex items-center gap-1"><Kind kind="calculated" /> {r.mrr.paying} paying · ARR {formatMoney(r.mrr.arr)}</span>} />
            <StatCard label="Money received" value={formatMoney(r.revenue.total)} hint={<span className="flex items-center gap-1"><Kind kind="actual" /> {formatMoney(r.revenue.subscriptions)} plans · {formatMoney(r.revenue.credits)} credits</span>} />
            <StatCard label="Churn" value={r.subscriptions.churn_rate == null ? '—' : `${r.subscriptions.churn_rate}%`}
              hint={<span className="flex items-center gap-1"><Kind kind="calculated" /> {r.subscriptions.churned} of {r.subscriptions.paying_at_start} paying at start</span>} />
            <StatCard label="Overdue" value={formatMoney(r.payments.overdue_amount)} tone={r.payments.overdue_invoices ? 'warning' : 'default'}
              hint={`${r.payments.overdue_invoices} invoice(s) · ${r.payments.failed} failed payment(s) · ${r.payments.awaiting_verification} awaiting check`} />
            <StatCard label="New merchants" value={formatNumber(r.merchants.new)} hint={`${formatNumber(r.merchants.active)} took orders · ${formatNumber(r.merchants.total)} in total`} />
            <StatCard label="Renewals" value={formatNumber(r.subscriptions.renewals)} hint={`${r.subscriptions.cancelled} cancelled · ${r.subscriptions.expired} expired`} />
            <StatCard label="MRR at risk" value={formatMoney(r.mrr.at_risk)} tone={r.mrr.at_risk ? 'warning' : 'default'} hint="Past due or cancelling at period end" />
            <StatCard label="Refunds" value={formatMoney(r.revenue.refunds)} hint={r.revenue.refunds_note} />
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-sm">Contribution {r.margin.complete ? <Kind kind="calculated" /> : <Kind kind="estimate" />}</CardTitle>
              <CardDescription>Money received minus recorded costs and estimated costs for the same range. {r.margin.complete ? '' : 'Incomplete — see what is missing below.'}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 lg:grid-cols-[18rem_1fr]">
              <dl className="space-y-1.5 text-sm">
                <div className="flex justify-between"><dt>Money received</dt><dd className="tabular-nums">{formatMoney(r.margin.revenue)}</dd></div>
                <div className="flex justify-between"><dt>Recorded costs</dt><dd className="tabular-nums">−{formatMoney(r.margin.known_costs)}</dd></div>
                <div className="flex justify-between text-amber-600"><dt>Estimated costs</dt><dd className="tabular-nums">−{formatMoney(r.margin.estimated_costs)}</dd></div>
                <div className="flex justify-between border-t pt-1.5 font-semibold"><dt>Contribution</dt><dd className={cn('tabular-nums', r.margin.contribution < 0 && 'text-red-500')}>{formatMoney(r.margin.contribution)}</dd></div>
              </dl>
              <div className="space-y-2 text-xs">
                {r.margin.missing.length > 0 && (
                  <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-2">
                    <p className="mb-1 flex items-center gap-1 font-medium text-amber-600"><AlertTriangle className="size-3.5" /> Missing — not counted</p>
                    <ul className="list-disc space-y-0.5 pl-4">{r.margin.missing.map((m) => <li key={m}>{m}</li>)}</ul>
                  </div>
                )}
                <div className="rounded-md border p-2">
                  <p className="mb-1 flex items-center gap-1 font-medium"><Info className="size-3.5" /> Assumptions</p>
                  <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">{r.margin.assumptions.map((a) => <li key={a}>{a}</li>)}</ul>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-sm">SMS <Kind kind="actual" /></CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <div className="flex justify-between"><span>Credit sales</span><span className="tabular-nums">{formatMoney(r.sms.credit_sales)}</span></div>
                <div className="flex justify-between"><span>Parts sent</span><span className="tabular-nums">{formatNumber(r.sms.units)} ({formatNumber(r.sms.free_units)} free)</span></div>
                <div className="flex justify-between"><span>Provider cost reported</span><span className="tabular-nums">{formatMoney(r.sms.provider_cost_reported)}</span></div>
                <div className="flex justify-between text-amber-600"><span>Estimated for {formatNumber(r.sms.units_without_cost)} unreported parts</span>
                  <span className="tabular-nums">{r.sms.provider_cost_estimated == null ? 'unknown' : formatMoney(r.sms.provider_cost_estimated)}</span></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="flex items-center gap-2 text-sm">BD Courier <Kind kind="actual" /></CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <div className="flex justify-between"><span>Credit sales</span><span className="tabular-nums">{formatMoney(r.bd_courier.credit_sales)}</span></div>
                <div className="flex justify-between"><span>Lookups</span><span className="tabular-nums">{formatNumber(r.bd_courier.lookups)} ({formatNumber(r.bd_courier.free_lookups)} free)</span></div>
                <div className="flex justify-between"><span>Failed (refunded)</span><span className="tabular-nums">{formatNumber(r.bd_courier.failed)}</span></div>
                <div className="flex justify-between text-amber-600"><span>Estimated API cost</span><span className="tabular-nums">{r.bd_courier.cost_estimated == null ? 'unknown' : formatMoney(r.bd_courier.cost_estimated)}</span></div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">MRR by plan <Kind kind="calculated" /></CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                {r.mrr_by_plan.map((p) => (
                  <div key={p.code} className="flex justify-between"><span>{p.name} <span className="text-xs text-muted-foreground">{p.active} active{p.trialing ? ` · ${p.trialing} trial` : ''}</span></span><span className="tabular-nums">{formatMoney(p.mrr)}</span></div>
                ))}
                <p className="pt-1 text-xs text-muted-foreground">AI: {r.ai.note}.</p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-sm">Last 12 months <Kind kind="actual" /></CardTitle><CardDescription>Money received by kind, recorded costs, sign-ups and churned subscriptions.</CardDescription></CardHeader>
            <CardContent className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={r.monthly} margin={{ left: 0, right: 4 }}>
                  <CartesianGrid vertical={false} strokeOpacity={0.1} />
                  <XAxis dataKey="month" tickFormatter={(d) => String(d).slice(0, 7)} fontSize={11} tickLine={false} axisLine={false} />
                  <YAxis fontSize={11} tickLine={false} axisLine={false} />
                  <Tooltip {...tooltipStyle} formatter={(v) => formatMoney(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="subscriptions" name="Plans" stackId="r" fill="#a1a1aa" />
                  <Bar dataKey="credits" name="Credits & other" stackId="r" fill="#52525b" radius={[3, 3, 0, 0]} />
                  <Bar dataKey="costs" name="Recorded costs" fill="#ef4444" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          {r.by_merchant.length > 0 && (
            <Card className="gap-0 overflow-hidden py-0">
              <CardHeader className="border-b py-3"><CardTitle className="flex items-center gap-2 text-sm">By merchant <Kind kind="estimate" /></CardTitle>
                <CardDescription>Money received from each merchant against what their SMS and lookups cost (reported or estimated). Hosting and other shared costs are not split.</CardDescription></CardHeader>
              <Table>
                <TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead className="text-right">Received</TableHead><TableHead className="text-right">SMS cost</TableHead><TableHead className="text-right">BD Courier cost</TableHead><TableHead className="text-right">Contribution</TableHead></TableRow></TableHeader>
                <TableBody>
                  {r.by_merchant.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="text-sm">#{m.number} {m.name}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(m.revenue)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatMoney(m.sms_cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{m.bd_cost == null ? <span className="text-muted-foreground">{m.bd_lookups} × ?</span> : formatMoney(m.bd_cost)}</TableCell>
                      <TableCell className="text-right tabular-nums">{m.bd_cost == null && m.bd_lookups > 0 ? '—' : formatMoney(m.revenue - m.sms_cost - (m.bd_cost ?? 0))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
          <AssumptionsCard />
        </>
      )}
      {recording && <CostDialog onClose={() => setRecording(false)} />}
    </div>
  )
}

const BAND: Record<HealthBand, { label: string; variant: 'success' | 'warning' | 'danger' }> = {
  HEALTHY: { label: 'Healthy', variant: 'success' }, WATCH: { label: 'Watch', variant: 'warning' }, AT_RISK: { label: 'At risk (estimate)', variant: 'danger' },
}
const NEEDS: Record<HealthNeed, string> = { onboarding: 'Onboarding help', technical: 'Technical support', billing: 'Billing', activity: 'Activity dropped' }

function HealthTab() {
  const [state, update] = useUrlState({ need: '', band: '', q: '', demo: '' })
  const q = useQuery({
    queryKey: ['platform-health-merchants', state], placeholderData: keepPreviousData,
    queryFn: () => merchantHealth({ need: state.need, band: state.band, q: state.q, include_demo: state.demo === '1' }),
  })
  const s = q.data?.summary
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {(['onboarding', 'technical', 'billing', 'activity'] as HealthNeed[]).map((n) => (
          <button key={n} type="button" onClick={() => update({ need: state.need === n ? '' : n })} className="text-left">
            <StatCard label={NEEDS[n]} value={s ? formatNumber(s[n]) : '…'} className={cn(state.need === n && 'ring-2 ring-ring')} hint="merchants" />
          </button>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput value={state.q} onChange={(v) => update({ q: v })} placeholder="Merchant name or #" />
        <Select value={state.band || 'all'} onValueChange={(v) => update({ band: v === 'all' ? '' : v })}>
          <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Every indicator{s ? ` (${s.total})` : ''}</SelectItem>
            <SelectItem value="AT_RISK">At risk{s ? ` (${s.at_risk})` : ''}</SelectItem>
            <SelectItem value="WATCH">Watch{s ? ` (${s.watch})` : ''}</SelectItem>
            <SelectItem value="HEALTHY">Healthy{s ? ` (${s.healthy})` : ''}</SelectItem>
          </SelectContent>
        </Select>
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><Checkbox checked={state.demo === '1'} onCheckedChange={(v) => update({ demo: v === true ? '1' : '' })} /> Include demo merchants</label>
      </div>
      {q.data && <p className="flex items-start gap-1.5 text-xs text-muted-foreground"><Info className="mt-0.5 size-3.5 shrink-0" /> {q.data.method}</p>}
      <Card className="gap-0 overflow-hidden py-0">
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <TableSkeleton /> : q.data.rows.length === 0 ? <EmptyState title="No merchant matches" /> : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead>Indicator</TableHead><TableHead>Signals (points off 100)</TableHead><TableHead>Orders 14 days</TableHead><TableHead>Plan</TableHead></TableRow></TableHeader>
              <TableBody>
                {q.data.rows.map((m) => (
                  <TableRow key={m.id} className="align-top">
                    <TableCell className="text-sm">
                      <Link className="font-medium hover:underline" to={`/super-admin/merchants/${m.id}`}>#{m.number} {m.name}</Link>
                      <p className="text-xs text-muted-foreground">{m.status.toLowerCase()}{m.account_manager && ` · ${m.account_manager}`}{m.is_demo && ' · demo'}</p>
                    </TableCell>
                    <TableCell><Badge variant={BAND[m.band].variant}>{BAND[m.band].label}</Badge><p className="mt-1 text-xs tabular-nums text-muted-foreground">{m.score} / 100</p></TableCell>
                    <TableCell className="max-w-md">
                      {m.signals.length === 0 ? <span className="text-xs text-muted-foreground">Nothing found</span> : (
                        <ul className="space-y-0.5 text-xs">
                          {m.signals.map((x) => <li key={x.key}><span className="font-medium">{x.label}</span> <span className="text-muted-foreground">−{x.points} · {x.detail}</span></li>)}
                        </ul>
                      )}
                    </TableCell>
                    <TableCell className="text-xs tabular-nums">{m.facts.orders_14d}<span className="text-muted-foreground"> (before: {m.facts.orders_prior_14d})</span></TableCell>
                    <TableCell className="text-xs">{m.facts.subscription ? `${m.facts.subscription.plan} · ${m.facts.subscription.status.toLowerCase().replace('_', ' ')}` : 'none'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </div>
  )
}

export default function UsageAnalyticsPage() {
  const [state, update] = useUrlState({ tab: 'usage' })
  const { can } = usePlatform()
  return (
    <div className="space-y-4">
      <PageHeader title="Usage & Analytics" description="SMS and BD Courier use by merchant, revenue and costs with every estimate labelled, and which merchants may need help." />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList>
          <TabsTrigger value="usage">Usage</TabsTrigger>
          {can('subscriptions') && <TabsTrigger value="revenue">Revenue & costs</TabsTrigger>}
          {can('merchants') && <TabsTrigger value="health">Merchant health</TabsTrigger>}
        </TabsList>
        <TabsContent value="usage"><UsageTab /></TabsContent>
        <TabsContent value="revenue"><RevenueTab /></TabsContent>
        <TabsContent value="health"><HealthTab /></TabsContent>
      </Tabs>
    </div>
  )
}
