import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BarChart3, CheckCircle2, CircleAlert, Headset, PackageCheck, PhoneCall, PhoneMissed, Plus, Power, Settings2, ShieldCheck, Trash2, Users, Wallet,
} from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router'
import { toast } from '@/lib/toast'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePhone } from '@/features/voicedrive/phone-context'
import { SuperAdminTab } from '@/features/voicedrive/super-admin-tab'
import { rangeFor, type DateRange } from '@/lib/dates'
import { formatDateTime, formatNumber, formatShortDate, timeAgo } from '@/lib/format'
import {
  batch, CALL_STATUS, durationLabel, LINE_PROBLEM, OUTCOMES, pbx, REJECT_REASON,
  type Agent, type CallRecord, type Overview, type Package, type PackageList, type RingGroup,
} from '@/services/voicedrive'

const tk = (n: number | null | undefined, d = 2) => `${formatNumber(Number(n ?? 0), d)} tk`
const TABS = ['package', 'agents', 'groups', 'setup', 'missed', 'reports', 'admin'] as const
type Tab = (typeof TABS)[number]

export default function VoiceDrivePbxPage() {
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()
  const tab = (TABS as readonly string[]).includes(params.get('tab') ?? '') ? (params.get('tab') as Tab) : 'package'
  const setTab = (t: string) => setParams((p) => { p.set('tab', t); p.delete('payment'); p.delete('type'); return p }, { replace: true })

  // Page load: the reads every tab needs, in one request.
  const page = useQuery({
    queryKey: ['vd-page'],
    queryFn: () => batch({ overview: {}, packages: {}, getInboundPhoneEligibility: {}, getMyBrowserPhoneRegistration: {}, maintenanceStatus: {} }),
  })

  // Back from bKash.
  const payment = params.get('payment')
  useEffect(() => {
    if (!payment) return
    if (payment === 'success') toast.success(params.get('type') === 'TOPUP' ? 'Recharge added to your outgoing balance' : 'Package activated')
    else if (payment === 'cancelled') toast.info('Payment cancelled on bKash')
    else if (payment === 'review') toast.warning('bKash has not confirmed the payment yet — it will update here automatically')
    else toast.error('The bKash payment did not go through')
    void queryClient.invalidateQueries({ queryKey: ['vd-page'] })
    void queryClient.invalidateQueries({ queryKey: ['vd-billing'] })
  }, [payment, params, queryClient])

  if (page.isLoading) return <LoadingState />
  if (page.error) return <ErrorState error={page.error} onRetry={() => page.refetch()} />
  const ov = page.data?.overview.result
  if (!ov) return <ErrorState error={new Error(page.data?.overview.error?.message ?? 'VoiceDrive is not available')} onRetry={() => page.refetch()} />
  const packages = page.data?.packages.result

  return (
    <div className="space-y-4">
      <PageHeader title="VoiceDrive PBX" description="Browser phone for your team. Outgoing calls use a prepaid balance; incoming calls are free." />
      <StatusStrip ov={ov} />
      {ov.maintenance.state !== 'none' && (
        <p className="flex items-start gap-2 rounded-lg border border-amber-300/60 bg-amber-50/60 px-3 py-2 text-sm dark:bg-amber-950/20">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
          <span>{ov.maintenance.state === 'active' ? 'Under maintenance — calls are paused' : 'Maintenance is scheduled'}
            {ov.maintenance.startsAt ? ` from ${formatDateTime(ov.maintenance.startsAt)}` : ''}{ov.maintenance.until ? ` until ${formatDateTime(ov.maintenance.until)}` : ''}.
            {ov.maintenance.message ? ` ${ov.maintenance.message}` : ''}</span>
        </p>
      )}
      {ov.lineStatus !== 'ACTIVE' && <SetupSteps ov={ov} />}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="package"><Wallet /> Package &amp; Recharge</TabsTrigger>
          {ov.canManage && <TabsTrigger value="agents"><Users /> Call Agents</TabsTrigger>}
          {ov.canManage && <TabsTrigger value="groups"><Settings2 /> Call Groups</TabsTrigger>}
          <TabsTrigger value="setup"><Headset /> My Setup</TabsTrigger>
          <TabsTrigger value="missed"><PhoneMissed /> Missed &amp; Callback</TabsTrigger>
          {ov.canManage && <TabsTrigger value="reports"><BarChart3 /> Reports</TabsTrigger>}
          {ov.isSuperAdmin && <TabsTrigger value="admin"><ShieldCheck /> Super Admin</TabsTrigger>}
        </TabsList>
        <TabsContent value="package" className="mt-4">{packages && <PackageTab ov={ov} list={packages} />}</TabsContent>
        {ov.canManage && <TabsContent value="agents" className="mt-4"><AgentsTab ov={ov} /></TabsContent>}
        {ov.canManage && <TabsContent value="groups" className="mt-4"><GroupsTab ov={ov} /></TabsContent>}
        <TabsContent value="setup" className="mt-4"><SetupTab ov={ov} /></TabsContent>
        <TabsContent value="missed" className="mt-4"><MissedTab /></TabsContent>
        {ov.canManage && <TabsContent value="reports" className="mt-4"><ReportsTab /></TabsContent>}
        {ov.isSuperAdmin && <TabsContent value="admin" className="mt-4"><SuperAdminTab /></TabsContent>}
      </Tabs>
    </div>
  )
}

/** Line, balance, seats and channels in one quiet row. */
function StatusStrip({ ov }: { ov: Overview }) {
  const active = ov.lineStatus === 'ACTIVE'
  const items: Array<{ label: string; value: React.ReactNode; hint?: string }> = [
    { label: 'Line', value: <span className="flex items-center gap-1.5"><span className={`size-2 rounded-full ${active ? 'bg-emerald-500' : 'bg-amber-500'}`} />{active ? 'Active' : 'Not active'}</span>,
      hint: ov.business.did ?? ov.business.name },
    { label: 'Balance', value: tk(ov.balanceTk), hint: 'Outgoing calls' },
    { label: 'Agents', value: `${ov.agentsUsed} / ${ov.limits.agents}`, hint: 'Active / paid seats' },
    { label: 'Calls at once', value: `${ov.channelsInUse} / ${ov.limits.channels}`,
      hint: ov.limits.active ? `${ov.limits.packageName} · until ${formatShortDate(ov.limits.expiresAt)}` : 'No package' },
  ]
  return (
    <div className="grid grid-cols-2 divide-border rounded-xl border bg-card sm:grid-cols-4 sm:divide-x">
      {items.map((i) => (
        <div key={i.label} className="min-w-0 px-4 py-3">
          <p className="text-xs text-muted-foreground">{i.label}</p>
          <p className="text-lg font-semibold tabular-nums">{i.value}</p>
          {i.hint && <p className="truncate text-xs text-muted-foreground">{i.hint}</p>}
        </div>
      ))}
    </div>
  )
}

/** Shown only until the line works: what is still missing, in order. */
function SetupSteps({ ov }: { ov: Overview }) {
  const steps = [
    { done: ov.business.pbxEnabled && ov.business.bridgeReady && !!ov.business.did, title: 'Number connected', who: 'Super Admin' },
    { done: ov.limits.active, title: 'Package active', who: 'Manager' },
    { done: !!ov.me?.seated, title: 'You have an extension', who: 'Manager' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border px-4 py-3 text-sm">
      <span className="font-medium">Before calling:</span>
      {steps.map((s, i) => (
        <span key={s.title} className={`flex items-center gap-1.5 ${s.done ? 'text-muted-foreground line-through' : ''}`} title={`Done by the ${s.who}`}>
          {s.done ? <CheckCircle2 className="size-4 text-emerald-600" /> : <span className="flex size-4 items-center justify-center rounded-full border text-[10px]">{i + 1}</span>}
          {s.title}
        </span>
      ))}
      {ov.lineProblems.length > 0 && <span className="w-full text-xs text-muted-foreground">{ov.lineProblems.map((p) => LINE_PROBLEM[p]).join(' · ')}</span>}
    </div>
  )
}

// ------------------------------------------------------------------ Package & Recharge
function PackageTab({ ov, list }: { ov: Overview; list: PackageList }) {
  const [buy, setBuy] = useState<Package | null>(null)
  const [months, setMonths] = useState(1)
  const [extraAgents, setExtraAgents] = useState(0)
  const [extraChannels, setExtraChannels] = useState(0)
  const [amount, setAmount] = useState('500')
  const [history, setHistory] = useState<'balance' | 'payments'>('balance')
  const billing = useQuery({ queryKey: ['vd-billing'], queryFn: () => pbx.billingHistory(), enabled: ov.canManage })
  const pay = useMutation({
    mutationFn: pbx.bkashStart,
    onSuccess: (r) => { toast.info('Opening bKash…'); window.location.assign(r.redirectUrl) },
    onError: (e) => toast.error((e as Error).message),
  })
  const price = buy?.monthlyPriceTk ? (buy.monthlyPriceTk + extraAgents * list.extraAgentTk + extraChannels * list.extraChannelTk) * months : 0
  const amountNum = Number(amount)

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[1.3fr_1fr] [&>*]:min-w-0">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Packages</CardTitle>
          <CardDescription>Agents and calls at once, per month. Extra agent +{list.extraAgentTk} tk, extra channel +{list.extraChannelTk} tk.</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          <Table>
            <TableHeader><TableRow><TableHead className="pl-6">Package</TableHead><TableHead className="text-right">Price / month</TableHead><TableHead className="text-right">Calls at once</TableHead><TableHead className="text-right">Agents</TableHead><TableHead className="pr-6" /></TableRow></TableHeader>
            <TableBody>
              {list.packages.map((p) => {
                const current = ov.limits.packageCode === p.code
                return (
                  <TableRow key={p.id} className={current ? 'bg-emerald-500/5' : undefined}>
                    <TableCell className="pl-6 font-medium">{p.name}{current && <Badge variant="success" className="ml-2">Current</Badge>}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.isCustom ? 'Custom' : `${formatNumber(p.monthlyPriceTk ?? 0)} tk`}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.concurrentChannels ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{p.agentLimit ?? '—'}</TableCell>
                    <TableCell className="pr-6 text-right">
                      {p.isCustom
                        ? <span className="text-xs text-muted-foreground">Ask us</span>
                        : <Button size="sm" variant={current ? 'outline' : 'ghost'} disabled={!ov.canManage} onClick={() => { setBuy(p); setMonths(1); setExtraAgents(0); setExtraChannels(0) }}>
                            {current ? 'Renew' : 'Buy'}
                          </Button>}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Recharge</CardTitle>
          <CardDescription>
            Outgoing only: {list.effectivePerMinTk.toFixed(2)} tk/min incl. {list.vatPercent}% VAT, charged by the second. Minimum {list.minTopupTk} tk.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground"><span className="font-semibold text-foreground">{tk(ov.balanceTk)}</span> ≈ {formatNumber(Math.floor(ov.balanceTk / list.effectivePerMinTk))} min</p>
          <div className="flex flex-wrap items-center gap-2">
            {[100, 500, 1000].map((v) => <Button key={v} size="sm" variant={amountNum === v ? 'default' : 'outline'} onClick={() => setAmount(String(v))}>{v}</Button>)}
            <Input aria-label="Amount (tk)" className="h-8 w-24" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
            <Button size="sm" disabled={!ov.canManage || pay.isPending || !(amountNum >= list.minTopupTk && amountNum <= list.maxTopupTk)}
              onClick={() => pay.mutate({ type: 'TOPUP', amount_tk: amountNum })}>
              {pay.isPending ? <Spinner /> : <Wallet />} Pay with bKash
            </Button>
          </div>
          {!ov.canManage && <p className="text-xs text-muted-foreground">Only a manager of this business can recharge.</p>}
        </CardContent>
      </Card>

      {ov.canManage && (
        <Card className="xl:col-span-2">
          <CardHeader className="flex-row items-center justify-between gap-2 space-y-0 pb-2">
            <CardTitle className="text-base">History</CardTitle>
            <div className="flex rounded-md border p-0.5 text-xs">
              {(['balance', 'payments'] as const).map((h) => (
                <button key={h} type="button" onClick={() => setHistory(h)} className={`rounded px-2 py-1 ${history === h ? 'bg-muted font-medium' : 'text-muted-foreground'}`}>
                  {h === 'balance' ? 'Balance' : 'Payments'}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            {billing.isLoading ? <LoadingState /> : billing.error ? <ErrorState error={billing.error} /> : history === 'payments' ? (
              !billing.data?.payments.length ? <EmptyState title="No payments yet" /> : (
                <Table>
                  <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>For</TableHead><TableHead className="text-right">Amount</TableHead><TableHead>Status</TableHead><TableHead>bKash TrxID</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {billing.data.payments.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(p.createdAt)}</TableCell>
                        <TableCell>{p.type === 'TOPUP' ? 'Recharge' : p.package}</TableCell>
                        <TableCell className="text-right tabular-nums">{tk(p.amountTk, 0)}</TableCell>
                        <TableCell><Badge variant={p.status === 'COMPLETED' ? 'success' : p.status === 'INITIATED' ? 'info' : 'danger'} title={p.failureReason ?? undefined}>{p.status.toLowerCase()}</Badge></TableCell>
                        <TableCell className="font-mono text-xs">{p.trxId ?? '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )
            ) : !billing.data?.ledger.length ? <EmptyState title="No balance changes yet" description="Recharges and charged calls appear here. Corrections are added as adjustments; nothing is deleted." /> : (
              <Table>
                <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>What</TableHead><TableHead className="text-right">Amount</TableHead><TableHead className="text-right">Balance after</TableHead></TableRow></TableHeader>
                <TableBody>
                  {billing.data.ledger.map((l) => (
                    <TableRow key={l.id}>
                      <TableCell className="whitespace-nowrap">{formatDateTime(l.createdAt)}</TableCell>
                      <TableCell>{l.kind === 'TOPUP' ? 'Recharge' : l.kind === 'CALL_CHARGE' ? 'Call' : 'Adjustment'} <span className="text-xs text-muted-foreground">{l.note}</span></TableCell>
                      <TableCell className={`text-right tabular-nums ${l.amountTk < 0 ? 'text-red-600' : 'text-emerald-700'}`}>{l.amountTk > 0 ? '+' : ''}{formatNumber(l.amountTk, 4)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(l.balanceAfterTk, 2)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      <FormDialog open={!!buy} onOpenChange={(o) => !o && setBuy(null)} title={`Buy ${buy?.name ?? ''}`} submitLabel={`Pay ${formatNumber(price)} tk with bKash`}
        busy={pay.isPending} disabled={!buy || price <= 0}
        description="You'll pay on bKash and come back here. The package starts when bKash confirms the payment."
        onSubmit={() => buy && pay.mutate({ type: 'PACKAGE', package_id: buy.id, months, extra_agents: extraAgents, extra_channels: extraChannels })}>
        {buy && (
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Months" htmlFor="vd-months">
              <Select value={String(months)} onValueChange={(v) => setMonths(Number(v))}>
                <SelectTrigger id="vd-months"><SelectValue /></SelectTrigger>
                <SelectContent>{[1, 2, 3, 6, 12].map((m) => <SelectItem key={m} value={String(m)}>{m}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label={`Extra agents (+${list.extraAgentTk} tk/mo)`} htmlFor="vd-xa"><Input id="vd-xa" type="number" min={0} max={500} value={extraAgents} onChange={(e) => setExtraAgents(Math.max(0, Number(e.target.value) || 0))} /></Field>
            <Field label={`Extra channels (+${list.extraChannelTk} tk/mo)`} htmlFor="vd-xc"><Input id="vd-xc" type="number" min={0} max={200} value={extraChannels} onChange={(e) => setExtraChannels(Math.max(0, Number(e.target.value) || 0))} /></Field>
            <p className="text-sm sm:col-span-3">
              {(buy.agentLimit ?? 0) + extraAgents} agents · {(buy.concurrentChannels ?? 0) + extraChannels} calls at once · {months} month{months > 1 ? 's' : ''}
              {ov.limits.active && ov.limits.packageCode !== buy.code ? ' · replaces your current package from today' : ov.limits.active ? ' · added after your current period' : ''}
            </p>
          </div>
        )}
      </FormDialog>
    </div>
  )
}

// ------------------------------------------------------------------ Call Agents
function AgentsTab({ ov }: { ov: Overview }) {
  const queryClient = useQueryClient()
  const agents = useQuery({ queryKey: ['vd-agents'], queryFn: () => pbx.listAgents(), refetchInterval: 15_000 })
  const groups = useQuery({ queryKey: ['vd-groups'], queryFn: () => pbx.listRingGroups() })
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<{ profile_id: string; extension: string; ring_group_id: string }>({ profile_id: '', extension: '', ring_group_id: '' })
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['vd-agents'] }); void queryClient.invalidateQueries({ queryKey: ['vd-page'] }) }
  const save = useMutation({
    mutationFn: pbx.saveAgent,
    onSuccess: () => { toast.success('Saved'); setAdding(false); refresh() },
    onError: (e) => toast.error((e as Error).message),
  })
  const remove = useMutation({ mutationFn: pbx.removeAgent, onSuccess: () => { toast.success('Agent removed'); refresh() }, onError: (e) => toast.error((e as Error).message) })
  if (agents.isLoading) return <LoadingState />
  if (agents.error) return <ErrorState error={agents.error} onRetry={() => agents.refetch()} />
  const data = agents.data!
  const groupName = (id: string | null) => groups.data?.find((g) => g.id === id)?.name ?? groups.data?.find((g) => g.isDefault)?.name ?? 'Default'

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="text-base">Call agents</CardTitle>
          <CardDescription>{data.agents.filter((a) => a.active).length} of {data.seats} paid seats used. Each agent gets an extension; their phone signs in with a fresh password every time.</CardDescription>
        </div>
        <Button size="sm" onClick={() => { setForm({ profile_id: '', extension: '', ring_group_id: '' }); setAdding(true) }} disabled={!data.staff.length}><Plus /> Add agent</Button>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {!data.agents.length ? <EmptyState icon={<Users />} title="No agents yet" description="Add the staff who will make and take calls." /> : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Agent</TableHead><TableHead>Extension</TableHead><TableHead>Call group</TableHead><TableHead>Now</TableHead>
              <TableHead>Takes incoming</TableHead><TableHead>Active</TableHead><TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {data.agents.map((a) => (
                <TableRow key={a.id}>
                  <TableCell><p className="font-medium">{a.name}</p><p className="text-xs text-muted-foreground">{a.email}</p></TableCell>
                  <TableCell><span className="font-mono">{a.extension}</span><p className="text-[11px] text-muted-foreground">{a.sipUsername}</p></TableCell>
                  <TableCell>
                    <Select value={a.ringGroupId ?? 'default'} onValueChange={(v) => save.mutate({ id: a.id, ring_group_id: v === 'default' ? null : v })}>
                      <SelectTrigger className="h-8 w-40"><SelectValue>{groupName(a.ringGroupId)}</SelectValue></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="default">Default group</SelectItem>
                        {groups.data?.filter((g) => !g.isDefault).map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell><AgentPresence a={a} /></TableCell>
                  <TableCell><Switch checked={a.inboundEnabled} onCheckedChange={(v) => save.mutate({ id: a.id, inbound_enabled: v })} aria-label="Takes incoming calls" /></TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Switch checked={a.active} onCheckedChange={(v) => save.mutate({ id: a.id, active: v })} aria-label="Active" />
                      {a.active && !a.seated && <Badge variant="warning" title="More active agents than paid seats">No seat</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button size="icon" variant="ghost" aria-label={`Remove ${a.name}`} onClick={() => remove.mutate(a.id)}><Trash2 /></Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
      <FormDialog open={adding} onOpenChange={setAdding} title="Add a call agent" submitLabel="Add agent" busy={save.isPending} disabled={!form.profile_id}
        onSubmit={() => save.mutate({ profile_id: form.profile_id, extension: form.extension || undefined, ring_group_id: form.ring_group_id || null })}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Staff member" htmlFor="vd-staff" className="sm:col-span-2">
            <Select value={form.profile_id} onValueChange={(v) => setForm({ ...form, profile_id: v })}>
              <SelectTrigger id="vd-staff"><SelectValue placeholder="Choose…" /></SelectTrigger>
              <SelectContent>{data.staff.map((s) => <SelectItem key={s.profileId} value={s.profileId}>{s.name} · {s.email}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Extension" htmlFor="vd-ext" hint="2–5 digits; leave empty for the next free one">
            <Input id="vd-ext" inputMode="numeric" value={form.extension} onChange={(e) => setForm({ ...form, extension: e.target.value.replace(/\D/g, '').slice(0, 5) })} placeholder="101" />
          </Field>
          <Field label="Call group" htmlFor="vd-grp">
            <Select value={form.ring_group_id || 'default'} onValueChange={(v) => setForm({ ...form, ring_group_id: v === 'default' ? '' : v })}>
              <SelectTrigger id="vd-grp"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Default group</SelectItem>
                {groups.data?.filter((g) => !g.isDefault).map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
          {ov.agentsUsed >= ov.limits.agents && <p className="text-xs text-amber-700 sm:col-span-2">All paid seats are used — the new agent is added switched off. Add a seat under Package &amp; Recharge.</p>}
        </div>
      </FormDialog>
    </Card>
  )
}

function AgentPresence({ a }: { a: Agent }) {
  if (a.onCall) return <Badge variant="info">On a call</Badge>
  if (!a.online) return <span className="text-xs text-muted-foreground">Offline{a.lastSeenAt ? ` · ${timeAgo(a.lastSeenAt)}` : ''}</span>
  return <Badge variant={a.status === 'AVAILABLE' ? 'success' : 'warning'}>{a.status === 'AVAILABLE' ? 'Available' : 'Away'}</Badge>
}

// ------------------------------------------------------------------ Call groups
function GroupsTab({ ov }: { ov: Overview }) {
  const queryClient = useQueryClient()
  const groups = useQuery({ queryKey: ['vd-groups'], queryFn: () => pbx.listRingGroups() })
  const [edit, setEdit] = useState<Partial<RingGroup> | null>(null)
  const [maxMinutes, setMaxMinutes] = useState(ov.business.maxCallMinutes)
  const save = useMutation({
    mutationFn: () => pbx.saveRingGroup({ id: edit?.id, name: edit?.name, strategy: edit?.strategy, ring_seconds: edit?.ringSeconds, active: edit?.active }),
    onSuccess: () => { toast.success('Call group saved'); setEdit(null); void queryClient.invalidateQueries({ queryKey: ['vd-groups'] }) },
    onError: (e) => toast.error((e as Error).message),
  })
  const saveLimit = useMutation({
    mutationFn: () => pbx.setBusinessSettings({ max_call_minutes: maxMinutes }),
    onSuccess: () => { toast.success('Saved'); void queryClient.invalidateQueries({ queryKey: ['vd-page'] }) },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <div className="grid gap-4 xl:grid-cols-3">
      <Card className="xl:col-span-2">
        <CardHeader className="flex flex-row items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">Call groups</CardTitle>
            <CardDescription>Incoming calls ring the default group's available agents. Agents can belong to another group.</CardDescription>
          </div>
          <Button size="sm" onClick={() => setEdit({ name: '', strategy: 'RING_ALL', ringSeconds: 30, active: true })}><Plus /> New group</Button>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {groups.isLoading ? <LoadingState /> : groups.error ? <ErrorState error={groups.error} /> : (
            <Table>
              <TableHeader><TableRow><TableHead>Group</TableHead><TableHead>How it rings</TableHead><TableHead>Ring time</TableHead><TableHead>Agents</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {groups.data!.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium">{g.name} {g.isDefault && <Badge variant="neutral">Default</Badge>} {!g.active && <Badge variant="warning">Off</Badge>}</TableCell>
                    <TableCell>{g.strategy === 'RING_ALL' ? 'Ring everyone at once' : 'Longest idle first, one by one'}</TableCell>
                    <TableCell>{g.ringSeconds}s</TableCell>
                    <TableCell>{g.agents}</TableCell>
                    <TableCell className="text-right"><Button size="sm" variant="ghost" onClick={() => setEdit(g)}>Edit</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Longest call</CardTitle><CardDescription>Outgoing and incoming calls are cut after this. 1–120 minutes.</CardDescription></CardHeader>
        <CardContent className="flex items-end gap-2">
          <Field label="Minutes" htmlFor="vd-max" className="w-28"><Input id="vd-max" type="number" min={1} max={120} value={maxMinutes} onChange={(e) => setMaxMinutes(Number(e.target.value) || 1)} /></Field>
          <Button disabled={saveLimit.isPending || maxMinutes === ov.business.maxCallMinutes || maxMinutes < 1 || maxMinutes > 120} onClick={() => saveLimit.mutate()}>Save</Button>
        </CardContent>
      </Card>
      <FormDialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)} title={edit?.id ? 'Edit call group' : 'New call group'} submitLabel="Save"
        busy={save.isPending} disabled={!edit?.name?.trim()} onSubmit={() => save.mutate()}>
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" htmlFor="vd-gname" className="sm:col-span-2"><Input id="vd-gname" value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={60} /></Field>
            <Field label="How it rings" htmlFor="vd-gstrat">
              <Select value={edit.strategy} onValueChange={(v) => setEdit({ ...edit, strategy: v as RingGroup['strategy'] })}>
                <SelectTrigger id="vd-gstrat"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="RING_ALL">Ring everyone</SelectItem><SelectItem value="LONGEST_IDLE">Longest idle first</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="Ring time (seconds)" htmlFor="vd-gsec"><Input id="vd-gsec" type="number" min={10} max={120} value={edit.ringSeconds ?? 30} onChange={(e) => setEdit({ ...edit, ringSeconds: Number(e.target.value) || 30 })} /></Field>
            {edit.id && !edit.isDefault && (
              <label className="flex items-center gap-2 text-sm"><Switch checked={edit.active ?? true} onCheckedChange={(v) => setEdit({ ...edit, active: v })} /> Active</label>
            )}
          </div>
        )}
      </FormDialog>
    </div>
  )
}

// ------------------------------------------------------------------ My Setup
function SetupTab({ ov }: { ov: Overview }) {
  const { engine, state } = usePhone()
  const eligibility = useQuery({ queryKey: ['vd-eligibility'], queryFn: pbx.getInboundPhoneEligibility, refetchInterval: 20_000 })
  const registration = useQuery({ queryKey: ['vd-registration'], queryFn: pbx.getMyBrowserPhoneRegistration, refetchInterval: 10_000 })
  const reasons: Record<string, string> = {
    NO_EXTENSION: 'You have no extension yet — ask your manager to add you under Call Agents',
    AGENT_DISABLED: 'Your extension is switched off', INBOUND_OFF: 'Incoming calls are off for you (Call Agents)', NO_SEAT: 'No paid seat is free for you',
    ...LINE_PROBLEM,
  }
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">My phone</CardTitle>
          <CardDescription>Chrome or Edge with a headset works best. The phone stays on while this tab is open; you can move between pages.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          {!engine || !state ? <p className="text-muted-foreground">You don't have phone access (pbx.call).</p> : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={state.status === 'ready' ? 'success' : state.status === 'error' ? 'danger' : state.status === 'off' ? 'neutral' : 'warning'}>
                  {state.status === 'ready' ? 'Connected' : state.status === 'off' ? 'Off' : state.status === 'error' ? 'Problem' : 'Connecting'}
                </Badge>
                {state.extension && <span>Extension <span className="font-mono">{state.extension}</span></span>}
                {state.credentialExpiresAt && <span className="text-xs text-muted-foreground">sign-in renews before {formatDateTime(state.credentialExpiresAt)}</span>}
              </div>
              {state.error && <p className="text-xs text-red-600">{state.error}</p>}
              <div className="flex flex-wrap gap-2">
                {state.status === 'off' || state.status === 'error'
                  ? <Button onClick={() => void engine.start()} disabled={ov.lineStatus !== 'ACTIVE' || !ov.me}><Power /> Start phone</Button>
                  : <Button variant="outline" onClick={() => void engine.stop()}><Power /> Turn off</Button>}
                {state.status === 'ready' && (
                  <Button variant="outline" onClick={() => void engine.setAvailability(state.availability === 'AVAILABLE' ? 'AWAY' : 'AVAILABLE')}>
                    {state.availability === 'AVAILABLE' ? 'Set away (no incoming)' : 'Set available'}
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle className="text-base">Can I receive calls?</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {eligibility.data?.eligible
            ? <p className="flex items-center gap-1.5 text-emerald-700"><CheckCircle2 className="size-4" /> Yes — incoming calls ring you while your phone is connected and set available.</p>
            : <ul className="list-disc space-y-1 pl-5 text-muted-foreground">{(eligibility.data?.reasons ?? []).map((r) => <li key={r}>{reasons[r] ?? r}</li>)}</ul>}
          {registration.data?.hasExtension && (
            <p className="text-xs text-muted-foreground">
              Server sees you: {registration.data.registered ? `online (${registration.data.status?.toLowerCase()})` : 'offline'}
              {registration.data.lastHeartbeatAt ? ` · last seen ${timeAgo(registration.data.lastHeartbeatAt)}` : ''}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

// ------------------------------------------------------------------ Missed & Callback
function MissedTab() {
  const { dial, canCall } = usePhone()
  const missed = useQuery({ queryKey: ['vd-missed'], queryFn: () => pbx.getRecentMissedInboundCalls(100), refetchInterval: 15_000 })
  const callBack = useMutation({ mutationFn: (c: CallRecord) => dial({ phone: c.customerPhone ?? '', callbackOf: c.id }), onError: (e) => toast.error((e as Error).message) })
  if (missed.isLoading) return <LoadingState />
  if (missed.error) return <ErrorState error={missed.error} onRetry={() => missed.refetch()} />
  const items = missed.data?.items ?? []
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Missed calls</CardTitle><CardDescription>Calls nobody answered, or that came while every channel was busy. Call back from here.</CardDescription></CardHeader>
      <CardContent className="overflow-x-auto">
        {!items.length ? <EmptyState icon={<PhoneMissed />} title="No missed calls" /> : (
          <Table>
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Caller</TableHead><TableHead>Why</TableHead><TableHead>Called back</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {items.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="whitespace-nowrap">{formatDateTime(c.createdAt)}<p className="text-xs text-muted-foreground">{timeAgo(c.createdAt)}</p></TableCell>
                  <TableCell className="font-mono">{c.customerPhone}</TableCell>
                  <TableCell><StatusBadge value={c.status} map={CALL_STATUS} />{c.rejectReason && <p className="text-xs text-muted-foreground">{REJECT_REASON[c.rejectReason] ?? c.rejectReason}</p>}</TableCell>
                  <TableCell>{c.calledBack ? <Badge variant="success">Called back</Badge> : <span className="text-xs text-muted-foreground">Not yet</span>}</TableCell>
                  <TableCell className="text-right">
                    <Button size="sm" variant={c.calledBack ? 'outline' : 'default'} disabled={!canCall || callBack.isPending} onClick={() => callBack.mutate(c)}><PhoneCall /> Call back</Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  )
}

// ------------------------------------------------------------------ Reports
function ReportsTab() {
  const [range, setRange] = useState<DateRange>(() => rangeFor('7d'))
  const q = useQuery({ queryKey: ['vd-reports', range], queryFn: () => pbx.reports(range.from, range.to) })
  const outcome = useMemo(() => Object.fromEntries(OUTCOMES.map((o) => [o.value, o.label])), [])
  return (
    <div className="space-y-4">
      <DateRangeFilter value={range} onChange={setRange} />
      {q.isLoading ? <LoadingState /> : q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard label="Calls" value={formatNumber(q.data!.totals.calls)} hint={`${q.data!.totals.outbound} out · ${q.data!.totals.inbound} in`} />
            <StatCard label="Answered" value={formatNumber(q.data!.totals.answered)} />
            <StatCard label="Missed" value={formatNumber(q.data!.totals.missed)} tone={q.data!.totals.missed ? 'warning' : 'default'} />
            <StatCard label="Talk time" value={durationLabel(q.data!.totals.talkSeconds)} hint={`${durationLabel(q.data!.totals.billedSeconds)} billed`} />
            <StatCard label="Call charges" value={tk(q.data!.totals.chargedTk)} hint="incl. VAT" />
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Card>
              <CardHeader><CardTitle className="text-base">By agent</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Agent</TableHead><TableHead className="text-right">Out</TableHead><TableHead className="text-right">In answered</TableHead><TableHead className="text-right">Talk</TableHead><TableHead className="text-right">Charges</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {q.data!.byAgent.map((a) => (
                      <TableRow key={a.agentId ?? 'none'}>
                        <TableCell>{a.name}{a.extension ? <span className="text-xs text-muted-foreground"> · {a.extension}</span> : null}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.outbound}</TableCell>
                        <TableCell className="text-right tabular-nums">{a.inbound}</TableCell>
                        <TableCell className="text-right tabular-nums">{durationLabel(a.talkSeconds)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(a.chargedTk, 2)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-base">By day</CardTitle></CardHeader>
              <CardContent className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Day</TableHead><TableHead className="text-right">Calls</TableHead><TableHead className="text-right">Answered</TableHead><TableHead className="text-right">Missed</TableHead><TableHead className="text-right">Charges</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {q.data!.byDay.map((d) => (
                      <TableRow key={d.day}><TableCell>{d.day}</TableCell><TableCell className="text-right tabular-nums">{d.calls}</TableCell><TableCell className="text-right tabular-nums">{d.answered}</TableCell>
                        <TableCell className="text-right tabular-nums">{d.missed}</TableCell><TableCell className="text-right tabular-nums">{formatNumber(d.chargedTk, 2)}</TableCell></TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader><CardTitle className="text-base">Call log</CardTitle><CardDescription>Durations and charges come from the gateway, not the browser.</CardDescription></CardHeader>
            <CardContent className="overflow-x-auto">
              {!q.data!.recent.length ? <EmptyState icon={<PackageCheck />} title="No calls in this period" /> : (
                <Table>
                  <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Direction</TableHead><TableHead>Customer</TableHead><TableHead>Agent</TableHead><TableHead>Status</TableHead><TableHead>Outcome</TableHead><TableHead className="text-right">Billed</TableHead><TableHead className="text-right">Charged</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {q.data!.recent.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="whitespace-nowrap">{formatDateTime(c.createdAt)}</TableCell>
                        <TableCell>{c.direction === 'INBOUND' ? 'In' : 'Out'}{c.orderNumber ? <p className="text-xs text-muted-foreground">{c.orderNumber}</p> : null}</TableCell>
                        <TableCell className="font-mono text-xs">{c.customerPhone}</TableCell>
                        <TableCell>{c.agentName ?? '—'}</TableCell>
                        <TableCell><StatusBadge value={c.status} map={CALL_STATUS} /></TableCell>
                        <TableCell className="text-xs">{c.outcome ? outcome[c.outcome] : '—'}</TableCell>
                        <TableCell className="text-right tabular-nums">{durationLabel(c.billedSeconds)}</TableCell>
                        <TableCell className="text-right tabular-nums">{c.chargedTk ? formatNumber(c.chargedTk, 4) : '—'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
