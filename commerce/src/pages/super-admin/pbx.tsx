import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, Copy, KeyRound, PhoneCall, Plus, Server, Trash2, XCircle } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { SearchInput } from '@/components/common/search-input'
import { EmptyState, ErrorState, LoadingState, TableSkeleton } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDate, formatDateTime, formatMoney, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import {
  pbxAdjustBalance, pbxBridgeReady, pbxCheck, type PbxCheck, pbxGatewayToken, pbxGrantPackage, type PbxLine, pbxMerchant, type PbxMerchant, pbxOverview,
  type PbxOverview, pbxSaveAgent, pbxSaveRingGroup, pbxSaveSettings, pbxSetEnabled, pbxSetup, pbxTrunkSecret, pbxTurnSecret, type VoiceDriveConfig,
} from '@/services/pbx-setup'
import { LINE_PROBLEM } from '@/services/voicedrive'

const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success('Copied'), () => toast.error('Could not copy — select it and copy by hand'))

function LineBadge({ line }: { line: PbxLine | null }) {
  if (!line) return <Badge variant="neutral">Not set up</Badge>
  if (line.problems.length === 0) return <Badge variant="success">Working</Badge>
  if (!line.pbx_enabled) return <Badge variant="neutral">Off</Badge>
  return <Badge variant="warning">Needs setup</Badge>
}

// ------------------------------------------------------------------ one merchant
function LineForm({ merchant, line, onSaved }: { merchant: string; line: PbxLine | null; onSaved: () => void }) {
  const [form, setForm] = useState({
    did: line?.did ?? '', caller_id: line?.caller_id ?? '', trunk_host: line?.trunk_host ?? '', trunk_port: String(line?.trunk_port ?? 5060),
    trunk_transport: line?.trunk_transport ?? 'udp', trunk_user: line?.trunk_user ?? '', trunk_register: line?.trunk_register ?? true,
    dial_format: line?.dial_format ?? 'LOCAL', max_call_minutes: String(line?.max_call_minutes ?? 15),
  })
  const [reason, setReason] = useState('')
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const missing = !form.did.trim() || !form.trunk_host.trim()
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => pbxSetup(merchant, {
      did: form.did.trim(), caller_id: form.caller_id.trim() || undefined, trunk_host: form.trunk_host.trim(), trunk_port: Number(form.trunk_port) || 5060,
      trunk_transport: form.trunk_transport, trunk_user: form.trunk_user.trim() || undefined, trunk_register: form.trunk_register, dial_format: form.dial_format,
      max_call_minutes: Number(form.max_call_minutes) || 15,
    }, reason.trim() || undefined),
    onSuccess: () => { toast.success(line ? 'Line saved' : 'Line created'); setReason(''); onSaved() },
  })
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Phone number (DID)" required hint="From the IPTSP, like 09639XXXXXX"><Input value={form.did} onChange={set('did')} inputMode="tel" /></Field>
        <Field label="Caller ID" hint="Empty = the DID"><Input value={form.caller_id} onChange={set('caller_id')} inputMode="tel" /></Field>
        <Field label="Trunk host" required hint="Name or IP the IPTSP gave you"><Input value={form.trunk_host} onChange={set('trunk_host')} className="font-mono text-xs" /></Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Port"><Input type="number" min={1} max={65535} value={form.trunk_port} onChange={set('trunk_port')} /></Field>
          <Field label="Transport">
            <Select value={form.trunk_transport} onValueChange={(v) => setForm((f) => ({ ...f, trunk_transport: v as 'udp' }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="udp">UDP</SelectItem><SelectItem value="tcp">TCP</SelectItem><SelectItem value="tls">TLS</SelectItem></SelectContent>
            </Select>
          </Field>
        </div>
        <Field label="Trunk user name"><Input value={form.trunk_user} onChange={set('trunk_user')} autoComplete="off" /></Field>
        <Field label="Dialled number format">
          <Select value={form.dial_format} onValueChange={(v) => setForm((f) => ({ ...f, dial_format: v as 'LOCAL' }))}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="LOCAL">Local (01XXXXXXXXX)</SelectItem><SelectItem value="E164">+8801XXXXXXXXX</SelectItem><SelectItem value="E164_NO_PLUS">8801XXXXXXXXX</SelectItem></SelectContent>
          </Select>
        </Field>
        <Field label="Longest call (minutes)"><Input type="number" min={1} max={120} value={form.max_call_minutes} onChange={set('max_call_minutes')} /></Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm"><Switch checked={form.trunk_register} onCheckedChange={(v) => setForm((f) => ({ ...f, trunk_register: v }))} /> Register with the IPTSP</label>
      </div>
      <Field label="Reason (kept in the audit log)"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. New DID from the IPTSP" /></Field>
      {save.error && <p className="rounded-md bg-red-500/10 p-2 text-sm text-red-500" role="alert">{save.error.message}</p>}
      <Button disabled={missing || save.isPending} onClick={() => save.mutate()}>{line ? 'Save number and trunk' : 'Create the line'}</Button>
      {missing && <p className="text-xs text-muted-foreground">The number and the trunk host are needed.</p>}
    </div>
  )
}

function TrunkSecret({ merchant, line, onSaved }: { merchant: string; line: PbxLine; onSaved: () => void }) {
  const [password, setPassword] = useState('')
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (value: string) => pbxTrunkSecret(merchant, value),
    onSuccess: (_r, value) => { toast.success(value ? 'Trunk password saved' : 'Trunk password removed'); setPassword(''); onSaved() },
  })
  return (
    <div className="space-y-2 text-sm">
      <p>Trunk password: {line.trunk_secret_set ? <span className="font-mono">{line.trunk_secret_hint ?? '••••'}</span> : <span className="text-amber-500">not saved</span>}</p>
      <div className="flex gap-2">
        <Input type="password" autoComplete="new-password" aria-label="Trunk password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Kept encrypted; never shown again" />
        <Button size="sm" disabled={!password || /\s/.test(password) || save.isPending} onClick={() => save.mutate(password)}>Save</Button>
        {line.trunk_secret_set && <Button size="sm" variant="ghost" disabled={save.isPending} onClick={() => save.mutate('')}>Remove</Button>}
      </div>
      {save.error && <p className="text-xs text-red-500" role="alert">{save.error.message}</p>}
    </div>
  )
}

function Checks({ merchant }: { merchant: string }) {
  const [result, setResult] = useState<PbxCheck | null>(null)
  const run = useMutation({ mutationFn: () => pbxCheck(merchant), onSuccess: setResult })
  return (
    <div className="space-y-2">
      <Button size="sm" variant="outline" disabled={run.isPending} onClick={() => run.mutate()}><PhoneCall /> Test the line</Button>
      {result && (
        <ul className="space-y-1 text-sm">
          {result.checks.map((c) => (
            <li key={c.key} className="flex items-start gap-2">
              {c.ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-red-500" />}
              <span className={cn(!c.ok && 'text-muted-foreground')}>{c.detail}</span>
            </li>
          ))}
          <li className="pt-1 text-xs text-muted-foreground">Checked {formatDateTime(result.at)} from the database and the gateway's last report. A real test call is made from the merchant's phone.</li>
        </ul>
      )}
    </div>
  )
}

function PackageDialog({ merchant, packages, onClose, onDone }: { merchant: string; packages: PbxOverview['packages']; onClose: () => void; onDone: () => void }) {
  const [form, setForm] = useState({ package_id: '', months: '1', extra_agents: '0', extra_channels: '0', agents: '', channels: '', amount_tk: '0', reason: '' })
  const pkg = packages.find((p) => p.id === form.package_id)
  const grant = useMutation({
    meta: { silent: true },
    mutationFn: () => pbxGrantPackage(merchant, {
      package_id: form.package_id, months: Number(form.months), extra_agents: Number(form.extra_agents) || 0, extra_channels: Number(form.extra_channels) || 0,
      ...(pkg?.is_custom ? { agents: Number(form.agents), channels: Number(form.channels) } : {}), amount_tk: Number(form.amount_tk) || 0,
    }, form.reason.trim()),
    onSuccess: () => { toast.success('Package given'); onDone(); onClose() },
  })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Give a package" submitLabel="Give package" busy={grant.isPending}
      description="Starts now and replaces the current package. For a deal agreed outside the app (no payment is taken here)."
      disabled={!form.package_id || form.reason.trim().length < 5} onSubmit={() => grant.mutate()}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Package" className="sm:col-span-2">
          <Select value={form.package_id} onValueChange={(v) => setForm((f) => ({ ...f, package_id: v }))}>
            <SelectTrigger><SelectValue placeholder="Choose" /></SelectTrigger>
            <SelectContent>{packages.filter((p) => p.active).map((p) => <SelectItem key={p.id} value={p.id}>{p.name}{p.is_custom ? ' (custom)' : ` — ${p.agent_limit} agents, ${p.concurrent_channels} channels, ${formatMoney(p.monthly_price_tk)}/month`}</SelectItem>)}</SelectContent>
          </Select>
        </Field>
        <Field label="Months"><Input type="number" min={1} max={12} value={form.months} onChange={set('months')} /></Field>
        <Field label="Amount agreed (BDT)" hint="Recorded on the package only"><Input type="number" min={0} value={form.amount_tk} onChange={set('amount_tk')} /></Field>
        {pkg?.is_custom ? <>
          <Field label="Agents"><Input type="number" min={1} value={form.agents} onChange={set('agents')} /></Field>
          <Field label="Channels"><Input type="number" min={1} value={form.channels} onChange={set('channels')} /></Field>
        </> : <>
          <Field label="Extra agents"><Input type="number" min={0} value={form.extra_agents} onChange={set('extra_agents')} /></Field>
          <Field label="Extra channels"><Input type="number" min={0} value={form.extra_channels} onChange={set('extra_channels')} /></Field>
        </>}
        <Field label="Why" required className="sm:col-span-2"><Input value={form.reason} onChange={set('reason')} placeholder="e.g. Annual deal signed 10 Oct" /></Field>
      </div>
      {grant.error && <p className="mt-2 text-sm text-red-500" role="alert">{grant.error.message}</p>}
    </FormDialog>
  )
}

function BalanceDialog({ merchant, onClose, onDone }: { merchant: string; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')
  const adjust = useMutation({
    meta: { silent: true },
    mutationFn: () => pbxAdjustBalance(merchant, Number(amount), reason.trim()),
    onSuccess: (r) => { toast.success(`New balance ${formatMoney(r.balanceTk)}`); onDone(); onClose() },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Adjust the call balance" submitLabel="Apply" busy={adjust.isPending}
      description="A correction or goodwill amount. Recorded in the merchant's PBX ledger and the audit log; the ledger is never edited."
      disabled={!Number(amount) || reason.trim().length < 5} onSubmit={() => adjust.mutate()}>
      <div className="grid gap-3">
        <Field label="Amount (BDT)" hint="Negative to take away"><Input type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Why" required><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
      {adjust.error && <p className="mt-2 text-sm text-red-500" role="alert">{adjust.error.message}</p>}
    </FormDialog>
  )
}

function Extensions({ merchant, d, onChanged }: { merchant: string; d: PbxMerchant; onChanged: () => void }) {
  const [adding, setAdding] = useState({ profile_id: '', extension: '', ring_group_id: '' })
  const [group, setGroup] = useState({ name: '', strategy: 'RING_ALL', ring_seconds: '30' })
  const save = useMutation({
    meta: { silent: true },
    mutationFn: (p: Parameters<typeof pbxSaveAgent>[1]) => pbxSaveAgent(merchant, p),
    onSuccess: () => { setAdding({ profile_id: '', extension: '', ring_group_id: '' }); onChanged() },
    onError: (e) => toast.error((e as Error).message),
  })
  const saveGroup = useMutation({
    meta: { silent: true },
    mutationFn: () => pbxSaveRingGroup(merchant, { name: group.name.trim(), strategy: group.strategy, ring_seconds: Number(group.ring_seconds) || 30 }),
    onSuccess: () => { setGroup({ name: '', strategy: 'RING_ALL', ring_seconds: '30' }); onChanged() },
    onError: (e) => toast.error((e as Error).message),
  })
  const free = d.staff.filter((s) => !d.agents.some((a) => a.profile_id === s.id))
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Extensions ({d.agents.filter((a) => a.active).length} active of {d.business?.limits.agents ?? 0} seats)</p>
        {d.agents.length === 0 ? <p className="text-sm text-muted-foreground">No extensions yet.</p> : (
          <Table>
            <TableBody>
              {d.agents.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-xs">{a.extension}</TableCell>
                  <TableCell className="text-sm">{a.name}{a.online && <Badge variant="success" className="ml-1">online</Badge>}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{d.ring_groups.find((g) => g.id === a.ring_group_id)?.name ?? 'No call group'}</TableCell>
                  <TableCell className="text-right">
                    {d.can.manage && <>
                      <Switch aria-label={`Extension ${a.extension} active`} checked={a.active} onCheckedChange={(v) => save.mutate({ id: a.id, active: v })} />
                      <Button size="icon" variant="ghost" aria-label={`Remove extension ${a.extension}`} onClick={() => save.mutate({ id: a.id, remove: true })}><Trash2 /></Button>
                    </>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {d.can.manage && d.business && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Select value={adding.profile_id} onValueChange={(v) => setAdding((x) => ({ ...x, profile_id: v }))}>
              <SelectTrigger size="sm" className="w-48"><SelectValue placeholder="Staff member" /></SelectTrigger>
              <SelectContent>{free.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>)}</SelectContent>
            </Select>
            <Input className="h-8 w-24" placeholder="Ext. (auto)" value={adding.extension} onChange={(e) => setAdding((x) => ({ ...x, extension: e.target.value }))} aria-label="Extension" />
            <Select value={adding.ring_group_id || 'none'} onValueChange={(v) => setAdding((x) => ({ ...x, ring_group_id: v === 'none' ? '' : v }))}>
              <SelectTrigger size="sm" className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">No call group</SelectItem>{d.ring_groups.map((g) => <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>)}</SelectContent>
            </Select>
            <Button size="sm" variant="outline" disabled={!adding.profile_id || save.isPending}
              onClick={() => save.mutate({ profile_id: adding.profile_id, extension: adding.extension.trim() || undefined, ring_group_id: adding.ring_group_id || null })}><Plus /> Add extension</Button>
          </div>
        )}
      </div>
      <div>
        <p className="mb-1 text-xs font-medium text-muted-foreground">Call groups (incoming call routing)</p>
        {d.ring_groups.map((g) => (
          <p key={g.id} className="text-sm">{g.name} <span className="text-xs text-muted-foreground">· {g.strategy === 'RING_ALL' ? 'rings everyone' : 'longest idle first'} · {g.ring_seconds}s{g.is_default && ' · default'}{!g.active && ' · off'}</span></p>
        ))}
        {d.can.manage && d.business && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <Input className="h-8 w-40" placeholder="Group name" value={group.name} onChange={(e) => setGroup((x) => ({ ...x, name: e.target.value }))} aria-label="Group name" />
            <Select value={group.strategy} onValueChange={(v) => setGroup((x) => ({ ...x, strategy: v }))}>
              <SelectTrigger size="sm" className="w-44"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="RING_ALL">Ring everyone</SelectItem><SelectItem value="LONGEST_IDLE">Longest idle first</SelectItem></SelectContent>
            </Select>
            <Input className="h-8 w-20" type="number" min={10} max={120} value={group.ring_seconds} onChange={(e) => setGroup((x) => ({ ...x, ring_seconds: e.target.value }))} aria-label="Ring seconds" />
            <Button size="sm" variant="outline" disabled={group.name.trim().length < 1 || saveGroup.isPending} onClick={() => saveGroup.mutate()}><Plus /> Add group</Button>
          </div>
        )}
      </div>
    </div>
  )
}

function MerchantSheet({ id, packages, onClose }: { id: string | null; packages: PbxOverview['packages']; onClose: () => void }) {
  const queryClient = useQueryClient()
  const q = useQuery({ queryKey: ['platform-pbx', id], enabled: !!id, queryFn: () => pbxMerchant(id!) })
  const [dialog, setDialog] = useState<'enable' | 'disable' | 'package' | 'balance' | null>(null)
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['platform-pbx'] })
  }
  const ready = useMutation({
    mutationFn: (v: boolean) => pbxBridgeReady(id!, v),
    onSuccess: () => { toast.success('Saved'); refresh() },
    onError: (e) => toast.error((e as Error).message),
  })
  const d = q.data
  const line = d?.business ?? null
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-2xl">
        {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <LoadingState /> : (
          <div className="space-y-5 px-5 pb-6">
            <SheetHeader className="px-0">
              <SheetTitle className="flex items-center gap-2">#{d.merchant.number} {d.merchant.name} <LineBadge line={line} /></SheetTitle>
              <SheetDescription>
                PBX in plan: {d.feature ? `${d.feature.state.toLowerCase().replace(/_/g, ' ')}` : 'unknown'} · <Link className="underline" to={`/super-admin/merchants/${d.merchant.id}?tab=features`}>features</Link>
                {line && <> · line code {line.code}</>}
              </SheetDescription>
            </SheetHeader>
            {line && line.problems.length > 0 && (
              <ul className="space-y-0.5 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">{line.problems.map((p) => <li key={p}>• {LINE_PROBLEM[p]}</li>)}</ul>
            )}
            {line && (
              <div className="flex flex-wrap gap-2">
                {d.can.manage && (line.pbx_enabled
                  ? <Button size="sm" variant="outline" onClick={() => setDialog('disable')}>Switch the line off</Button>
                  : <Button size="sm" onClick={() => setDialog('enable')}>Switch the line on</Button>)}
                {d.can.manage && <Button size="sm" variant="outline" disabled={ready.isPending} onClick={() => ready.mutate(!line.bridge_ready)}>{line.bridge_ready ? 'Mark not tested' : 'Mark tested'}</Button>}
                {d.can.manage && <Button size="sm" variant="outline" onClick={() => setDialog('package')}>Give a package</Button>}
                {d.can.manage && <Button size="sm" variant="outline" onClick={() => setDialog('balance')}>Adjust balance</Button>}
              </div>
            )}
            {line && <Checks merchant={d.merchant.id} />}

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Number and SIP trunk</h3>
              {d.can.manage ? <LineForm key={line?.provisioned_at ?? 'new'} merchant={d.merchant.id} line={line} onSaved={refresh} /> : line ? (
                <p className="text-sm">{line.did ?? 'No number'} via {line.trunk_host ?? '—'}:{line.trunk_port}/{line.trunk_transport}</p>
              ) : <p className="text-sm text-muted-foreground">No line set up.</p>}
              {line && d.can.manage && <TrunkSecret merchant={d.merchant.id} line={line} onSaved={refresh} />}
              {line && <p className="text-xs text-muted-foreground">Gateway reports this trunk as: <b>{line.trunk.reported ?? 'not reported'}</b>{line.trunk.gateway_seen_at && ` (check-in ${timeAgo(line.trunk.gateway_seen_at)})`}</p>}
            </section>

            {line && (
              <section className="grid gap-3 sm:grid-cols-3">
                <Card className="gap-1 px-3 py-2"><p className="text-xs text-muted-foreground">Package</p><p className="text-sm font-medium">{line.limits.active ? line.limits.packageName : 'None'}</p>
                  <p className="text-xs text-muted-foreground">{line.limits.active ? `${line.limits.agents} agents · ${line.limits.channels} channels · until ${formatDate(line.limits.expiresAt)}` : line.limits.expiresAt ? `ended ${formatDate(line.limits.expiresAt)}` : ''}</p></Card>
                <Card className="gap-1 px-3 py-2"><p className="text-xs text-muted-foreground">Outgoing balance</p><p className="text-sm font-medium">{formatMoney(line.balance_tk)}</p></Card>
                <Card className="gap-1 px-3 py-2"><p className="text-xs text-muted-foreground">Calls (30 days)</p><p className="text-sm font-medium">{formatNumber(d.calls.total)}</p>
                  <p className="text-xs text-muted-foreground">{d.calls.answered} answered · {d.calls.missed} missed · {d.calls.minutes} min</p></Card>
              </section>
            )}

            {line && (
              <section className="space-y-2">
                <h3 className="text-sm font-semibold">Extensions and routing</h3>
                <Extensions merchant={d.merchant.id} d={d} onChanged={refresh} />
              </section>
            )}

            {d.click_to_call && (
              <section className="space-y-1 text-sm">
                <h3 className="text-sm font-semibold">Click-to-call with another PBX</h3>
                <p className="text-muted-foreground">
                  {d.click_to_call.enabled ? `On · ${d.click_to_call.provider ?? 'provider'} · ${d.click_to_call.mode === 'api' ? `API (${d.click_to_call.api_host ?? 'no address'})` : 'phone links'}` : 'Off'}
                  {' · '}{d.click_to_call.extensions} extensions · {d.click_to_call.calls_7d} calls logged in 7 days{d.click_to_call.has_secret && ' · API secret saved'}
                </p>
                <p className="text-xs text-muted-foreground">The merchant's own vendor account: they set it up in their Settings → PBX; its credentials stay with them.</p>
              </section>
            )}

            {d.payments.length + d.ledger.length > 0 && (
              <section className="space-y-1">
                <h3 className="text-sm font-semibold">Payments and balance changes</h3>
                {d.payments.slice(0, 5).map((p) => (
                  <p key={p.reference} className="text-xs">{formatDateTime(p.created_at)} · {p.type.toLowerCase()} {formatMoney(p.amount_tk)} · <span className={p.status === 'COMPLETED' ? 'text-emerald-500' : 'text-muted-foreground'}>{p.status.toLowerCase()}</span>{p.trx_id && ` · ${p.trx_id}`}</p>
                ))}
                {d.ledger.slice(0, 8).map((l) => (
                  <p key={l.id} className="text-xs text-muted-foreground">{formatDateTime(l.created_at)} · {l.kind.toLowerCase().replace('_', ' ')} {formatMoney(l.amount_tk)} → {formatMoney(l.balance_after_tk)}{l.note && ` · ${l.note}`}</p>
                ))}
              </section>
            )}
            {d.history.length > 0 && (
              <section className="space-y-1">
                <h3 className="text-sm font-semibold">Changes by the platform team</h3>
                {d.history.map((h, i) => <p key={i} className="text-xs text-muted-foreground">{formatDateTime(h.created_at)} · {h.action} · {h.actor ?? 'system'}{h.reason && ` · ${h.reason}`}</p>)}
              </section>
            )}
          </div>
        )}
        {d && (
          <>
            <ConfirmDialog open={dialog === 'enable' || dialog === 'disable'} onOpenChange={(o) => !o && setDialog(null)} reason reasonRequired
              title={dialog === 'enable' ? 'Switch the PBX line on?' : 'Switch the PBX line off?'} confirmLabel={dialog === 'enable' ? 'Switch on' : 'Switch off'} destructive={dialog === 'disable'}
              description={dialog === 'enable' ? 'Their staff can call once the line is tested and a package is active.' : 'Calls stop at once for this merchant. Their balance and package are kept.'}
              onConfirm={async (reason) => {
                try { await pbxSetEnabled(d.merchant.id, dialog === 'enable', reason); toast.success('Saved'); refresh() } catch (e) { toast.error((e as Error).message); throw e }
              }} />
            {dialog === 'package' && <PackageDialog merchant={d.merchant.id} packages={packages} onClose={() => setDialog(null)} onDone={refresh} />}
            {dialog === 'balance' && <BalanceDialog merchant={d.merchant.id} onClose={() => setDialog(null)} onDone={refresh} />}
          </>
        )}
      </SheetContent>
    </Sheet>
  )
}

// ------------------------------------------------------------------ gateway
function GatewaySettings({ data }: { data: PbxOverview }) {
  const queryClient = useQueryClient()
  const s = data.settings
  const [form, setForm] = useState({
    sip_domain: s.sip_domain ?? '', wss_url: s.wss_url ?? '', turn_urls: (s.turn_urls ?? []).join('\n'), stun_urls: (s.stun_urls ?? []).join('\n'),
    credential_ttl_seconds: String(s.credential_ttl_seconds ?? 900), rate_tk_per_min: String(s.rate_tk_per_min ?? 0.4), vat_percent: String(s.vat_percent ?? 15),
    min_topup_tk: String(s.min_topup_tk ?? 100), max_topup_tk: String(s.max_topup_tk ?? 50000), extra_agent_tk: String(s.extra_agent_tk ?? 100),
    extra_channel_tk: String(s.extra_channel_tk ?? 150),
    m_start: s.maintenance?.starts_at?.slice(0, 16) ?? '', m_until: s.maintenance?.until?.slice(0, 16) ?? '', m_message: s.maintenance?.message ?? '',
  })
  const [reason, setReason] = useState('')
  const [turn, setTurn] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const lines = (v: string) => v.split('\n').map((x) => x.trim()).filter(Boolean)
  const save = useMutation({
    meta: { silent: true },
    mutationFn: () => pbxSaveSettings({
      sip_domain: form.sip_domain, wss_url: form.wss_url, turn_urls: lines(form.turn_urls), stun_urls: lines(form.stun_urls),
      credential_ttl_seconds: Number(form.credential_ttl_seconds), rate_tk_per_min: Number(form.rate_tk_per_min), vat_percent: Number(form.vat_percent),
      min_topup_tk: Number(form.min_topup_tk), max_topup_tk: Number(form.max_topup_tk), extra_agent_tk: Number(form.extra_agent_tk), extra_channel_tk: Number(form.extra_channel_tk),
      maintenance: { starts_at: form.m_start ? new Date(form.m_start).toISOString() : null, until: form.m_until ? new Date(form.m_until).toISOString() : null, message: form.m_message || null },
    } as Partial<VoiceDriveConfig>, reason.trim() || undefined),
    onSuccess: () => { toast.success('Saved'); setReason(''); void queryClient.invalidateQueries({ queryKey: ['platform-pbx'] }) },
  })
  const rotate = useMutation({ mutationFn: pbxGatewayToken, onSuccess: (r) => { setToken(r.token); void queryClient.invalidateQueries({ queryKey: ['platform-pbx'] }) }, onError: (e) => toast.error((e as Error).message) })
  const saveTurn = useMutation({
    mutationFn: () => pbxTurnSecret(turn),
    onSuccess: () => { setTurn(''); toast.success('TURN secret saved'); void queryClient.invalidateQueries({ queryKey: ['platform-pbx'] }) },
    onError: (e) => toast.error((e as Error).message),
  })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }))
  const g = data.gateway
  const m = data.can.manage
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><Server className="size-4" /> Gateway</CardTitle>
            <CardDescription>The Asterisk gateway checks in every 30 seconds (pbx-gateway/README.md).</CardDescription></CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p className="flex items-center gap-2"><Badge variant={g?.online ? 'success' : 'danger'}>{g?.online ? 'Online' : g?.last_seen_at ? 'Offline' : 'Never checked in'}</Badge>
              {g?.version && <span className="text-muted-foreground">{g.version}</span>}{g?.last_seen_at && <span className="text-xs text-muted-foreground">last check-in {timeAgo(g.last_seen_at)}</span>}</p>
            {g?.online && <p className="text-xs text-muted-foreground">{g.softphones_online ?? 0} softphones online · {g.active_calls ?? 0} calls now</p>}
            {g?.trunk_sync?.error && <p className="text-xs text-red-500">Trunk sync failed: {g.trunk_sync.error}</p>}
            {(g?.trunks ?? []).map((t) => <p key={t.name} className="text-xs">{t.name}: <span className={t.state === 'online' ? 'text-emerald-500' : 'text-amber-500'}>{t.state}</span></p>)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-sm"><KeyRound className="size-4" /> Gateway secrets</CardTitle><CardDescription>Kept encrypted; never shown again after saving.</CardDescription></CardHeader>
          <CardContent className="space-y-4 text-sm">
            <div className="space-y-2">
              <p>Gateway token: {data.secrets.gateway_token ? <span className="font-mono">{data.secrets.gateway_token.hint}</span> : <span className="text-muted-foreground">not set</span>}</p>
              {token ? (
                <div className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/10 p-2">
                  <p className="text-xs font-medium">Copy it now into the gateway's .env as VD_GATEWAY_TOKEN — it won't be shown again.</p>
                  <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate text-xs">{token}</code><Button size="sm" variant="outline" onClick={() => void copy(token)}><Copy /> Copy</Button></div>
                </div>
              ) : m && <Button size="sm" variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate()}>{data.secrets.gateway_token ? 'Replace gateway token' : 'New gateway token'}</Button>}
            </div>
            <div className="space-y-2">
              <p>TURN secret: {data.secrets.turn_secret ? <span className="font-mono">{data.secrets.turn_secret.hint}</span> : <span className="text-muted-foreground">not set (TURN off)</span>}</p>
              {m && <div className="flex gap-2">
                <Input type="password" autoComplete="off" value={turn} onChange={(e) => setTurn(e.target.value)} placeholder="Same as TURN_SECRET in the gateway .env" aria-label="TURN secret" />
                <Button size="sm" disabled={turn.length < 16 || saveTurn.isPending} onClick={() => saveTurn.mutate()}>Save</Button>
              </div>}
            </div>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-sm">Shared settings</CardTitle><CardDescription>The same for every merchant: addresses browsers connect to, call rates and package extras, maintenance.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 md:grid-cols-2">
            <Field label="SIP domain"><Input disabled={!m} value={form.sip_domain} onChange={set('sip_domain')} placeholder="pbx.example.com" /></Field>
            <Field label="WebSocket address"><Input disabled={!m} value={form.wss_url} onChange={set('wss_url')} placeholder="wss://pbx.example.com:8089/ws" /></Field>
            <Field label="STUN servers (one per line)"><Textarea disabled={!m} rows={2} value={form.stun_urls} onChange={set('stun_urls')} /></Field>
            <Field label="TURN servers (one per line)"><Textarea disabled={!m} rows={2} value={form.turn_urls} onChange={set('turn_urls')} placeholder="turns:turn.example.com:5349" /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Field label="Rate (tk/min)"><Input disabled={!m} type="number" step="0.01" value={form.rate_tk_per_min} onChange={set('rate_tk_per_min')} /></Field>
            <Field label="VAT %"><Input disabled={!m} type="number" value={form.vat_percent} onChange={set('vat_percent')} /></Field>
            <Field label="Smallest top-up"><Input disabled={!m} type="number" value={form.min_topup_tk} onChange={set('min_topup_tk')} /></Field>
            <Field label="Largest top-up"><Input disabled={!m} type="number" value={form.max_topup_tk} onChange={set('max_topup_tk')} /></Field>
            <Field label="Extra agent / month"><Input disabled={!m} type="number" value={form.extra_agent_tk} onChange={set('extra_agent_tk')} /></Field>
            <Field label="Extra channel / month"><Input disabled={!m} type="number" value={form.extra_channel_tk} onChange={set('extra_channel_tk')} /></Field>
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <Field label="Softphone password lasts (s)"><Input disabled={!m} type="number" min={120} max={3600} value={form.credential_ttl_seconds} onChange={set('credential_ttl_seconds')} /></Field>
            <Field label="Maintenance from"><Input disabled={!m} type="datetime-local" value={form.m_start} onChange={set('m_start')} /></Field>
            <Field label="Maintenance until"><Input disabled={!m} type="datetime-local" value={form.m_until} onChange={set('m_until')} /></Field>
            <Field label="Message to merchants"><Input disabled={!m} value={form.m_message} maxLength={200} onChange={set('m_message')} /></Field>
          </div>
          {m && <>
            <Field label="Reason (kept in the history)"><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            {save.error && <p className="text-sm text-red-500" role="alert">{save.error.message}</p>}
            <Button disabled={save.isPending} onClick={() => save.mutate()}>Save settings</Button>
          </>}
        </CardContent>
      </Card>
    </div>
  )
}

export default function PbxSetupPage() {
  const [state, update] = useUrlState({ tab: 'lines', merchant: '', q: '' })
  const q = useQuery({ queryKey: ['platform-pbx', 'overview'], queryFn: pbxOverview, refetchInterval: 60_000 })
  const rows = (q.data?.merchants ?? []).filter((r) => !state.q || r.merchant.name.toLowerCase().includes(state.q.toLowerCase()) || String(r.merchant.number) === state.q.replace('#', ''))
  return (
    <div className="space-y-4">
      <PageHeader title="PBX Setup" description="VoiceDrive lines for each merchant — number, SIP trunk, extensions, routing, package — and the shared gateway. Only setup: calls happen in each merchant's own app." />
      <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
        <TabsList>
          <TabsTrigger value="lines">Merchant lines</TabsTrigger>
          <TabsTrigger value="gateway">Gateway & settings</TabsTrigger>
        </TabsList>
        <TabsContent value="lines" className="space-y-3">
          <SearchInput value={state.q} onChange={(v) => update({ q: v })} placeholder="Merchant name or #" />
          <Card className="gap-0 overflow-hidden py-0">
            {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !q.data ? <TableSkeleton /> : rows.length === 0 ? <EmptyState title="No merchants" /> : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead>PBX in plan</TableHead><TableHead>Line</TableHead><TableHead>Number</TableHead>
                    <TableHead>Trunk</TableHead><TableHead>Package</TableHead><TableHead className="text-right">Balance</TableHead><TableHead className="text-right">Calls 7d</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={r.merchant.id} className="cursor-pointer" onClick={() => update({ merchant: r.merchant.id })}>
                        <TableCell className="text-sm">#{r.merchant.number} {r.merchant.name}{r.merchant.is_demo && <Badge variant="violet" className="ml-1">demo</Badge>}</TableCell>
                        <TableCell className="text-xs">{r.feature?.enabled ? <span className="text-emerald-500">yes</span> : <span className="text-muted-foreground">{(r.feature?.state ?? 'unknown').toLowerCase().replace(/_/g, ' ')}</span>}</TableCell>
                        <TableCell><LineBadge line={r.business} /></TableCell>
                        <TableCell className="font-mono text-xs">{r.business?.did ?? '—'}</TableCell>
                        <TableCell className="text-xs">{r.business?.trunk_host ? <>{r.business.trunk_host} <span className={r.business.trunk.reported === 'online' ? 'text-emerald-500' : 'text-muted-foreground'}>{r.business.trunk.reported ?? (r.business.trunk_secret_set ? 'not reported' : 'no password')}</span></> : '—'}</TableCell>
                        <TableCell className="text-xs">{r.business?.limits.active ? `${r.business.limits.packageName} · ${r.business.limits.agents} agents` : '—'}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{r.business ? formatMoney(r.business.balance_tk) : '—'}</TableCell>
                        <TableCell className="text-right text-xs tabular-nums">{formatNumber(r.calls_7d)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Card>
        </TabsContent>
        <TabsContent value="gateway">{q.data ? <GatewaySettings key={JSON.stringify(q.data.settings)} data={q.data} /> : <LoadingState />}</TabsContent>
      </Tabs>
      <MerchantSheet id={state.merchant || null} packages={q.data?.packages ?? []} onClose={() => update({ merchant: '' })} />
    </div>
  )
}
