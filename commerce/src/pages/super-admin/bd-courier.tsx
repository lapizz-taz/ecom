import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { PlugZap, Search, Unplug } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { FormDialog } from '@/components/common/form-dialog'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { CourierHistoryTable } from '@/features/fraud/courier-history'
import { usePlatform } from '@/features/platform/platform-context'
import { UsagePolicyCard } from '@/features/platform/services/policy-card'
import { ChargingRules, GlobalSwitchCard, MerchantExceptions } from '@/features/platform/services/service-parts'
import { UsageReportPanel } from '@/features/platform/services/usage-report'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { connectBdCourier, disconnectBdCourier, serviceStatus, type ServiceStatus, testBdCourier } from '@/services/credits'
import { COURIER_HISTORY_SERVICES, type CourierHistoryResult, type CourierHistoryService } from '@/services/settings'

function ConnectDialog({ onClose, onDone }: { onClose: () => void; onDone: (r: CourierHistoryResult) => void }) {
  const [service, setService] = useState<CourierHistoryService>('bdcourier')
  const [apiKey, setApiKey] = useState('')
  const [phone, setPhone] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const connect = useMutation({
    meta: { silent: true },
    mutationFn: () => connectBdCourier({ service, api_key: apiKey.trim(), test_phone: phone.trim(), base_url: baseUrl.trim() || undefined }),
    onSuccess: (r) => { toast.success('BD Courier connected'); onDone(r.result as CourierHistoryResult); onClose() },
  })
  return (
    <FormDialog open onOpenChange={(o) => !o && onClose()} title="Connect the company's BD Courier account" submitLabel="Test and connect"
      description="The key is tried with a real lookup first (not charged to any merchant), then stored encrypted. It is never shown again."
      busy={connect.isPending} disabled={apiKey.trim().length < 6 || !phone.trim()} onSubmit={() => connect.mutate()}>
      <Field label="Service">
        <Select value={service} onValueChange={(v) => setService(v as CourierHistoryService)}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="bdcourier">BD Courier (api.bdcourier.com)</SelectItem><SelectItem value="llcg">LLCG courier fraud checker</SelectItem></SelectContent>
        </Select>
      </Field>
      <Field label="API key" required hint={COURIER_HISTORY_SERVICES[service].keyHint}>
        <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
      </Field>
      <Field label="Test with this number" required><Input inputMode="tel" placeholder="01XXXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      <Field label="Service address (optional)" hint="Leave empty for the standard address">
        <Input className="font-mono text-xs" placeholder={COURIER_HISTORY_SERVICES[service].url} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      </Field>
      {connect.error && <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-500" role="alert">{connect.error.message}</p>}
    </FormDialog>
  )
}

function Connection({ status }: { status: ServiceStatus }) {
  const { can } = usePlatform()
  const queryClient = useQueryClient()
  const c = status.config
  const [dialog, setDialog] = useState<'connect' | 'disconnect' | null>(null)
  const [phone, setPhone] = useState('')
  const [result, setResult] = useState<CourierHistoryResult | null>(null)
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['platform-service', 'BD_COURIER'] })
  const test = useMutation({
    meta: { silent: true },
    mutationFn: () => testBdCourier(phone.trim()),
    onSuccess: (r) => { setResult(r.result as CourierHistoryResult); refresh() },
    onError: () => { setResult(null); refresh() },
  })
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm">Company account {c.connected ? <Badge variant="success">Connected</Badge> : <Badge variant="danger">Not connected</Badge>}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {c.connected ? (
          <div className="space-y-1 text-sm">
            <p className="font-medium">{c.service ? COURIER_HISTORY_SERVICES[c.service as CourierHistoryService]?.label ?? c.service : 'BD Courier'}</p>
            <p className="text-muted-foreground">Key {c.hint ?? '••••'} · since {formatDateTime(c.connected_at)}</p>
            {c.last_test_at && (
              <p className={c.last_test_ok ? 'text-emerald-600' : 'text-red-500'}>Last test {timeAgo(c.last_test_at)}: {c.last_test_ok ? 'worked' : `failed — ${c.last_error ?? 'no detail'}`}</p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">Not connected. Checkouts use each store's own order history only. (A BDCOURIER_API_KEY function secret, if set, is used as a fallback.)</p>
        )}
        <div className="flex flex-wrap gap-2">
          {can('bd_courier', 'manage') && <Button size="sm" variant={c.connected ? 'outline' : 'default'} onClick={() => setDialog('connect')}><PlugZap /> {c.connected ? 'Change key' : 'Connect'}</Button>}
          {c.connected && can('bd_courier', 'manage') && <Button size="sm" variant="ghost" onClick={() => setDialog('disconnect')}><Unplug /> Disconnect</Button>}
        </div>
        {c.connected && can('bd_courier', 'edit') && (
          <form className="space-y-2 border-t pt-3" onSubmit={(e) => { e.preventDefault(); if (phone.trim()) test.mutate() }}>
            <p className="text-xs text-muted-foreground">Test the connection with a real lookup (recorded in the audit log, not charged to a merchant).</p>
            <div className="flex gap-2">
              <Input aria-label="Number to look up" inputMode="tel" placeholder="01XXXXXXXXX" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <Button type="submit" variant="outline" disabled={!phone.trim() || test.isPending}>{test.isPending ? <Spinner /> : <Search />} Test</Button>
            </div>
            {test.error && <p className="rounded-md bg-red-500/10 p-3 text-sm text-red-500" role="alert">{test.error.message}</p>}
            {result && <CourierHistoryTable result={result} className="max-w-xl" />}
          </form>
        )}
      </CardContent>
      {dialog === 'connect' && <ConnectDialog onClose={() => setDialog(null)} onDone={(r) => { setResult(r); refresh() }} />}
      <ConfirmDialog open={dialog === 'disconnect'} onOpenChange={(o) => !o && setDialog(null)} destructive confirmLabel="Disconnect" reason reasonRequired
        title="Disconnect the company's BD Courier account?" description="Every merchant's checkout falls back to its own order history. The saved key is erased."
        onConfirm={async () => {
          try { await disconnectBdCourier(); toast.success('Disconnected'); setResult(null); refresh() } catch (e) { toast.error((e as Error).message); throw e }
        }} />
    </Card>
  )
}

export default function BdCourierPage() {
  const [state, update] = useUrlState({ tab: 'overview' })
  const status = useQuery({ queryKey: ['platform-service', 'BD_COURIER'], queryFn: () => serviceStatus('BD_COURIER') })
  return (
    <div className="space-y-4">
      <PageHeader title="BD Courier Integration" description="The company's BD Courier account checks customers' delivery history for every merchant. Merchants no longer enter their own key; courier booking, tracking and their own courier accounts are unchanged." />
      {status.error ? <ErrorState error={status.error} onRetry={() => status.refetch()} /> : !status.data ? <LoadingState /> : (
        <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
          <TabsList>
            <TabsTrigger value="overview">Connection</TabsTrigger>
            <TabsTrigger value="policy">Free use and limits</TabsTrigger>
            <TabsTrigger value="merchants">Merchant access ({formatNumber(status.data.overrides.length + status.data.exceptions.length)})</TabsTrigger>
            <TabsTrigger value="usage">Usage and requests</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="grid gap-4 lg:grid-cols-2">
            <Connection status={status.data} />
            <div className="space-y-4">
              <GlobalSwitchCard service="BD_COURIER" status={status.data} />
              <ChargingRules service="BD_COURIER" />
            </div>
          </TabsContent>
          <TabsContent value="policy"><UsagePolicyCard key={JSON.stringify(status.data.policy)} service="BD_COURIER" status={status.data} /></TabsContent>
          <TabsContent value="merchants"><MerchantExceptions service="BD_COURIER" status={status.data} /></TabsContent>
          <TabsContent value="usage"><UsageReportPanel service="BD_COURIER" /></TabsContent>
        </Tabs>
      )}
    </div>
  )
}
