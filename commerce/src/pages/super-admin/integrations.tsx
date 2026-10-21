import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, RotateCcw } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { Link } from 'react-router'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, EmptyState, ErrorState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUrlState } from '@/hooks/use-url-state'
import { toUserMessage } from '@/lib/errors'
import { formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import {
  clearMetaApp, type IntegrationsOverview, integrationsOverview, metaAppStatus, retryIntegration, saveMetaApp,
} from '@/services/integrations-hub'
import type { MerchantRef } from '@/services/platform'

const ok = (s: string | null | undefined) => /^(CONNECTED|ACTIVE|OK|online)$/i.test(s ?? '')
function State({ value, error }: { value: string | null | undefined; error?: boolean }) {
  const v = (value ?? 'unknown').toLowerCase()
  return <Badge variant={error || /error|failed|expired|revoked/.test(v) ? 'danger' : ok(value) ? 'success' : 'neutral'}>{v.replace(/_/g, ' ')}</Badge>
}
const M = ({ m }: { m: MerchantRef }) => <Link className="hover:underline" to={`/super-admin/merchants/${m.id}?tab=stores`}>#{m.number} {m.name}</Link>

function Platform({ p }: { p: IntegrationsOverview['platform'] }) {
  const row = (name: string, status: ReactNode, detail: ReactNode, to?: string) => (
    <TableRow key={name}><TableCell className="font-medium">{to ? <Link className="hover:underline" to={to}>{name}</Link> : name}</TableCell><TableCell>{status}</TableCell><TableCell className="text-xs text-muted-foreground">{detail}</TableCell></TableRow>
  )
  return (
    <Card className="gap-0 overflow-hidden py-0">
      <CardHeader className="border-b py-3"><CardTitle className="text-sm">The platform's own services</CardTitle></CardHeader>
      <Table>
        <TableBody>
          {row('SMS provider', <State value={p.sms.connected ? 'connected' : 'not connected'} error={!p.sms.connected} />,
            <>{p.sms.provider ?? '—'} · {formatNumber(p.sms.sent_24h)} sent, {formatNumber(p.sms.failed_24h)} failed in 24 h{p.sms.balance != null && ` · balance ${p.sms.balance}`}{p.sms.last_error && <> · last error: {p.sms.last_error}</>}</>, '/super-admin/sms')}
          {row('BD Courier', <State value={p.bd_courier.connected ? 'connected' : 'not connected'} error={!p.bd_courier.connected || p.bd_courier.last_test_ok === false} />,
            <>{formatNumber(p.bd_courier.succeeded_24h)} lookups, {formatNumber(p.bd_courier.failed_24h)} failed in 24 h{p.bd_courier.last_test_at && ` · last test ${timeAgo(p.bd_courier.last_test_at)} ${p.bd_courier.last_test_ok ? 'worked' : 'failed'}`}</>, '/super-admin/bd-courier')}
          {Object.entries(p.billing_gateways).map(([code, g]) => row(`Payments to the platform: ${code}`, <State value={g.connected ? (g.enabled ? 'connected' : 'switched off') : 'not connected'} />,
            <>{g.hint ?? ''}{g.sandbox ? ' · sandbox' : ''}</>, '/super-admin/subscriptions?tab=rules'))}
          {row('Cloud Calling gateway', <State value={p.pbx?.online ? 'online' : p.pbx?.last_seen_at ? 'offline' : 'never checked in'} error={!!p.pbx?.last_seen_at && !p.pbx?.online} />,
            <>{p.pbx?.version ?? ''}{p.pbx?.last_seen_at && ` · last check-in ${timeAgo(p.pbx.last_seen_at)}`}</>, '/super-admin/pbx?tab=gateway')}
          {row('AI services', <Badge variant="neutral">none</Badge>, p.ai.note)}
        </TableBody>
      </Table>
    </Card>
  )
}

export default function OtherIntegrationsPage() {
  const queryClient = useQueryClient()
  const [state, update] = useUrlState({ tab: 'stores' })
  const q = useQuery({ queryKey: ['platform-integrations'], queryFn: integrationsOverview, refetchInterval: 60_000 })
  const retry = useMutation({
    mutationFn: (v: { kind: 'store_jobs' | 'courier_events'; id: string }) => retryIntegration(v.kind, v.id),
    onSuccess: (r) => {
      toast.success(r.requeued != null ? `${r.requeued} job(s) queued again` : `${r.retried ?? 0} event(s) processed again`)
      void queryClient.invalidateQueries({ queryKey: ['platform-integrations'] })
    },
  })
  const d = q.data
  const storeErrors = d?.stores.filter((s) => s.status === 'ERROR' || s.failed_jobs > 0).length ?? 0
  const courierErrors = d?.couriers.filter((c) => c.failed_events_24h > 0 || /error|fail/i.test(c.api_status ?? '')).length ?? 0
  return (
    <div className="space-y-4">
      <PageHeader title="Other Integrations" description="Every merchant's stores, couriers, payment gateways and ad accounts, plus the platform's own services. Merchant credentials stay with the merchant; this shows state and errors, with safe retries." />
      {q.error ? <ErrorState error={q.error} onRetry={() => q.refetch()} /> : !d ? <CardsSkeleton count={4} /> : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatCard label="Stores connected" value={formatNumber(d.stores.length)} hint={`${storeErrors} with errors or failed jobs`} tone={storeErrors ? 'negative' : 'default'} />
            <StatCard label="Courier accounts" value={formatNumber(d.couriers.length)} hint={`${courierErrors} with failures`} tone={courierErrors ? 'warning' : 'default'} />
            <StatCard label="Merchant payment gateways" value={formatNumber(d.payments.length)} hint={`${d.payments.filter((p) => p.errors_24h > 0).length} with errors in 24 h`} />
            <StatCard label="Ad accounts" value={formatNumber(d.ads.length)} hint={`${d.ads.filter((a) => /error/i.test(a.status)).length} with errors`} />
          </div>
          <Platform p={d.platform} />
          <MetaAppCard />
          <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
            <TabsList>
              <TabsTrigger value="stores">Shopify & WooCommerce</TabsTrigger>
              <TabsTrigger value="couriers">Couriers</TabsTrigger>
              <TabsTrigger value="payments">Payment gateways</TabsTrigger>
              <TabsTrigger value="ads">Ads</TabsTrigger>
            </TabsList>
            <Card className="mt-3 gap-0 overflow-hidden py-0">
              <TabsContent value="stores" className="m-0">
                {d.stores.length === 0 ? <EmptyState title="No store connected" /> : (
                  <div className="overflow-x-auto"><Table>
                    <TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead>Store</TableHead><TableHead>Status</TableHead><TableHead>Last sync</TableHead><TableHead>Last order</TableHead><TableHead>Problems</TableHead><TableHead /></TableRow></TableHeader>
                    <TableBody>{d.stores.map((s) => (
                      <TableRow key={s.id}>
                        <TableCell className="text-sm"><M m={s.merchant} /></TableCell>
                        <TableCell className="text-xs">{s.platform.toLowerCase()} · {s.domain}</TableCell>
                        <TableCell><State value={s.status} /></TableCell>
                        <TableCell className="text-xs">{s.last_sync_at ? timeAgo(s.last_sync_at) : 'never'}</TableCell>
                        <TableCell className="text-xs">{s.last_order_at ? timeAgo(s.last_order_at) : '—'}</TableCell>
                        <TableCell className="max-w-72 text-xs">
                          {s.failed_jobs > 0 && <p className="text-red-500">{s.failed_jobs} failed sync job(s)</p>}
                          {s.overdue_jobs > 0 && <p className="text-amber-500">{s.overdue_jobs} waiting too long</p>}
                          {s.webhook_errors_24h > 0 && <p className="text-amber-500">{s.webhook_errors_24h} webhook error(s) in 24 h</p>}
                          {s.last_error && <p className="line-clamp-2 text-muted-foreground">{s.last_error}</p>}
                        </TableCell>
                        <TableCell className="text-right">{d.can.edit && s.failed_jobs > 0 && (
                          <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate({ kind: 'store_jobs', id: s.id })}><RotateCcw /> Retry jobs</Button>)}</TableCell>
                      </TableRow>))}</TableBody>
                  </Table></div>
                )}
              </TabsContent>
              <TabsContent value="couriers" className="m-0">
                {d.couriers.length === 0 ? <EmptyState title="No courier account connected" /> : (
                  <div className="overflow-x-auto"><Table>
                    <TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead>Courier</TableHead><TableHead>API</TableHead><TableHead>Last update from courier</TableHead><TableHead>Problems</TableHead><TableHead /></TableRow></TableHeader>
                    <TableBody>{d.couriers.map((c) => (
                      <TableRow key={c.id}>
                        <TableCell className="text-sm"><M m={c.merchant} /></TableCell>
                        <TableCell className="text-xs">{c.name}{c.provider && <span className="text-muted-foreground"> · {c.provider}</span>}</TableCell>
                        <TableCell><State value={c.api_status ?? (c.api_enabled ? 'connected' : 'off')} /></TableCell>
                        <TableCell className="text-xs">{c.last_event_at ? timeAgo(c.last_event_at) : 'none yet'}</TableCell>
                        <TableCell className="text-xs">
                          {c.failed_events_24h > 0 && <p className="text-red-500">{c.failed_events_24h} status update(s) failed in 24 h</p>}
                          {c.failed_bookings_7d > 0 && <p className="text-amber-500">{c.failed_bookings_7d} courier error(s) in 7 days</p>}
                        </TableCell>
                        <TableCell className="text-right">{d.can.edit && c.failed_events_24h > 0 && (
                          <Button size="sm" variant="outline" disabled={retry.isPending} onClick={() => retry.mutate({ kind: 'courier_events', id: c.id })}><RotateCcw /> Retry updates</Button>)}</TableCell>
                      </TableRow>))}</TableBody>
                  </Table></div>
                )}
              </TabsContent>
              <TabsContent value="payments" className="m-0">
                {d.payments.length === 0 ? <EmptyState title="No merchant takes online payments" description="Merchants' own bKash / PayStation accounts for customer advances appear here." /> : (
                  <Table>
                    <TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead>Gateways on</TableHead><TableHead>Callbacks in 24 h</TableHead><TableHead>Last callback</TableHead><TableHead>Errors in 24 h</TableHead></TableRow></TableHeader>
                    <TableBody>{d.payments.map((p) => (
                      <TableRow key={p.merchant.id}>
                        <TableCell className="text-sm"><M m={p.merchant} /></TableCell>
                        <TableCell className="text-xs">{p.providers.join(', ')}</TableCell>
                        <TableCell className="text-xs tabular-nums">{formatNumber(p.events_24h)}</TableCell>
                        <TableCell className="text-xs">{p.last_event_at ? timeAgo(p.last_event_at) : 'none yet'}</TableCell>
                        <TableCell className={p.errors_24h ? 'text-xs text-red-500' : 'text-xs'}>{formatNumber(p.errors_24h)}</TableCell>
                      </TableRow>))}</TableBody>
                  </Table>
                )}
              </TabsContent>
              <TabsContent value="ads" className="m-0">
                {d.ads.length === 0 ? <EmptyState title="No ad account connected" /> : (
                  <Table>
                    <TableHeader><TableRow><TableHead>Merchant</TableHead><TableHead>Platform</TableHead><TableHead>Account</TableHead><TableHead>Status</TableHead><TableHead>Last error</TableHead></TableRow></TableHeader>
                    <TableBody>{d.ads.map((a, i) => (
                      <TableRow key={`${a.merchant.id}-${a.platform}-${i}`}>
                        <TableCell className="text-sm"><M m={a.merchant} /></TableCell>
                        <TableCell className="text-xs">{a.platform.toLowerCase()}</TableCell>
                        <TableCell className="text-xs">{a.name ?? '—'}</TableCell>
                        <TableCell><State value={a.status} /></TableCell>
                        <TableCell className="max-w-72 text-xs text-muted-foreground"><span className="line-clamp-2">{a.last_error ?? ''}</span></TableCell>
                      </TableRow>))}</TableBody>
                  </Table>
                )}
              </TabsContent>
            </Card>
          </Tabs>
          <p className="text-xs text-muted-foreground">
            Retries hand failed work back to the normal job queue; each job and courier update is applied once even if retried. To test a merchant's own connection, open a customer view from Support & Issues — their credentials are never used from here.
          </p>
        </>
      )}
    </div>
  )
}

function CopyValue({ label, value }: { label: string; value: string }) {
  const [done, setDone] = useState(false)
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 rounded-[10px] border bg-muted/40 px-2.5 py-1.5">
        <code className="min-w-0 flex-1 truncate text-xs">{value}</code>
        <Button size="icon-sm" variant="ghost" className="size-6" aria-label={`Copy ${label}`}
          onClick={() => void navigator.clipboard.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500) }).catch(() => undefined)}>
          {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  )
}

/** The one Meta app every store connects through ("Continue with Facebook" in Messaging). */
function MetaAppCard() {
  const qc = useQueryClient()
  const status = useQuery({ queryKey: ['platform-meta-app'], queryFn: metaAppStatus })
  const [form, setForm] = useState<{ app_id: string; app_secret: string; login_config_id: string; business_config_id: string; whatsapp_config_id: string } | null>(null)
  const [clearing, setClearing] = useState(false)
  const done = () => void qc.invalidateQueries({ queryKey: ['platform-meta-app'] })
  const save = useMutation({
    mutationFn: (newToken: boolean) => saveMetaApp({ ...form!, new_verify_token: newToken }),
    onSuccess: (r) => { toast.success(`Saved${r.name ? `: ${r.name}` : ''}`); setForm(null); done() },
    onError: (e) => toast.error(toUserMessage(e)),
  })
  const s = status.data
  if (status.error) return <ErrorState error={status.error} onRetry={() => status.refetch()} />
  if (!s) return null
  const saved = !!(s.app_id && s.has_secret && s.login_config_id)
  const edit = () => setForm({
    app_id: s.app_id ?? '', app_secret: '', login_config_id: s.login_config_id ?? '', business_config_id: s.business_config_id ?? '', whatsapp_config_id: s.whatsapp_config_id ?? '',
  })

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-sm">Meta app (Messaging)</CardTitle>
          <CardDescription>Stores connect Facebook Pages, Instagram and WhatsApp through this app with “Continue with Facebook”. The App Secret is kept encrypted and never shown.</CardDescription>
        </div>
        <Badge variant={saved ? 'success' : 'neutral'}>{saved ? (s.whatsapp_config_id ? 'Pages, Instagram & WhatsApp' : 'Pages & Instagram') : 'Not set up'}</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        {form ? (
          <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); save.mutate(false) }}>
            <div className="space-y-1.5"><Label htmlFor="meta-app-id">App ID</Label><Input id="meta-app-id" value={form.app_id} inputMode="numeric" onChange={(e) => setForm({ ...form, app_id: e.target.value.trim() })} placeholder="1653473169830242" /></div>
            <div className="space-y-1.5"><Label htmlFor="meta-app-secret">App Secret</Label><Input id="meta-app-secret" type="password" autoComplete="off" value={form.app_secret} onChange={(e) => setForm({ ...form, app_secret: e.target.value.trim() })} placeholder={s.has_secret ? 'Saved — paste only to change' : 'From App settings → Basic'} /></div>
            <div className="space-y-1.5"><Label htmlFor="meta-login-config">Login for Business configuration ID</Label><Input id="meta-login-config" value={form.login_config_id} inputMode="numeric" onChange={(e) => setForm({ ...form, login_config_id: e.target.value.trim() })} placeholder="911022668675556" /></div>
            <div className="space-y-1.5"><Label htmlFor="meta-business-config">Business login configuration ID (optional, “Connect using Business”)</Label><Input id="meta-business-config" value={form.business_config_id} inputMode="numeric" onChange={(e) => setForm({ ...form, business_config_id: e.target.value.trim() })} placeholder="System-user token configuration" /></div>
            <div className="space-y-1.5"><Label htmlFor="meta-wa-config">WhatsApp Embedded Signup configuration ID (optional)</Label><Input id="meta-wa-config" value={form.whatsapp_config_id} inputMode="numeric" onChange={(e) => setForm({ ...form, whatsapp_config_id: e.target.value.trim() })} placeholder="After Tech Provider approval" /></div>
            <div className="flex gap-2 sm:col-span-2">
              <Button type="submit" disabled={save.isPending || !form.app_id || !form.login_config_id || (!form.app_secret && !s.has_secret)}>{save.isPending && <Spinner />} Check with Meta & save</Button>
              <Button type="button" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-sm">
            <span>App ID <span className="font-mono">{s.app_id ?? '—'}</span></span>
            <span>Login configuration <span className="font-mono">{s.login_config_id ?? '—'}</span></span>
            <span>Business login <span className="font-mono">{s.business_config_id ?? 'not yet'}</span></span>
            <span>WhatsApp configuration <span className="font-mono">{s.whatsapp_config_id ?? 'not yet'}</span></span>
            {s.can_manage && (
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="outline" onClick={edit}>{saved ? 'Change' : 'Set up'}</Button>
                {saved && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setClearing(true)}>Remove</Button>}
              </span>
            )}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <CopyValue label="Valid OAuth redirect URI (Facebook Login for Business → Settings)" value={s.redirect_uri} />
          <CopyValue label="Webhook callback URL (Webhooks → Page, Instagram, WhatsApp)" value={s.webhook_url} />
          {s.verify_token && <CopyValue label="Webhook verify token" value={s.verify_token} />}
        </div>
      </CardContent>
      <ConfirmDialog open={clearing} onOpenChange={setClearing} destructive title="Remove the Meta app?"
        description="Stores can no longer connect, and messages stop arriving for every connected Page, Instagram account and WhatsApp number until it is saved again."
        confirmLabel="Remove" onConfirm={async () => { await clearMetaApp(); toast.success('Removed'); done() }} />
    </Card>
  )
}
