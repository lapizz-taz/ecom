import { useQuery } from '@tanstack/react-query'
import { Activity, CheckCircle2, CircleDashed, RefreshCw, TriangleAlert, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { PageHeader } from '@/components/common/page-header'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/auth-context'
import { formatDateTime, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type HealthState, pingFunction, systemStatus } from '@/services/support'

const FUNCTIONS = [
  { name: 'checkout', label: 'Checkout' }, { name: 'courier', label: 'Courier booking' }, { name: 'courier-webhook', label: 'Courier webhooks' },
  { name: 'payments', label: 'Payments' }, { name: 'payment-webhook', label: 'Payment callbacks' }, { name: 'channels', label: 'Shopify / WooCommerce' },
  { name: 'sms', label: 'SMS' }, { name: 'notifications-dispatch', label: 'Message sender' }, { name: 'fraud-check', label: 'Fraud check' },
  { name: 'site-api', label: 'Website API' }, { name: 'pbx', label: 'PBX' },
]
const STATE: Record<HealthState, { label: string; icon: ReactNode; badge: 'success' | 'warning' | 'danger' | 'neutral'; bar: string }> = {
  ok: { label: 'Operational', icon: <CheckCircle2 className="size-5 text-emerald-600" />, badge: 'success', bar: 'bg-emerald-500' },
  warn: { label: 'Needs a look', icon: <TriangleAlert className="size-5 text-amber-600" />, badge: 'warning', bar: 'bg-amber-500' },
  down: { label: 'Problem', icon: <XCircle className="size-5 text-red-600" />, badge: 'danger', bar: 'bg-red-500' },
  idle: { label: 'Not in use yet', icon: <CircleDashed className="size-5 text-muted-foreground" />, badge: 'neutral', bar: 'bg-zinc-300' },
}
const LINKS: Record<string, string> = {
  store_sync: '/admin/store/sync', channels: '/admin/channels', courier_webhooks: '/admin/couriers?tab=webhooks', messages: '/admin/sms',
  errors: '/admin/system-logs', payments: '/admin/settings?tab=payments',
}

export default function SystemStatusPage() {
  const { can } = useAuth()
  const status = useQuery({ queryKey: ['system-status'], queryFn: systemStatus, enabled: can('settings.view'), refetchInterval: 60_000 })
  const pings = useQuery({
    queryKey: ['function-pings'], refetchInterval: 120_000,
    queryFn: () => Promise.all(FUNCTIONS.map(async (f) => ({ ...f, ...(await pingFunction(f.name)) }))),
  })
  const components = status.data?.components ?? []
  const fnDown = (pings.data ?? []).filter((p) => !p.ok).length
  const worst: HealthState = components.some((c) => c.status === 'down') || fnDown > 0 ? 'down' : components.some((c) => c.status === 'warn') ? 'warn' : 'ok'
  const loading = status.isLoading || pings.isLoading

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title="System Status" description="Live health of the database, background jobs, webhooks and server functions."
        actions={<Button variant="outline" size="sm" onClick={() => { void status.refetch(); void pings.refetch() }} disabled={status.isFetching || pings.isFetching}>
          <RefreshCw className={cn((status.isFetching || pings.isFetching) && 'animate-spin')} /> Check again</Button>} />

      {loading ? <LoadingState label="Checking every part of the system…" /> : (
        <>
          <Card className={cn('flex-row items-center gap-4 p-5', worst === 'ok' ? 'border-emerald-200' : worst === 'warn' ? 'border-amber-200' : 'border-red-200')}>
            <span className={cn('flex size-12 items-center justify-center rounded-full', worst === 'ok' ? 'bg-emerald-50' : worst === 'warn' ? 'bg-amber-50' : 'bg-red-50')}>
              {STATE[worst].icon}
            </span>
            <div>
              <p className="text-lg font-semibold">{worst === 'ok' ? 'All systems operational' : worst === 'warn' ? 'Working, with something to check' : 'Part of the system has a problem'}</p>
              <p className="text-sm text-muted-foreground">Checked {status.data ? timeAgo(status.data.checked_at) : 'just now'} · refreshes every minute</p>
            </div>
          </Card>

          {status.error ? <ErrorState error={status.error} onRetry={() => status.refetch()} /> : can('settings.view') && (
            <Card>
              <CardHeader><CardTitle className="text-base">Services</CardTitle><CardDescription>From the database: jobs, webhooks, messages and errors in the last 24 hours.</CardDescription></CardHeader>
              <CardContent className="divide-y p-0">
                {components.map((c) => (
                  <div key={c.key} className="flex items-center gap-3 px-6 py-3">
                    {STATE[c.status].icon}
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{c.name}</p>
                      <p className="truncate text-xs text-muted-foreground">{c.detail}{c.at && <span title={formatDateTime(c.at)}> · last {timeAgo(c.at)}</span>}</p>
                    </div>
                    <Badge variant={STATE[c.status].badge}>{STATE[c.status].label}</Badge>
                    {LINKS[c.key] && (c.status === 'warn' || c.status === 'down') && <Button size="sm" variant="ghost" asChild><Link to={LINKS[c.key]}>Open</Link></Button>}
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Activity className="size-4" /> Server functions</CardTitle>
              <CardDescription>Each function is reached from your browser right now.</CardDescription></CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {(pings.data ?? []).map((p) => (
                <div key={p.name} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
                  <span className={cn('size-2 rounded-full', p.ok ? 'bg-emerald-500' : 'bg-red-500')} />
                  <span className="flex-1">{p.label}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">{p.ok ? `${p.ms} ms` : 'unreachable'}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}
