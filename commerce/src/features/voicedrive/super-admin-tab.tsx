import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, CheckCircle2, Copy, KeyRound, Plus, Server, ShieldAlert } from 'lucide-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { LINE_PROBLEM, pbxSuperAdmin, type AdminBusiness, type AdminOverview } from '@/services/voicedrive'

const copy = (text: string) => navigator.clipboard.writeText(text).then(() => toast.success('Copied'), () => toast.error('Could not copy — select it and copy by hand'))

/** Super Admin: gateway, platform settings, and each business's number and trunk. */
export function SuperAdminTab() {
  const q = useQuery({ queryKey: ['vd-admin'], queryFn: pbxSuperAdmin.overview, refetchInterval: 30_000 })
  if (q.isLoading) return <LoadingState />
  if (q.error) return <ErrorState error={q.error} onRetry={() => q.refetch()} />
  const data = q.data!
  return (
    <div className="space-y-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <GatewayCard data={data} />
        <SecretsCard data={data} />
      </div>
      <PlatformSettings data={data} />
      <Businesses data={data} />
      <Members data={data} />
      <p className="text-xs text-muted-foreground">Using another cloud PBX through webhooks instead? <Link to="/admin/settings/pbx" className="underline">External PBX settings</Link>.</p>
    </div>
  )
}

function GatewayCard({ data }: { data: AdminOverview }) {
  const g = data.gateway
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Server className="size-4" /> Gateway</CardTitle>
        <CardDescription>The Asterisk gateway checks in every 30 seconds. Deploy it with pbx-gateway/README.md.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="flex items-center gap-2">
          <Badge variant={g.online ? 'success' : 'danger'}>{g.online ? 'Online' : 'Offline'}</Badge>
          {g.version && <span className="text-muted-foreground">{g.version}</span>}
          {g.lastSeenAt && <span className="text-xs text-muted-foreground">last check-in {timeAgo(g.lastSeenAt)}</span>}
        </p>
        {g.detail?.trunks && g.detail.trunks.length > 0 && (
          <ul className="space-y-0.5 text-xs">
            {g.detail.trunks.map((t) => <li key={t.name}>{t.name}: <span className={t.state === 'online' ? 'text-emerald-700' : 'text-amber-700'}>{t.state}</span></li>)}
          </ul>
        )}
        {g.online && <p className="text-xs text-muted-foreground">{g.detail?.softphonesOnline ?? 0} softphones online · {g.detail?.activeCalls ?? 0} calls now</p>}
      </CardContent>
    </Card>
  )
}

function SecretsCard({ data }: { data: AdminOverview }) {
  const queryClient = useQueryClient()
  const [turn, setTurn] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const rotate = useMutation({
    mutationFn: pbxSuperAdmin.rotateGatewayToken,
    onSuccess: (r) => { setToken(r.token); void queryClient.invalidateQueries({ queryKey: ['vd-admin'] }) },
    onError: (e) => toast.error((e as Error).message),
  })
  const saveTurn = useMutation({
    mutationFn: () => pbxSuperAdmin.saveTurnSecret(turn),
    onSuccess: () => { setTurn(''); toast.success('TURN secret saved'); void queryClient.invalidateQueries({ queryKey: ['vd-admin'] }) },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><KeyRound className="size-4" /> Gateway secrets</CardTitle>
        <CardDescription>Kept in Vault; never shown again after saving.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="space-y-2">
          <p>Gateway token: {data.secrets.gatewayToken ? <span className="font-mono">{data.secrets.gatewayToken.hint}</span> : <span className="text-muted-foreground">not set</span>}</p>
          {token ? (
            <div className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 dark:bg-amber-950/30">
              <p className="text-xs font-medium">Copy it now into the gateway's .env as VD_GATEWAY_TOKEN — it won't be shown again.</p>
              <div className="flex items-center gap-2"><code className="min-w-0 flex-1 truncate text-xs">{token}</code><Button size="sm" variant="outline" onClick={() => void copy(token)}><Copy /> Copy</Button></div>
            </div>
          ) : (
            <Button size="sm" variant="outline" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
              {data.secrets.gatewayToken ? 'Replace gateway token' : 'New gateway token'}
            </Button>
          )}
          {data.secrets.gatewayToken && !token && <p className="text-xs text-muted-foreground">Replacing it disconnects the running gateway until you put the new token in its .env.</p>}
        </div>
        <div className="space-y-2">
          <p>TURN secret: {data.secrets.turnSecret ? <span className="font-mono">{data.secrets.turnSecret.hint}</span> : <span className="text-muted-foreground">not set (TURN off)</span>}</p>
          <div className="flex gap-2">
            <Input type="password" autoComplete="off" value={turn} onChange={(e) => setTurn(e.target.value)} placeholder="Same as TURN_SECRET in the gateway .env" aria-label="TURN secret" />
            <Button size="sm" disabled={turn.length < 16 || saveTurn.isPending} onClick={() => saveTurn.mutate()}>Save</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function PlatformSettings({ data }: { data: AdminOverview }) {
  const queryClient = useQueryClient()
  const s = data.settings
  const [form, setForm] = useState({
    sip_domain: s.sipDomain ?? '', wss_url: s.wssUrl ?? '', turn_urls: (s.turnUrls ?? []).join('\n'), stun_urls: (s.stunUrls ?? []).join('\n'),
    credential_ttl_seconds: s.credentialTtlSeconds ?? 900, rate_tk_per_min: s.ratePerMinTk ?? 0.4, vat_percent: s.vatPercent ?? 15,
    m_start: s.maintenance?.starts_at?.slice(0, 16) ?? '', m_until: s.maintenance?.until?.slice(0, 16) ?? '', m_message: s.maintenance?.message ?? '',
  })
  const save = useMutation({
    mutationFn: () => pbxSuperAdmin.saveSettings({
      sip_domain: form.sip_domain.trim(), wss_url: form.wss_url.trim(),
      turn_urls: form.turn_urls.split(/\s+/).filter(Boolean), stun_urls: form.stun_urls.split(/\s+/).filter(Boolean),
      credential_ttl_seconds: Number(form.credential_ttl_seconds), rate_tk_per_min: Number(form.rate_tk_per_min), vat_percent: Number(form.vat_percent),
      maintenance: { starts_at: form.m_start ? new Date(form.m_start).toISOString() : null, until: form.m_until ? new Date(form.m_until).toISOString() : null, message: form.m_message },
    }),
    onSuccess: () => { toast.success('Saved'); void queryClient.invalidateQueries({ queryKey: ['vd-admin'] }); void queryClient.invalidateQueries({ queryKey: ['vd-page'] }) },
    onError: (e) => toast.error((e as Error).message),
  })
  const set = (p: Partial<typeof form>) => setForm({ ...form, ...p })
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Platform settings</CardTitle><CardDescription>Addresses the softphones use, the call rate, and maintenance windows.</CardDescription></CardHeader>
      <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Field label="SIP domain" htmlFor="vd-sipd" hint="e.g. pbx.example.com"><Input id="vd-sipd" value={form.sip_domain} onChange={(e) => set({ sip_domain: e.target.value })} /></Field>
        <Field label="WebSocket (WSS)" htmlFor="vd-wss" hint="wss://pbx.example.com:8089/ws"><Input id="vd-wss" value={form.wss_url} onChange={(e) => set({ wss_url: e.target.value })} /></Field>
        <Field label="Sign-in lifetime (seconds)" htmlFor="vd-ttl" hint="120–3600; the phone renews before it ends"><Input id="vd-ttl" type="number" value={form.credential_ttl_seconds} onChange={(e) => set({ credential_ttl_seconds: Number(e.target.value) })} /></Field>
        <Field label="STUN servers (one per line)" htmlFor="vd-stun"><Textarea id="vd-stun" rows={2} value={form.stun_urls} onChange={(e) => set({ stun_urls: e.target.value })} /></Field>
        <Field label="TURN servers (one per line)" htmlFor="vd-turn" hint="turn:host:3478 and turns:host:5349"><Textarea id="vd-turn" rows={2} value={form.turn_urls} onChange={(e) => set({ turn_urls: e.target.value })} /></Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Rate (tk / 60 s)" htmlFor="vd-rate"><Input id="vd-rate" type="number" step="0.01" value={form.rate_tk_per_min} onChange={(e) => set({ rate_tk_per_min: Number(e.target.value) })} /></Field>
          <Field label="VAT %" htmlFor="vd-vat"><Input id="vd-vat" type="number" value={form.vat_percent} onChange={(e) => set({ vat_percent: Number(e.target.value) })} /></Field>
        </div>
        <Field label="Maintenance from" htmlFor="vd-ms"><Input id="vd-ms" type="datetime-local" value={form.m_start} onChange={(e) => set({ m_start: e.target.value })} /></Field>
        <Field label="Maintenance until" htmlFor="vd-mu"><Input id="vd-mu" type="datetime-local" value={form.m_until} onChange={(e) => set({ m_until: e.target.value })} /></Field>
        <Field label="Maintenance message" htmlFor="vd-mm"><Input id="vd-mm" maxLength={200} value={form.m_message} onChange={(e) => set({ m_message: e.target.value })} /></Field>
        <div className="md:col-span-2 xl:col-span-3"><Button disabled={save.isPending} onClick={() => save.mutate()}>Save settings</Button></div>
      </CardContent>
    </Card>
  )
}

const BLANK = { business_id: '', did: '', caller_id: '', trunk_host: '', trunk_port: 5060, trunk_transport: 'udp', trunk_user: '', password: '', trunk_register: true, dial_format: 'LOCAL', pbx_enabled: true }

function Businesses({ data }: { data: AdminOverview }) {
  const queryClient = useQueryClient()
  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ['vd-admin'] }); void queryClient.invalidateQueries({ queryKey: ['vd-page'] }) }
  const [prov, setProv] = useState<typeof BLANK | null>(null)
  const [grant, setGrant] = useState<{ business: AdminBusiness; package_id: string; months: number; extra_agents: number; extra_channels: number; agents: number; channels: number; amount_tk: number; note: string } | null>(null)
  const [adjust, setAdjust] = useState<{ business: AdminBusiness; amount: string; note: string } | null>(null)
  const [newName, setNewName] = useState<string | null>(null)

  const provision = useMutation({
    mutationFn: async (f: typeof BLANK) => {
      await pbxSuperAdmin.provisionBusinessDid({ business_id: f.business_id, did: f.did, caller_id: f.caller_id || undefined, trunk_host: f.trunk_host,
        trunk_port: Number(f.trunk_port), trunk_transport: f.trunk_transport, trunk_user: f.trunk_user || undefined, trunk_register: f.trunk_register,
        dial_format: f.dial_format, pbx_enabled: f.pbx_enabled })
      if (f.password) await pbxSuperAdmin.saveTrunkSecret(f.business_id, f.password)
    },
    onSuccess: () => { toast.success('Number and trunk saved — the gateway picks them up within a minute'); setProv(null); refresh() },
    onError: (e) => toast.error((e as Error).message),
  })
  const ready = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => pbxSuperAdmin.setPbxBridgeReady(id, on),
    onSuccess: (_r, v) => { toast.success(v.on ? 'Bridge confirmed ready — the business can buy a package and call' : 'Bridge marked not ready'); refresh() },
    onError: (e) => toast.error((e as Error).message),
  })
  const doGrant = useMutation({
    mutationFn: () => pbxSuperAdmin.grantPackage({ business_id: grant!.business.id, package_id: grant!.package_id, months: grant!.months,
      extra_agents: grant!.extra_agents, extra_channels: grant!.extra_channels, agents: grant!.agents, channels: grant!.channels, amount_tk: grant!.amount_tk, note: grant!.note }),
    onSuccess: () => { toast.success('Package granted'); setGrant(null); refresh() },
    onError: (e) => toast.error((e as Error).message),
  })
  const doAdjust = useMutation({
    mutationFn: () => pbxSuperAdmin.adjustBalance(adjust!.business.id, Number(adjust!.amount), adjust!.note),
    onSuccess: (r) => { toast.success(`Balance now ${formatNumber(r.balanceTk, 2)} tk`); setAdjust(null); refresh() },
    onError: (e) => toast.error((e as Error).message),
  })
  const create = useMutation({
    mutationFn: () => pbxSuperAdmin.saveBusiness({ name: newName ?? '' }),
    onSuccess: () => { toast.success('Business added'); setNewName(null); refresh() },
    onError: (e) => toast.error((e as Error).message),
  })
  const pkg = data.packages.find((p) => p.id === grant?.package_id)

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base"><Building2 className="size-4" /> Businesses</CardTitle>
          <CardDescription>Each business has its own IPTSP number (DID), SIP trunk, package and balance. Confirm the bridge after the gateway shows its trunk online.</CardDescription>
        </div>
        <Button size="sm" onClick={() => setNewName('')}><Plus /> Add business</Button>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {!data.businesses.length ? <EmptyState title="No businesses" /> : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Business</TableHead><TableHead>Number / trunk</TableHead><TableHead>Bridge</TableHead><TableHead>Package</TableHead>
              <TableHead className="text-right">Balance</TableHead><TableHead>Status</TableHead><TableHead />
            </TableRow></TableHeader>
            <TableBody>
              {data.businesses.map((b) => (
                <TableRow key={b.id}>
                  <TableCell><p className="font-medium">{b.name}</p><p className="text-xs text-muted-foreground">#{b.code}{b.isPrimary ? ' · this store' : ''} · {b.agents} agents</p></TableCell>
                  <TableCell className="text-xs">
                    {b.did ? <><p className="font-mono">{b.did}</p><p className="text-muted-foreground">{b.trunkUser ?? '—'}@{b.trunkHost}:{b.trunkPort}/{b.trunkTransport}{b.trunkSecretSet ? '' : ' · no password'}</p></> : <span className="text-muted-foreground">Not provisioned</span>}
                  </TableCell>
                  <TableCell>
                    {b.bridgeReady
                      ? <Badge variant="success" title={b.bridgeReadyAt ? formatDateTime(b.bridgeReadyAt) : undefined}><CheckCircle2 className="size-3" /> Ready</Badge>
                      : <Badge variant="warning">Not ready</Badge>}
                  </TableCell>
                  <TableCell className="text-xs">{b.limits.active ? <>{b.limits.packageName}<p className="text-muted-foreground">{b.limits.agents} agents · {b.limits.channels} ch · until {formatDateTime(b.limits.expiresAt)}</p></> : <span className="text-muted-foreground">None</span>}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(b.balanceTk, 2)}</TableCell>
                  <TableCell className="text-xs">
                    {b.lineProblems.length === 0 ? <Badge variant="success">Line active</Badge>
                      : <ul className="space-y-0.5 text-muted-foreground">{b.lineProblems.map((p) => <li key={p} className="flex gap-1"><ShieldAlert className="size-3 shrink-0" /> {LINE_PROBLEM[p].replace(/ \(Super Admin\)/, '')}</li>)}</ul>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button size="sm" variant="outline" onClick={() => setProv({ ...BLANK, business_id: b.id, did: b.did ?? '', caller_id: b.callerId ?? '', trunk_host: b.trunkHost ?? '',
                        trunk_port: b.trunkPort, trunk_transport: b.trunkTransport, trunk_user: b.trunkUser ?? '', trunk_register: b.trunkRegister, dial_format: b.dialFormat, pbx_enabled: b.pbxEnabled })}>Number &amp; trunk</Button>
                      <Button size="sm" variant={b.bridgeReady ? 'ghost' : 'default'} disabled={ready.isPending} onClick={() => ready.mutate({ id: b.id, on: !b.bridgeReady })}>
                        {b.bridgeReady ? 'Mark not ready' : 'Confirm bridge ready'}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setGrant({ business: b, package_id: data.packages[0]?.id ?? '', months: 1, extra_agents: 0, extra_channels: 0, agents: 50, channels: 20, amount_tk: 0, note: '' })}>Grant package</Button>
                      <Button size="sm" variant="ghost" onClick={() => setAdjust({ business: b, amount: '', note: '' })}>Adjust balance</Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <FormDialog open={!!prov} onOpenChange={(o) => !o && setProv(null)} title="Number and SIP trunk" wide submitLabel="Save"
        description="From the IPTSP contract. The password is stored in Vault and only the gateway receives it."
        busy={provision.isPending} disabled={!prov?.did || !prov?.trunk_host} onSubmit={() => prov && provision.mutate(prov)}>
        {prov && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="DID (business number)" htmlFor="p-did" required><Input id="p-did" value={prov.did} onChange={(e) => setProv({ ...prov, did: e.target.value })} placeholder="09639XXXXXX" /></Field>
            <Field label="Caller ID (shown to customers)" htmlFor="p-cid" hint="Defaults to the DID"><Input id="p-cid" value={prov.caller_id} onChange={(e) => setProv({ ...prov, caller_id: e.target.value })} /></Field>
            <Field label="Trunk host" htmlFor="p-host" required><Input id="p-host" value={prov.trunk_host} onChange={(e) => setProv({ ...prov, trunk_host: e.target.value })} placeholder="sip.iptsp.com.bd" /></Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Port" htmlFor="p-port"><Input id="p-port" type="number" value={prov.trunk_port} onChange={(e) => setProv({ ...prov, trunk_port: Number(e.target.value) })} /></Field>
              <Field label="Transport" htmlFor="p-tr">
                <Select value={prov.trunk_transport} onValueChange={(v) => setProv({ ...prov, trunk_transport: v })}>
                  <SelectTrigger id="p-tr"><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="udp">UDP</SelectItem><SelectItem value="tcp">TCP</SelectItem></SelectContent>
                </Select>
              </Field>
            </div>
            <Field label="SIP username" htmlFor="p-user"><Input id="p-user" autoComplete="off" value={prov.trunk_user} onChange={(e) => setProv({ ...prov, trunk_user: e.target.value })} /></Field>
            <Field label="SIP password" htmlFor="p-pass" hint="Leave empty to keep the saved one"><Input id="p-pass" type="password" autoComplete="new-password" value={prov.password} onChange={(e) => setProv({ ...prov, password: e.target.value })} /></Field>
            <Field label="Dial customers as" htmlFor="p-fmt">
              <Select value={prov.dial_format} onValueChange={(v) => setProv({ ...prov, dial_format: v })}>
                <SelectTrigger id="p-fmt"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="LOCAL">01XXXXXXXXX</SelectItem><SelectItem value="E164">+8801XXXXXXXXX</SelectItem><SelectItem value="E164_NO_PLUS">8801XXXXXXXXX</SelectItem></SelectContent>
              </Select>
            </Field>
            <div className="flex flex-col justify-end gap-2 text-sm">
              <label className="flex items-center gap-2"><Switch checked={prov.trunk_register} onCheckedChange={(v) => setProv({ ...prov, trunk_register: v })} /> Register to the IPTSP</label>
              <label className="flex items-center gap-2"><Switch checked={prov.pbx_enabled} onCheckedChange={(v) => setProv({ ...prov, pbx_enabled: v })} /> PBX switched on</label>
            </div>
            <p className="text-xs text-muted-foreground sm:col-span-2">Changing the number, host or username sets the bridge back to "not ready" until you confirm it again.</p>
          </div>
        )}
      </FormDialog>

      <FormDialog open={!!grant} onOpenChange={(o) => !o && setGrant(null)} title={`Grant a package to ${grant?.business.name ?? ''}`} submitLabel="Grant"
        description="For Enterprise or offline payments. It replaces the current package from today." busy={doGrant.isPending} disabled={!grant?.package_id} onSubmit={() => doGrant.mutate()}>
        {grant && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Package" htmlFor="g-pkg">
              <Select value={grant.package_id} onValueChange={(v) => setGrant({ ...grant, package_id: v })}>
                <SelectTrigger id="g-pkg"><SelectValue /></SelectTrigger>
                <SelectContent>{data.packages.map((p) => <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>)}</SelectContent>
              </Select>
            </Field>
            <Field label="Months" htmlFor="g-m"><Input id="g-m" type="number" min={1} max={12} value={grant.months} onChange={(e) => setGrant({ ...grant, months: Number(e.target.value) || 1 })} /></Field>
            {pkg?.isCustom ? (
              <>
                <Field label="Agents" htmlFor="g-a"><Input id="g-a" type="number" min={1} value={grant.agents} onChange={(e) => setGrant({ ...grant, agents: Number(e.target.value) || 1 })} /></Field>
                <Field label="Concurrent calls" htmlFor="g-c"><Input id="g-c" type="number" min={1} value={grant.channels} onChange={(e) => setGrant({ ...grant, channels: Number(e.target.value) || 1 })} /></Field>
              </>
            ) : (
              <>
                <Field label="Extra agents" htmlFor="g-xa"><Input id="g-xa" type="number" min={0} value={grant.extra_agents} onChange={(e) => setGrant({ ...grant, extra_agents: Number(e.target.value) || 0 })} /></Field>
                <Field label="Extra channels" htmlFor="g-xc"><Input id="g-xc" type="number" min={0} value={grant.extra_channels} onChange={(e) => setGrant({ ...grant, extra_channels: Number(e.target.value) || 0 })} /></Field>
              </>
            )}
            <Field label="Amount received (tk)" htmlFor="g-amt"><Input id="g-amt" type="number" min={0} value={grant.amount_tk} onChange={(e) => setGrant({ ...grant, amount_tk: Number(e.target.value) || 0 })} /></Field>
            <Field label="Note" htmlFor="g-note"><Input id="g-note" value={grant.note} onChange={(e) => setGrant({ ...grant, note: e.target.value })} placeholder="e.g. paid by bank transfer" /></Field>
          </div>
        )}
      </FormDialog>

      <FormDialog open={!!adjust} onOpenChange={(o) => !o && setAdjust(null)} title={`Adjust balance — ${adjust?.business.name ?? ''}`} submitLabel="Add adjustment"
        description="Adds a ledger entry (positive to credit, negative to debit). Past entries are never changed." busy={doAdjust.isPending}
        disabled={!adjust || !Number(adjust.amount) || !adjust.note.trim()} onSubmit={() => doAdjust.mutate()}>
        {adjust && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Amount (tk)" htmlFor="a-amt"><Input id="a-amt" inputMode="decimal" value={adjust.amount} onChange={(e) => setAdjust({ ...adjust, amount: e.target.value })} placeholder="e.g. 100 or -2.5" /></Field>
            <Field label="Reason" htmlFor="a-note" required><Input id="a-note" value={adjust.note} onChange={(e) => setAdjust({ ...adjust, note: e.target.value })} /></Field>
          </div>
        )}
      </FormDialog>

      <FormDialog open={newName !== null} onOpenChange={(o) => !o && setNewName(null)} title="Add a business" submitLabel="Add" busy={create.isPending}
        disabled={!newName?.trim()} onSubmit={() => create.mutate()}>
        <Field label="Business name" htmlFor="b-name"><Input id="b-name" value={newName ?? ''} onChange={(e) => setNewName(e.target.value)} maxLength={120} /></Field>
      </FormDialog>
    </Card>
  )
}

function Members({ data }: { data: AdminOverview }) {
  const queryClient = useQueryClient()
  const primary = data.businesses.find((b) => b.isPrimary)?.id ?? ''
  const set = useMutation({
    mutationFn: ({ profileId, businessId }: { profileId: string; businessId: string }) => pbxSuperAdmin.setMember(profileId, businessId === primary ? null : businessId),
    onSuccess: () => { toast.success('Saved'); void queryClient.invalidateQueries({ queryKey: ['vd-admin'] }) },
    onError: (e) => toast.error((e as Error).message),
  })
  if (data.businesses.length < 2) return null
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Who works for which business</CardTitle><CardDescription>Staff manage and call only for their own business. Unassigned staff belong to this store.</CardDescription></CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader><TableRow><TableHead>Staff</TableHead><TableHead>Business</TableHead></TableRow></TableHeader>
          <TableBody>
            {data.staff.map((s) => (
              <TableRow key={s.profileId}>
                <TableCell>{s.name}<p className="text-xs text-muted-foreground">{s.email}</p></TableCell>
                <TableCell>
                  <Select value={s.businessId ?? primary} onValueChange={(v) => set.mutate({ profileId: s.profileId, businessId: v })}>
                    <SelectTrigger className="h-8 w-56"><SelectValue /></SelectTrigger>
                    <SelectContent>{data.businesses.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}</SelectContent>
                  </Select>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
