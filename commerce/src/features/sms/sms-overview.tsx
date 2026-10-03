import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Plug, RefreshCw, Send, Unplug } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { ConfirmDialog } from '@/components/common/confirm-dialog'
import { type Column, DataTable } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Field } from '@/components/common/field'
import { Money } from '@/components/common/money'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { useStoreConfig } from '@/hooks/use-store-config'
import { useUrlState } from '@/hooks/use-url-state'
import { rangeFor } from '@/lib/dates'
import { formatDateTime, formatMoney, formatNumber, formatPercent } from '@/lib/format'
import { disconnectSms, refreshSmsBalance, type SmsOverview, smsOverview, updateSmsSettings } from '@/services/sms'
import { ConnectSmsDialog, providerName, SMS_PROVIDERS, TestSmsDialog } from './sms-provider'
import { eventLabel } from './sms-text'

export function useSmsOverview(from: string, to: string) {
  return useQuery({ queryKey: ['sms-overview', from, to], placeholderData: keepPreviousData, queryFn: () => smsOverview(from, to) })
}

/** Provider connection, the on/off switch and what SMS cost in a period. */
export function SmsOverviewTab() {
  const initial = rangeFor('30d')
  const [state, update] = useUrlState({ from: initial.from, to: initial.to })
  const overview = useSmsOverview(state.from, state.to)
  if (overview.isLoading) return <LoadingState />
  if (!overview.data) return <EmptyState title="Could not load SMS" description={(overview.error as Error | null)?.message} />
  const { totals, settings } = overview.data
  const reports = SMS_PROVIDERS.find((p) => p.code === settings.provider)?.reports ?? false
  const reported = totals.delivered + totals.undelivered

  const columns: Column<SmsOverview['by_event'][number]>[] = [
    { key: 'event', header: 'Message', primary: true, cell: (r) => <span className="font-medium">{eventLabel(r.event)}</span> },
    { key: 'sent', header: 'Sent', align: 'right', cell: (r) => formatNumber(r.sent) },
    { key: 'failed', header: 'Failed', align: 'right', cell: (r) => (r.failed ? <span className="text-red-600">{formatNumber(r.failed)}</span> : '0') },
    { key: 'parts', header: 'SMS parts', align: 'right', hideOnMobile: true, cell: (r) => formatNumber(r.parts) },
    { key: 'cost', header: 'Cost', align: 'right', cell: (r) => <Money value={r.cost} /> },
  ]

  return (
    <div className="space-y-4">
      <ConnectionCard overview={overview.data} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DateRangeFilter value={{ from: state.from, to: state.to }} onChange={(r) => update(r)} />
        {overview.isFetching && <Spinner />}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Messages sent" value={formatNumber(totals.sent)} hint={`${formatNumber(totals.orders)} ${totals.orders === 1 ? 'order' : 'orders'} · ${formatNumber(totals.parts)} SMS parts`} />
        <StatCard label="SMS cost" value={formatMoney(totals.cost)} hint={totals.sent ? `${formatMoney(totals.cost / totals.sent)} per message · in Finance` : 'Recorded in Finance → Expenses'} />
        <StatCard label="Delivered" value={reports && reported ? formatPercent((100 * totals.delivered) / reported) : '—'}
          hint={reports ? `${formatNumber(totals.delivered)} delivered · ${formatNumber(totals.awaiting_report)} waiting for a report` : 'This provider does not report delivery'} />
        <StatCard label="Failed" value={formatNumber(totals.failed)} tone={totals.failed ? 'negative' : 'default'}
          to={totals.failed ? '/admin/sms?tab=messages&status=FAILED' : undefined}
          hint={`${formatNumber(totals.waiting)} waiting · ${formatNumber(totals.skipped)} not sent`} />
      </div>
      <DataTable columns={columns} rows={overview.data.by_event} rowKey={(r) => r.event}
        empty={<EmptyState icon={<MessageSquare className="size-5" />} title="No SMS in this period"
          description={settings.enabled ? 'Messages appear here as orders move along.' : 'Turn on automatic SMS above, then choose which messages go out under Automations.'} />} />
    </div>
  )
}

function ConnectionCard({ overview }: { overview: SmsOverview }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const { data: config } = useStoreConfig()
  const s = overview.settings
  const manage = can('sms.manage')
  const [dialog, setDialog] = useState<'connect' | 'test' | 'disconnect' | null>(null)
  const [cost, setCost] = useState(String(s.cost_per_sms))
  const [currency, setCurrency] = useState(s.currency_text)
  useEffect(() => { setCost(String(s.cost_per_sms)); setCurrency(s.currency_text) }, [s.cost_per_sms, s.currency_text])
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['sms-overview'] })
    void queryClient.invalidateQueries({ queryKey: ['sms-messages'] })
  }

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateSmsSettings({ enabled }),
    onSuccess: (_, enabled) => { toast.success(enabled ? 'Automatic SMS is on' : 'Automatic SMS is off'); refresh() },
  })
  const saveCosts = useMutation({
    mutationFn: () => updateSmsSettings({ costPerSms: Number(cost), currencyText: currency }),
    onSuccess: () => { toast.success('Saved'); refresh() },
  })
  const balance = useMutation({
    mutationFn: refreshSmsBalance,
    onSuccess: (r) => { if (!r.supported) toast.info('This provider has no balance check'); refresh() },
  })
  const costDirty = Number(cost) !== Number(s.cost_per_sms) || currency !== s.currency_text

  if (!s.connected) {
    return (
      <Card>
        <CardContent className="flex flex-col gap-3 py-6 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium">Connect an SMS provider</p>
            <p className="text-sm text-muted-foreground">Alpha SMS, BulkSMSBD, SSL Wireless or any provider with an HTTP API. Then choose which messages go out automatically.</p>
          </div>
          {manage && <Button onClick={() => setDialog('connect')}><Plug /> Connect</Button>}
        </CardContent>
        {dialog === 'connect' && <ConnectSmsDialog current={s} onClose={() => setDialog(null)} onDone={refresh} />}
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            {providerName(s.provider)} <Badge variant="success">Connected</Badge>
          </CardTitle>
          <CardDescription>
            Key {s.hint ?? '••••'}{s.sender_id ? ` · sender ${s.sender_id}` : ''}{s.connected_at ? ` · since ${formatDateTime(s.connected_at)}` : ''}
          </CardDescription>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch checked={s.enabled} disabled={!manage || toggle.isPending} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Automatic SMS" />
          Automatic SMS {s.enabled ? 'on' : 'off'}
        </label>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">Balance</p>
            <p className="flex items-center gap-1 text-lg font-semibold tabular-nums">
              {s.balance === null || s.balance === undefined ? '—' : formatNumber(s.balance, 2)}
              {manage && (
                <Button size="icon-sm" variant="ghost" aria-label="Check balance" disabled={balance.isPending} onClick={() => balance.mutate()}>
                  {balance.isPending ? <Spinner /> : <RefreshCw />}
                </Button>
              )}
            </p>
            <p className="text-xs text-muted-foreground">{s.balance_checked_at ? `Checked ${formatDateTime(s.balance_checked_at)}` : 'Not checked'}</p>
          </div>
          <Field label="Cost per SMS" htmlFor="sms-cost" hint="What one SMS part costs you. Used until the provider reports the charge.">
            <Input id="sms-cost" type="number" min={0} max={20} step="0.01" value={cost} disabled={!manage} onChange={(e) => setCost(e.target.value)} />
          </Field>
          <Field label="Money written as" htmlFor="sms-currency" hint={currency.includes('৳') ? '৳ makes every message Unicode: 70 characters per SMS.' : 'e.g. "Tk 1,250" — keeps messages at 160 characters per SMS.'}>
            <Input id="sms-currency" value={currency} maxLength={6} disabled={!manage} onChange={(e) => setCurrency(e.target.value)} />
          </Field>
        </div>
        {manage && (
          <div className="flex flex-wrap gap-2 md:justify-end">
            {costDirty && (
              <Button onClick={() => saveCosts.mutate()} disabled={saveCosts.isPending || !(Number(cost) >= 0)}>{saveCosts.isPending && <Spinner />} Save</Button>
            )}
            <Button variant="outline" onClick={() => setDialog('test')}><Send /> Send test</Button>
            <Button variant="outline" onClick={() => setDialog('connect')}><Plug /> Change</Button>
            <Button variant="ghost" onClick={() => setDialog('disconnect')}><Unplug /> Disconnect</Button>
          </div>
        )}
      </CardContent>
      {dialog === 'connect' && <ConnectSmsDialog current={s} onClose={() => setDialog(null)} onDone={refresh} />}
      {dialog === 'test' && <TestSmsDialog storeName={config?.store.name ?? ''} onClose={() => setDialog(null)} onSent={refresh} />}
      <ConfirmDialog open={dialog === 'disconnect'} onOpenChange={(o) => !o && setDialog(null)} title="Disconnect the SMS provider?" destructive
        confirmLabel="Disconnect" description="Automatic SMS turns off and the saved keys are erased. Messages already waiting will fail until you connect again."
        onConfirm={async () => { await disconnectSms(); toast.success('Disconnected'); refresh() }} />
    </Card>
  )
}
