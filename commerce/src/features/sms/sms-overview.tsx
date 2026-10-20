import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, Plus, Send, Wallet } from 'lucide-react'
import { useState } from 'react'
import { toast } from '@/lib/toast'
import { type Column, DataTable } from '@/components/common/data-table'
import { DateRangeFilter } from '@/components/common/date-range-filter'
import { Money } from '@/components/common/money'
import { StatCard } from '@/components/common/stat-card'
import { EmptyState, LoadingState, Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { AddSmsBalanceDialog } from '@/features/billing/billing-payments'
import { useStoreConfig } from '@/hooks/use-store-config'
import { useUrlState } from '@/hooks/use-url-state'
import { rangeFor } from '@/lib/dates'
import { formatMoney, formatNumber, formatPercent, isoDateToday } from '@/lib/format'
import { type SmsOverview, smsOverview, updateSmsSettings } from '@/services/sms'
import { TestSmsDialog } from './sms-provider'
import { eventLabel } from './sms-text'

export function useSmsOverview(from: string, to: string) {
  return useQuery({ queryKey: ['sms-overview', from, to], placeholderData: keepPreviousData, queryFn: () => smsOverview(from, to) })
}

/** The SMS service, the on/off switch and what SMS cost in a period. */
export function SmsOverviewTab() {
  const initial = rangeFor('30d')
  const [state, update] = useUrlState({ from: initial.from, to: initial.to })
  const overview = useSmsOverview(state.from, state.to)
  if (overview.isLoading) return <LoadingState />
  if (!overview.data) return <EmptyState title="Could not load SMS" description={(overview.error as Error | null)?.message} />
  const { totals, settings } = overview.data
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
        <StatCard label="SMS cost" value={formatMoney(totals.cost)} hint={totals.sent ? `${formatMoney(totals.cost / totals.sent)} per message · free SMS count as 0 · in Finance` : 'Recorded in Finance → Expenses'} />
        <StatCard label="Delivered" value={reported ? formatPercent((100 * totals.delivered) / reported) : '—'}
          hint={reported || totals.awaiting_report ? `${formatNumber(totals.delivered)} delivered · ${formatNumber(totals.awaiting_report)} waiting for a report` : 'Shown when delivery reports come back'} />
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

/** The SMS page's header: the SMS balance, buying more (bKash, PayStation, SSLCommerz) and a quick SMS to anyone. */
export function SmsHeaderActions() {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const { data: config } = useStoreConfig()
  const today = isoDateToday()
  const overview = useSmsOverview(today, today)
  const [dialog, setDialog] = useState<'buy' | 'quick' | null>(null)
  if (!overview.data) return null
  const { usage: u, settings: s } = overview.data
  const canPay = can('sms.manage') || can('settings.manage')
  const available = u.feature_enabled && s.connected
  return (
    <>
      <span className="inline-flex h-9 items-center gap-2 rounded-[10px] border bg-card px-3 text-sm">
        <Wallet className="size-4 text-muted-foreground" />
        <span className="text-muted-foreground">Balance</span>
        <span className="font-semibold tabular-nums">{u.unmetered ? 'Included' : `${formatNumber(u.credits_available)} SMS`}</span>
        {!u.unmetered && u.free.eligible && u.free.remaining > 0 && (
          <span className="text-xs text-muted-foreground">+ {formatNumber(u.free.remaining)} free</span>
        )}
      </span>
      {!u.unmetered && canPay && <Button onClick={() => setDialog('buy')}><Plus /> Add SMS Balance</Button>}
      {can('sms.manage') && (
        <Button variant="outline" disabled={!available} title={available ? undefined : 'SMS is not available right now'} onClick={() => setDialog('quick')}>
          <Send /> Quick SMS
        </Button>
      )}
      {dialog === 'buy' && <AddSmsBalanceDialog onClose={() => setDialog(null)} />}
      {dialog === 'quick' && (
        <TestSmsDialog quick storeName={config?.store.name ?? ''} onClose={() => setDialog(null)}
          onSent={() => {
            void queryClient.invalidateQueries({ queryKey: ['sms-overview'] })
            void queryClient.invalidateQueries({ queryKey: ['sms-messages'] })
          }}
          description="Goes out right away through the platform SMS service, from your sender name. Logged under Messages and charged like any other SMS (free SMS first, then your balance)." />
      )}
    </>
  )
}

/** The platform's SMS service for this business: on/off, sender, free SMS, balance and the price per SMS. */
function ConnectionCard({ overview }: { overview: SmsOverview }) {
  const { can } = useAuth()
  const queryClient = useQueryClient()
  const s = overview.settings
  const u = overview.usage
  const manage = can('sms.manage')
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['sms-overview'] })
    void queryClient.invalidateQueries({ queryKey: ['sms-messages'] })
  }
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => updateSmsSettings({ enabled }),
    onSuccess: (_, enabled) => { toast.success(enabled ? 'Automatic SMS is on' : 'Automatic SMS is off'); refresh() },
  })
  const available = u.feature_enabled && s.connected
  const unit = u.unit === 'MESSAGE' ? 'message' : 'SMS part'

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            SMS service {available ? <Badge variant="success">Available</Badge> : <Badge variant="neutral">{u.feature_enabled ? 'Temporarily unavailable' : 'Not in your plan'}</Badge>}
          </CardTitle>
          <CardDescription>Provided by the platform — no provider account needed.{s.sender_id ? ` Messages come from ${s.sender_id}.` : ''}</CardDescription>
        </div>
        <label className="flex items-center gap-2 text-sm font-medium">
          <Switch checked={s.enabled} disabled={!manage || toggle.isPending || (!available && !s.enabled)} onCheckedChange={(v) => toggle.mutate(v)} aria-label="Automatic SMS" />
          Automatic SMS {s.enabled ? 'on' : 'off'}
        </label>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <p className="text-xs text-muted-foreground">SMS balance</p>
            <p className="text-lg font-semibold tabular-nums">{u.unmetered ? 'Included' : `${formatNumber(u.credits_available)} SMS`}</p>
            <p className="text-xs text-muted-foreground">
              {u.unmetered ? 'Your plan includes SMS' : u.credits_per_unit === 1 && u.unit !== 'MESSAGE' ? 'One SMS: 160 characters, or 70 with Bangla' : `${u.credits_per_unit} SMS per ${unit}`}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Free SMS</p>
            <p className="text-lg font-semibold tabular-nums">{u.unmetered ? '—' : u.free.eligible ? formatNumber(u.free.remaining) : '0'}</p>
            <p className="text-xs text-muted-foreground">
              {u.unmetered ? 'Not needed on your plan' : u.free.eligible ? `left${u.free.period === 'MONTH' ? ' this month' : ''}, used before your balance` : 'No free SMS on your plan'}
            </p>
          </div>
          {!u.unmetered && (
            <div>
              <p className="text-xs text-muted-foreground">Price per SMS</p>
              <p className="text-lg font-semibold tabular-nums">{formatMoney(s.cost_per_sms)}</p>
              <p className="text-xs text-muted-foreground">Set by the platform; shown in Finance</p>
            </div>
          )}
        </div>
        {overview.totals.waiting_credits > 0 && (
          <p className="text-sm text-amber-600">
            {formatNumber(overview.totals.waiting_credits)} message{overview.totals.waiting_credits === 1 ? ' is' : 's are'} waiting for SMS balance. They go out as soon as you add balance (within {overview.policy.hold_hours} hours, then they fail without charge).
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Charged when the provider accepts a message. Messages the provider rejects are refunded{overview.policy.refund_undelivered ? ', and so are messages reported undelivered' : ''}. Retries are never charged twice.
        </p>
      </CardContent>
    </Card>
  )
}
