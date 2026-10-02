import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, CircleAlert, CircleCheck, CircleX, PackageCheck, PackageSearch, RotateCcw, ScanBarcode, Truck, Volume2, VolumeX } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Money } from '@/components/common/money'
import { PageHeader } from '@/components/common/page-header'
import { Spinner } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CameraScanner } from '@/features/fulfillment/camera-scanner'
import { toUserMessage } from '@/lib/errors'
import { scanFeedback } from '@/lib/feedback'
import { formatDateTime, timeAgo } from '@/lib/format'
import { ORDER_STATUS } from '@/lib/status'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { listCouriers } from '@/services/couriers'
import { recentScans, scanParcel } from '@/services/orders'
import type { ScanAction, ScanResult } from '@/types/domain'

const MODES: Array<{ value: ScanAction; label: string; short: string; icon: typeof Truck; hint: string }> = [
  { value: 'READY_TO_SHIP', label: 'Ready to ship', short: 'RTS', icon: PackageCheck, hint: 'Packed, awaiting pickup' },
  { value: 'SHIPPED', label: 'Shipped', short: 'Ship', icon: Truck, hint: 'Handed to courier' },
  { value: 'RETURNED', label: 'Returned', short: 'Return', icon: RotateCcw, hint: 'Came back, restock' },
  { value: 'LOOKUP', label: 'Look up', short: 'Find', icon: PackageSearch, hint: 'No changes' },
]

const RESULT_STYLE: Record<ScanResult['result'], { cls: string; icon: typeof CircleCheck; title: string }> = {
  OK: { cls: 'border-emerald-300 bg-emerald-50 text-emerald-950', icon: CircleCheck, title: 'Done' },
  ALREADY: { cls: 'border-amber-300 bg-amber-50 text-amber-950', icon: CircleAlert, title: 'Already done' },
  ERROR: { cls: 'border-red-300 bg-red-50 text-red-950', icon: CircleX, title: 'Not changed' },
  NOT_FOUND: { cls: 'border-red-300 bg-red-50 text-red-950', icon: CircleX, title: 'Unknown barcode' },
}

const ACTION_LABEL: Record<string, string> = { READY_TO_SHIP: 'RTS', SHIPPED: 'Shipped', RETURNED: 'Returned', LOOKUP: 'Look up' }

/** Packing desk: scan labels to mark parcels ready to ship, shipped or returned. */
export default function ScanPage() {
  const queryClient = useQueryClient()
  const inputRef = useRef<HTMLInputElement>(null)
  const [mode, setMode] = useState<ScanAction>(() => (sessionStorage.getItem('scan_mode') as ScanAction | null) ?? 'READY_TO_SHIP')
  const [courierId, setCourierId] = useState<string>(() => sessionStorage.getItem('scan_courier') ?? '')
  const [code, setCode] = useState('')
  const [camera, setCamera] = useState(false)
  const [sound, setSound] = useState(() => localStorage.getItem('scan_sound') !== 'off')
  const [last, setLast] = useState<ScanResult | null>(null)
  const [session, setSession] = useState({ ok: 0, already: 0, error: 0 })

  const couriers = useQuery({ queryKey: ['couriers', 'active'], queryFn: () => listCouriers(true) })
  const log = useQuery({ queryKey: ['parcel-scans'], queryFn: () => recentScans(60), refetchInterval: 30_000 })

  // Scans made on other devices show up live.
  useEffect(() => {
    const channel = supabase.channel('parcel-scans')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'parcel_scans' }, () => {
        void queryClient.invalidateQueries({ queryKey: ['parcel-scans'] })
      })
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [queryClient])

  const scan = useMutation({
    meta: { silent: true },
    mutationFn: (value: string) => scanParcel(value, mode, mode === 'SHIPPED' ? courierId || null : null),
    onSuccess: (r) => {
      setLast(r)
      const kind = r.result === 'OK' ? 'ok' : r.result === 'ALREADY' ? 'warn' : 'error'
      scanFeedback(kind, sound)
      setSession((s) => ({ ok: s.ok + (kind === 'ok' ? 1 : 0), already: s.already + (kind === 'warn' ? 1 : 0), error: s.error + (kind === 'error' ? 1 : 0) }))
      void queryClient.invalidateQueries({ queryKey: ['parcel-scans'] })
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      void queryClient.invalidateQueries({ queryKey: ['fulfillment-summary'] })
    },
    onError: (e) => {
      scanFeedback('error', sound)
      setLast({ result: 'ERROR', message: toUserMessage(e), code, order: null })
    },
    onSettled: () => inputRef.current?.focus(),
  })

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const value = code.trim()
    if (!value || scan.isPending) return
    setCode('')
    scan.mutate(value)
  }

  useEffect(() => { inputRef.current?.focus() }, [mode])
  const current = MODES.find((m) => m.value === mode)!
  const style = last ? RESULT_STYLE[last.result] : null

  return (
    <div className="space-y-5">
      <PageHeader title="Scan parcels" description="Scan the barcode on each shipping label. Works with USB / Bluetooth scanners and the phone camera." actions={
        <Button variant="ghost" size="icon" onClick={() => { setSound(!sound); localStorage.setItem('scan_sound', sound ? 'off' : 'on') }} aria-label={sound ? 'Mute scan sounds' : 'Turn on scan sounds'}>
          {sound ? <Volume2 /> : <VolumeX />}
        </Button>
      } />

      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Scan action">
            {MODES.map((m) => (
              <button key={m.value} type="button" role="radio" aria-checked={mode === m.value}
                onClick={() => { setMode(m.value); sessionStorage.setItem('scan_mode', m.value); setLast(null) }}
                className={cn('flex items-center gap-3 rounded-2xl border bg-card p-3.5 text-left transition-colors hover:border-foreground/30',
                  mode === m.value && 'border-transparent bg-sidebar text-sidebar-foreground hover:border-transparent')}>
                <span className={cn('flex size-9 items-center justify-center rounded-xl bg-muted', mode === m.value && 'bg-brand text-brand-foreground')}>
                  <m.icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold">{m.label}</span>
                  <span className={cn('block truncate text-xs text-muted-foreground', mode === m.value && 'text-sidebar-muted')}>{m.hint}</span>
                </span>
              </button>
            ))}
          </div>

          <Card className="gap-4 p-5">
            {mode === 'SHIPPED' && (
              <div className="flex flex-wrap items-center gap-3">
                <span className="text-sm text-muted-foreground">Handing over to</span>
                <Select value={courierId || 'none'} onValueChange={(v) => { const id = v === 'none' ? '' : v; setCourierId(id); sessionStorage.setItem('scan_courier', id) }}>
                  <SelectTrigger className="w-56"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Keep the assigned courier</SelectItem>
                    {(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">Used for parcels that have no courier yet.</span>
              </div>
            )}
            <form onSubmit={submit} className="flex gap-2">
              <div className="relative flex-1">
                <ScanBarcode className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
                <Input ref={inputRef} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCorrect="off" spellCheck={false}
                  placeholder="Scan or type order / tracking no."
                  className="h-14 rounded-xl pl-12 font-mono text-lg" aria-label="Barcode" />
              </div>
              <Button type="submit" size="lg" className="h-14 rounded-xl px-6" disabled={!code.trim() || scan.isPending}>
                {scan.isPending ? <Spinner /> : 'Go'}
              </Button>
              <Button type="button" size="lg" variant="outline" className="h-14 rounded-xl" onClick={() => setCamera((c) => !c)} aria-pressed={camera}>
                <Camera /> <span className="hidden sm:inline">Camera</span>
              </Button>
            </form>
            {camera && <CameraScanner onScan={(c) => { if (!scan.isPending) scan.mutate(c) }} onClose={() => { setCamera(false); inputRef.current?.focus() }} />}

            {last && style ? (
              <div className={cn('flex gap-4 rounded-2xl border-2 p-5', style.cls)} role="status" aria-live="assertive">
                <style.icon className="mt-0.5 size-8 shrink-0" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold tracking-wider uppercase opacity-70">{style.title} · {ACTION_LABEL[mode]}</p>
                  <p className="text-2xl font-semibold tracking-tight">{last.message}</p>
                  {last.order ? (
                    <div className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                      <p><Link to={`/admin/orders/${last.order.id}`} className="font-mono font-semibold underline-offset-2 hover:underline">{last.order.order_number}</Link>{' '}
                        <StatusBadge value={last.order.status} map={ORDER_STATUS} /></p>
                      <p>{last.order.customer_name} · {last.order.shipping_district}</p>
                      <p>{last.order.item_count} item{last.order.item_count === 1 ? '' : 's'} · COD <Money value={last.order.cod_amount} /></p>
                      <p>{last.order.courier_name ? `${last.order.courier_name}${last.order.tracking_number ? ` · ${last.order.tracking_number}` : ''}` : 'No courier assigned'}</p>
                      {!last.order.label_printed_at && <p className="text-amber-800 sm:col-span-2">Label not printed yet</p>}
                    </div>
                  ) : <p className="mt-1 font-mono text-sm">{last.code}</p>}
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 rounded-2xl border border-dashed p-5 text-sm text-muted-foreground">
                <current.icon className="size-5" /> Ready — scan a label to mark it <strong className="text-foreground">{current.label.toLowerCase()}</strong>.
              </div>
            )}
          </Card>

          <div className="grid grid-cols-3 gap-3">
            <Stat label="Done" value={session.ok} tone="text-emerald-700" />
            <Stat label="Already done" value={session.already} tone="text-amber-700" />
            <Stat label="Problems" value={session.error} tone="text-red-700" />
          </div>
        </div>

        <Card className="gap-0 overflow-hidden py-0">
          <div className="flex items-center justify-between border-b px-5 py-4">
            <div>
              <p className="font-semibold">Scan log</p>
              <p className="text-xs text-muted-foreground">Every scan on every device, newest first</p>
            </div>
            {log.isFetching && <Spinner />}
          </div>
          <ul className="max-h-[640px] divide-y overflow-y-auto">
            {(log.data ?? []).map((row) => (
              <li key={row.id} className="flex items-start gap-3 px-5 py-3 text-sm">
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', row.result === 'OK' ? 'bg-emerald-500' : row.result === 'ALREADY' ? 'bg-amber-500' : 'bg-red-500')} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    {row.order_id
                      ? <Link to={`/admin/orders/${row.order_id}`} className="font-mono font-medium hover:underline">{row.order_number}</Link>
                      : <span className="font-mono text-muted-foreground">{row.code}</span>}
                    <Badge variant="outline" className="text-[10px]">{ACTION_LABEL[row.action] ?? row.action}</Badge>
                  </div>
                  <p className="truncate text-muted-foreground">{row.message}</p>
                </div>
                <span className="shrink-0 text-right text-xs text-muted-foreground" title={formatDateTime(row.created_at)}>
                  {timeAgo(row.created_at)}<br />{row.scanned_by_name}
                </span>
              </li>
            ))}
            {log.data?.length === 0 && <li className="px-5 py-10 text-center text-sm text-muted-foreground">No scans yet.</li>}
          </ul>
        </Card>
      </div>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <Card className="gap-1 px-4 py-3">
      <p className="text-xs text-muted-foreground">{label} this session</p>
      <p className={cn('text-2xl font-semibold tabular-nums', tone)}>{value}</p>
    </Card>
  )
}
