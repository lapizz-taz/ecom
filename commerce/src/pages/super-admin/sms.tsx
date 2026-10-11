import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Plug, RefreshCw, Send, Unplug, X } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { Field } from '@/components/common/field'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { usePlatform } from '@/features/platform/platform-context'
import { UsagePolicyCard } from '@/features/platform/services/policy-card'
import { ChargingRules, GlobalSwitchCard, MerchantExceptions } from '@/features/platform/services/service-parts'
import { UsageReportPanel } from '@/features/platform/services/usage-report'
import { ConnectSmsDialog, providerName, TestSmsDialog } from '@/features/sms/sms-provider'
import { useUrlState } from '@/hooks/use-url-state'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import {
  connectPlatformSms, disconnectPlatformSms, platformSmsBalance, platformSmsTest, saveSmsSettings, serviceStatus, type ServiceStatus,
} from '@/services/credits'
import type { SmsProviderCode } from '@/services/sms'

function Connection({ status }: { status: ServiceStatus }) {
  const queryClient = useQueryClient()
  const { can } = usePlatform()
  const [dialog, setDialog] = useState<'connect' | 'test' | 'disconnect' | null>(null)
  const c = status.config
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['platform-service', 'SMS'] })
  const balance = useMutation({
    mutationFn: platformSmsBalance,
    onSuccess: (r) => { toast.success(r.supported ? `Balance: ${r.balance}` : 'This provider has no balance check'); refresh() },
    onError: (e) => toast.error((e as Error).message),
  })
  return (
    <Card>
      <CardHeader><CardTitle className="flex items-center gap-2 text-sm">Provider account {c.connected ? <Badge variant="success">Connected</Badge> : <Badge variant="danger">Not connected</Badge>}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {c.connected ? (
          <div className="space-y-1 text-sm">
            <p className="font-medium">{providerName(c.provider)}</p>
            <p className="text-muted-foreground">Key {c.hint ?? '••••'} · default sender {c.sender_id || 'none'} · since {formatDateTime(c.connected_at)}</p>
            {status.credential?.updated_by && <p className="text-xs text-muted-foreground">Saved by {status.credential.updated_by}</p>}
            <p className="text-muted-foreground">Balance: {c.balance == null ? 'not checked' : `${c.balance}${c.balance_checked_at ? ` (${timeAgo(c.balance_checked_at)})` : ''}`}</p>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No provider account. Merchants' messages fail (and are refunded) until one is connected. The keys are tested, then kept encrypted on the server; nobody can read them back.</p>
        )}
        <div className="flex flex-wrap gap-2">
          {can('sms', 'manage') && <Button size="sm" variant={c.connected ? 'outline' : 'default'} onClick={() => setDialog('connect')}><Plug /> {c.connected ? 'Change' : 'Connect'}</Button>}
          {c.connected && <Button size="sm" variant="outline" disabled={balance.isPending} onClick={() => balance.mutate()}><RefreshCw /> Balance</Button>}
          {c.connected && can('sms', 'edit') && <Button size="sm" variant="outline" onClick={() => setDialog('test')}><Send /> Send a test</Button>}
          {c.connected && can('sms', 'manage') && <Button size="sm" variant="ghost" onClick={() => setDialog('disconnect')}><Unplug /> Disconnect</Button>}
        </div>
      </CardContent>
      {dialog === 'connect' && (
        <ConnectSmsDialog current={{ connected: c.connected, provider: (c.provider as SmsProviderCode) ?? null, sender_id: c.sender_id }}
          connect={connectPlatformSms} onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {dialog === 'test' && (
        <TestSmsDialog storeName="the platform" onClose={() => setDialog(null)} onSent={refresh} send={platformSmsTest}
          description="Sent from the platform account with the default sender. Not charged to any merchant; recorded in the audit log." />
      )}
      <ConfirmDialog open={dialog === 'disconnect'} onOpenChange={(o) => !o && setDialog(null)} destructive confirmLabel="Disconnect" reason reasonRequired
        title="Disconnect the platform SMS account?" description="Every merchant's SMS stops. Messages already queued fail and are refunded. The saved keys are erased."
        onConfirm={async () => {
          try { await disconnectPlatformSms(); toast.success('Disconnected'); refresh() } catch (e) { toast.error((e as Error).message); throw e }
        }} />
    </Card>
  )
}

function SenderAndPricing({ status }: { status: ServiceStatus }) {
  const queryClient = useQueryClient()
  const edit = status.can.edit
  const [ids, setIds] = useState<string[]>(status.config.sender_ids ?? [])
  const [next, setNext] = useState('')
  const [def, setDef] = useState(status.config.sender_id ?? '')
  const [cost, setCost] = useState(String(status.config.cost_per_segment ?? 0))
  const save = useMutation({
    mutationFn: () => saveSmsSettings({ sender_ids: ids, sender_id: def, cost_per_segment: Number(cost) || 0 }),
    onSuccess: () => { toast.success('Saved'); void queryClient.invalidateQueries({ queryKey: ['platform-service', 'SMS'] }) },
    onError: (e) => toast.error((e as Error).message),
  })
  const add = () => {
    const v = next.trim()
    if (v && /^[A-Za-z0-9 ._+-]{1,20}$/.test(v) && !ids.includes(v)) setIds([...ids, v])
    setNext('')
  }
  return (
    <Card>
      <CardHeader><CardTitle className="text-sm">Sender IDs and provider cost</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Approved sender IDs (as approved by the provider)</p>
          <div className="flex flex-wrap gap-1.5">
            {ids.length === 0 && <span className="text-sm text-muted-foreground">None listed — any sender typed for a merchant is allowed.</span>}
            {ids.map((s) => (
              <Badge key={s} variant="neutral">{s}{edit && <button type="button" aria-label={`Remove ${s}`} onClick={() => { setIds(ids.filter((x) => x !== s)); if (def === s) setDef('') }}><X /></button>}</Badge>
            ))}
          </div>
          {edit && (
            <div className="mt-2 flex gap-2">
              <Input aria-label="New sender ID" value={next} maxLength={20} placeholder="e.g. FULLFILIO" onChange={(e) => setNext(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add() } }} />
              <Button type="button" size="sm" variant="outline" onClick={add}>Add</Button>
            </div>
          )}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Default sender">
            <Select disabled={!edit} value={def || 'none'} onValueChange={(v) => setDef(v === 'none' ? '' : v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="none">Provider default</SelectItem>{ids.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
            </Select>
          </Field>
          <Field label="Provider cost per SMS part (BDT)" hint="For cost estimates where the provider does not report its charge">
            <Input type="number" min={0} step="0.01" disabled={!edit} value={cost} onChange={(e) => setCost(e.target.value)} />
          </Field>
        </div>
        {edit && <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>Save</Button>}
      </CardContent>
    </Card>
  )
}

export default function SmsManagementPage() {
  const [state, update] = useUrlState({ tab: 'overview' })
  const status = useQuery({ queryKey: ['platform-service', 'SMS'], queryFn: () => serviceStatus('SMS') })
  return (
    <div className="space-y-4">
      <PageHeader title="SMS Management" description="One provider account for every merchant. Merchants never see or enter provider credentials; they use free SMS and credits under the policy below." />
      {status.error ? <ErrorState error={status.error} onRetry={() => status.refetch()} /> : !status.data ? <LoadingState /> : (
        <Tabs value={state.tab} onValueChange={(tab) => update({ tab })}>
          <TabsList>
            <TabsTrigger value="overview">Provider</TabsTrigger>
            <TabsTrigger value="policy">Free use and charging</TabsTrigger>
            <TabsTrigger value="merchants">Merchants ({formatNumber(status.data.overrides.length + status.data.exceptions.length)})</TabsTrigger>
            <TabsTrigger value="usage">Usage and delivery</TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-4">
              <Connection status={status.data} />
              <GlobalSwitchCard service="SMS" status={status.data} />
            </div>
            <SenderAndPricing key={JSON.stringify(status.data.config.sender_ids)} status={status.data} />
          </TabsContent>
          <TabsContent value="policy" className="grid gap-4 lg:grid-cols-[1fr_24rem]">
            <UsagePolicyCard key={JSON.stringify(status.data.policy)} service="SMS" status={status.data} />
            <ChargingRules service="SMS" />
          </TabsContent>
          <TabsContent value="merchants"><MerchantExceptions service="SMS" status={status.data} /></TabsContent>
          <TabsContent value="usage"><UsageReportPanel service="SMS" /></TabsContent>
        </Tabs>
      )}
    </div>
  )
}
