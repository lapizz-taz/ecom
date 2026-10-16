import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Loader2, RefreshCw, RotateCw, Truck, Webhook } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { toast } from '@/lib/toast'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAuth } from '@/features/auth/auth-context'
import { formatDateTime, formatNumber, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  type CheckOutcome, courierAutomation, type CourierSyncRun, forceCheckBatch, retryFailedCourierWebhooks, saveCourierSync,
} from '@/services/couriers'

const EVERY = [
  { value: 30, label: 'Every 30 minutes' }, { value: 60, label: 'Every hour' }, { value: 120, label: 'Every 2 hours' },
  { value: 360, label: 'Every 6 hours' }, { value: 720, label: 'Twice a day' }, { value: 1440, label: 'Once a day' },
]
const SCOPE = { all: 'Update courier status', shipped: 'Force check shipped orders' } as const

/**
 * Settings → Advanced → Courier automation. Webhooks normally move parcels by
 * themselves; this checks every parcel with its courier on a schedule, forces a
 * check now (with progress), retries webhooks that failed and keeps a log.
 */
export function CourierAutomation() {
  const { can } = useAuth()
  const manage = can('shipments.manage')
  const queryClient = useQueryClient()
  const overview = useQuery({ queryKey: ['courier-automation'], queryFn: courierAutomation })
  const [auto, setAuto] = useState(false)
  const [every, setEvery] = useState(60)
  useEffect(() => {
    if (!overview.data) return
    setAuto(!!overview.data.settings.auto)
    setEvery(overview.data.settings.every_minutes ?? 60)
  }, [overview.data])
  const [courier, setCourier] = useState('all')
  const [running, setRunning] = useState<'all' | 'shipped' | null>(null)

  const save = useMutation({
    mutationFn: () => saveCourierSync(auto, every),
    onSuccess: () => { toast.success('Courier automation saved'); void queryClient.invalidateQueries({ queryKey: ['courier-automation'] }) },
    onError: (e) => toast.error(e),
  })
  const retry = useMutation({
    mutationFn: retryFailedCourierWebhooks,
    onSuccess: (r) => {
      const ok = r.PROCESSED ?? 0
      const left = Object.entries(r).filter(([k]) => k !== 'PROCESSED').reduce((s, [, n]) => s + n, 0)
      toast.success(ok || left ? `${ok} webhook${ok === 1 ? '' : 's'} applied${left ? ` · ${left} still not matched` : ''}` : 'No failed webhooks')
      void queryClient.invalidateQueries({ queryKey: ['courier-automation'] })
    },
    onError: (e) => toast.error(e),
  })

  const d = overview.data
  const changed = d && (auto !== !!d.settings.auto || every !== (d.settings.every_minutes ?? 60))
  const failedHooks = d?.couriers.reduce((s, c) => s + c.webhooks_failed, 0) ?? 0
  const picked = d?.couriers.find((c) => c.id === courier)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base"><Truck className="size-4" /> Courier automation</CardTitle>
        <CardDescription>Couriers send status changes to us by webhook. When one is missed, these keep every parcel up to date: delivered, returned and the rest.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {!d ? <div className="h-24 animate-pulse rounded-xl bg-muted/50" /> : d.couriers.length === 0 ? (
          <p className="text-sm text-muted-foreground">Connect a courier's API first (<Link to="/admin/couriers" className="underline">Couriers</Link>).</p>
        ) : (
          <>
            <div className="grid gap-3 rounded-xl border p-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <label className="flex items-start gap-3">
                <Switch checked={auto} onCheckedChange={setAuto} disabled={!can('settings.manage')} className="mt-0.5" />
                <span>
                  <span className="block text-sm font-medium">Check parcels with the couriers automatically</span>
                  <span className="block text-xs text-muted-foreground">Asks each courier for every active parcel's status, even when no webhook came.</span>
                </span>
              </label>
              <div className="flex items-center gap-2">
                <Select value={String(every)} onValueChange={(v) => setEvery(Number(v))} disabled={!auto || !can('settings.manage')}>
                  <SelectTrigger className="h-9 w-44"><SelectValue /></SelectTrigger>
                  <SelectContent>{EVERY.map((e) => <SelectItem key={e.value} value={String(e.value)}>{e.label}</SelectItem>)}</SelectContent>
                </Select>
                {can('settings.manage') && <Button size="sm" onClick={() => save.mutate()} disabled={!changed || save.isPending}>Save</Button>}
              </div>
            </div>

            <div className="grid gap-3">
              <p className="text-sm font-medium">Check now</p>
              <div className="flex flex-wrap items-center gap-2">
                <Select value={courier} onValueChange={setCourier}>
                  <SelectTrigger className="h-9 w-48"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All couriers</SelectItem>
                    {d.couriers.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Button variant="outline" size="sm" disabled={!manage} onClick={() => setRunning('all')}>
                  <RefreshCw /> Update courier status <span className="text-muted-foreground">({formatNumber(picked ? picked.active_parcels : d.couriers.reduce((s, c) => s + c.active_parcels, 0))})</span>
                </Button>
                <Button variant="outline" size="sm" disabled={!manage} onClick={() => setRunning('shipped')}>
                  <Truck /> Force check shipped orders <span className="text-muted-foreground">({formatNumber(picked ? picked.shipped_parcels : d.couriers.reduce((s, c) => s + c.shipped_parcels, 0))})</span>
                </Button>
              </div>
            </div>

            <div className="grid gap-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 text-sm font-medium"><Webhook className="size-4" /> Webhooks</p>
                <div className="flex gap-2">
                  {failedHooks > 0 && manage && (
                    <Button size="sm" variant="outline" onClick={() => retry.mutate()} disabled={retry.isPending}>
                      <RotateCw className={cn(retry.isPending && 'animate-spin')} /> Retry {failedHooks} failed
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" asChild><Link to="/admin/couriers?tab=webhooks">Webhook log</Link></Button>
                </div>
              </div>
              <ul className="divide-y rounded-xl border text-sm">
                {d.couriers.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-3 py-2">
                    <span className="font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {c.last_webhook_at ? `Last webhook ${timeAgo(c.last_webhook_at)} · ${c.webhooks_today} today` : 'No webhook received yet'}
                      {c.webhooks_failed > 0 && <span className="ml-2 text-amber-600 dark:text-amber-400">{c.webhooks_failed} failed</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>

            <RunLog runs={d.runs} />
          </>
        )}
      </CardContent>
      {running && (
        <CheckDialog scope={running} courierId={courier === 'all' ? undefined : courier} courierName={picked?.name}
          onClose={() => { setRunning(null); void queryClient.invalidateQueries({ queryKey: ['courier-automation'] }); void queryClient.invalidateQueries({ queryKey: ['orders'] }) }} />
      )}
    </Card>
  )
}

function RunLog({ runs }: { runs: CourierSyncRun[] }) {
  const [open, setOpen] = useState<string | null>(null)
  if (runs.length === 0) return <p className="text-xs text-muted-foreground">No checks yet.</p>
  return (
    <div className="grid gap-2">
      <p className="text-sm font-medium">Recent checks</p>
      <div className="overflow-x-auto rounded-xl border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr><th className="px-3 py-2 text-left font-medium">When</th><th className="px-2 text-left font-medium">What</th>
              <th className="px-2 text-right font-medium">Checked</th><th className="px-2 text-right font-medium">Changed</th><th className="px-3 text-right font-medium">Failed</th></tr>
          </thead>
          <tbody className="divide-y tabular-nums">
            {runs.map((r) => (
              <tr key={r.id} className={cn(r.failed > 0 && 'cursor-pointer hover:bg-muted/40')} onClick={() => r.failed > 0 && setOpen(open === r.id ? null : r.id)}>
                <td className="px-3 py-2 whitespace-nowrap" title={formatDateTime(r.started_at)}>{timeAgo(r.started_at)}{!r.finished_at && <span className="ml-1 text-amber-600">· running</span>}</td>
                <td className="px-2">
                  {r.trigger === 'SCHEDULED' ? 'Automatic' : r.started_by_name ?? 'Staff'} · {r.scope === 'shipped' ? 'shipped' : 'all'}{r.courier ? ` · ${r.courier}` : ''}
                  {open === r.id && (
                    <ul className="mt-1 space-y-0.5 text-red-600 dark:text-red-400">
                      {r.errors.map((e, i) => <li key={i}>{e.order_number} ({e.courier}): {e.error}</li>)}
                    </ul>
                  )}
                </td>
                <td className="px-2 text-right">{formatNumber(r.checked)}{r.total ? `/${formatNumber(r.total)}` : ''}</td>
                <td className="px-2 text-right text-emerald-600">{formatNumber(r.changed)}</td>
                <td className={cn('px-3 text-right', r.failed > 0 && 'text-red-600')}>{formatNumber(r.failed)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/** Runs a check batch by batch with live progress; Stop ends it after the current batch. */
function CheckDialog({ scope, courierId, courierName, onClose }: { scope: 'all' | 'shipped'; courierId?: string; courierName?: string; onClose: () => void }) {
  const [run, setRun] = useState<CourierSyncRun | null>(null)
  const [results, setResults] = useState<CheckOutcome[]>([])
  const [state, setState] = useState<'running' | 'done' | 'stopped' | 'error'>('running')
  const [error, setError] = useState<string | null>(null)
  const stop = useRef(false)
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      let runId: string | undefined
      let after: string | null = null
      try {
        for (;;) {
          const r = await forceCheckBatch({ scope, courier_id: courierId, run_id: runId, after })
          runId = r.run.id
          setRun(r.run)
          setResults((x) => [...x, ...r.results])
          if (r.done) { setState('done'); return }
          after = r.next
          if (stop.current) { setState('stopped'); return }
        }
      } catch (e) {
        setError((e as Error).message)
        setState('error')
      }
    })()
  }, [scope, courierId])

  const total = run?.total ?? 0
  const pct = total ? Math.min(100, Math.round((results.length / total) * 100)) : state === 'done' ? 100 : 0
  const changed = results.filter((r) => !r.error && r.status !== r.before)
  const failed = results.filter((r) => r.error)
  const running = state === 'running'

  return (
    <Dialog open onOpenChange={(o) => { if (!o && !running) onClose() }}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => running && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{SCOPE[scope]}{courierName ? ` · ${courierName}` : ''}</DialogTitle>
          <DialogDescription>Asking the courier for each parcel's latest status. Changes are applied to the orders as they come in.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              {running ? <Loader2 className="size-4 animate-spin" /> : state === 'done' ? <CheckCircle2 className="size-4 text-emerald-600" /> : <AlertTriangle className="size-4 text-amber-600" />}
              {running ? 'Checking…' : state === 'done' ? 'Finished' : state === 'stopped' ? 'Stopped' : 'Stopped by an error'}
            </span>
            <span className="tabular-nums text-muted-foreground">{formatNumber(results.length)}{total ? ` / ${formatNumber(total)}` : ''}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-primary transition-[width] duration-300" style={{ width: `${pct}%` }} /></div>
          <div className="grid grid-cols-3 gap-2 text-center text-sm tabular-nums">
            <div className="rounded-lg border p-2"><p className="text-xs text-muted-foreground">Checked</p><p className="font-semibold">{formatNumber(results.length - failed.length)}</p></div>
            <div className="rounded-lg border p-2"><p className="text-xs text-muted-foreground">Updated</p><p className="font-semibold text-emerald-600">{formatNumber(changed.length)}</p></div>
            <div className="rounded-lg border p-2"><p className="text-xs text-muted-foreground">Failed</p><p className={cn('font-semibold', failed.length > 0 && 'text-red-600')}>{formatNumber(failed.length)}</p></div>
          </div>
          {error && <p className="rounded-lg bg-red-500/10 p-2.5 text-sm text-red-700 dark:text-red-400">{error}</p>}
          {(changed.length > 0 || failed.length > 0) && (
            <ul className="max-h-56 space-y-1 overflow-y-auto rounded-lg border p-2 text-xs">
              {[...failed, ...changed].map((r) => (
                <li key={r.shipment_id} className="flex justify-between gap-3">
                  <span className="font-medium">{r.order_number} <span className="font-normal text-muted-foreground">· {r.courier}</span></span>
                  {r.error ? <span className="truncate text-red-600" title={r.error}>{r.error}</span>
                    : <span className="text-emerald-600">{r.before.toLowerCase().replace(/_/g, ' ')} → {r.status?.toLowerCase().replace(/_/g, ' ')}</span>}
                </li>
              ))}
            </ul>
          )}
          {state === 'done' && total === 0 && <p className="text-sm text-muted-foreground">No active parcels to check.</p>}
        </div>
        <DialogFooter>
          {running
            ? <Button variant="outline" onClick={() => { stop.current = true }} disabled={stop.current}>Stop after this batch</Button>
            : <Button onClick={onClose}>Close</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
