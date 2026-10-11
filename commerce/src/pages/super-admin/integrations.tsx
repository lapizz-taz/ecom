import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { RotateCcw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { StatCard } from '@/components/common/stat-card'
import { CardsSkeleton, EmptyState, ErrorState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useUrlState } from '@/hooks/use-url-state'
import { formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { type IntegrationsOverview, integrationsOverview, retryIntegration } from '@/services/integrations-hub'
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
          {row('VoiceDrive PBX gateway', <State value={p.pbx?.online ? 'online' : p.pbx?.last_seen_at ? 'offline' : 'never checked in'} error={!!p.pbx?.last_seen_at && !p.pbx?.online} />,
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
