import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, CircleAlert, CircleCheck, CircleX, Flashlight, FlashlightOff, PackageCheck, PackageSearch, RotateCcw, ScanBarcode, Truck, Volume2, VolumeX } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react'
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
import { CameraScanner, type TorchState } from '@/features/fulfillment/camera-scanner'
import { toUserMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { scanFeedback } from '@/lib/feedback'
import { formatDateTime, timeAgo } from '@/lib/format'
import { ORDER_STATUS } from '@/lib/status'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'
import { listCouriers } from '@/services/couriers'
import { recentScans, scanParcel } from '@/services/orders'
import type { ScanAction, ScanResult } from '@/types/domain'

/**
 * `does` ends the line under the scan box: "Ready — scan a label to …". `phone` is the name on a
 * phone, where "Ready to ship" took two lines beside one-line neighbours (RTS, as in the order tabs).
 */
const MODES: Array<{ value: ScanAction; label: string; phone?: string; icon: typeof Truck; hint: string; does: string }> = [
  { value: 'READY_TO_SHIP', label: 'Ready to ship', phone: 'RTS', icon: PackageCheck, hint: 'Packed, awaiting pickup', does: 'mark it ready to ship' },
  { value: 'SHIPPED', label: 'Shipped', icon: Truck, hint: 'Handed to courier', does: 'mark it shipped' },
  { value: 'RETURNED', label: 'Returned', icon: RotateCcw, hint: 'Came back, restock', does: 'mark it returned' },
  { value: 'LOOKUP', label: 'Look up', icon: PackageSearch, hint: 'No changes', does: 'look the order up' },
]

/** Scan log rows shown below the scanner before "Show all"; the side column on wide screens scrolls instead. */
const SHORT_LOG = 10

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
  // Flashlight: what the page asks for, and what the camera says it can do.
  const [torch, setTorch] = useState(false)
  const [torchState, setTorchState] = useState<TorchState | null>(null)
  const [askedTorch, setAskedTorch] = useState(false)
  const [sound, setSound] = useState(() => localStorage.getItem('scan_sound') !== 'off')
  const [last, setLast] = useState<ScanResult | null>(null)
  const [session, setSession] = useState({ ok: 0, already: 0, error: 0 })
  const [fullLog, setFullLog] = useState(false)
  // Reset log: this device shows only scans after the reset point. Scans are never deleted (each order's
  // history keeps them); the point is the newest scan's own time, so a phone clock that runs fast hides nothing.
  const [resetAt, setResetAt] = useState<string | null>(readResetPoint)

  const couriers = useQuery({ queryKey: ['couriers', 'active'], queryFn: () => listCouriers(true) })
  const log = useQuery({ queryKey: ['parcel-scans', resetAt], queryFn: () => recentScans(60, resetAt), refetchInterval: 30_000 })

  // Lists that depend on scans refresh once a burst of scans is over, not after every scan.
  const refreshTimer = useRef<number | undefined>(undefined)
  const refreshSoon = useCallback(() => {
    window.clearTimeout(refreshTimer.current)
    refreshTimer.current = window.setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: ['parcel-scans'] })
      void queryClient.invalidateQueries({ queryKey: ['orders'] })
      void queryClient.invalidateQueries({ queryKey: ['fulfillment-summary'] })
    }, 1200)
  }, [queryClient])
  useEffect(() => () => window.clearTimeout(refreshTimer.current), [])

  // Scans made on other devices show up live.
  useEffect(() => {
    const channel = supabase.channel('parcel-scans')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'parcel_scans' }, refreshSoon)
      .subscribe()
    return () => { void supabase.removeChannel(channel) }
  }, [refreshSoon])

  // Every code is accepted at once and worked through in the order it was scanned:
  // nothing is dropped while the previous parcel is still being saved.
  const queue = useRef<string[]>([])
  const working = useRef(false)
  const settings = useRef({ mode, courierId, sound })
  settings.current = { mode, courierId, sound }
  const [waiting, setWaiting] = useState(0)
  const [busy, setBusy] = useState(false)
  const drain = useCallback(async () => {
    if (working.current) return
    working.current = true
    setBusy(true)
    while (queue.current.length) {
      const value = queue.current.shift()!
      setWaiting(queue.current.length)
      const { mode: m, courierId: c, sound: s } = settings.current
      try {
        const r = await scanParcel(value, m, m === 'SHIPPED' ? c || null : null)
        setLast(r)
        const kind = r.result === 'OK' ? 'ok' : r.result === 'ALREADY' ? 'warn' : 'error'
        scanFeedback(kind, s)
        setSession((x) => ({ ok: x.ok + (kind === 'ok' ? 1 : 0), already: x.already + (kind === 'warn' ? 1 : 0), error: x.error + (kind === 'error' ? 1 : 0) }))
      } catch (e) {
        scanFeedback('error', s)
        setLast({ result: 'ERROR', message: toUserMessage(e), code: value, order: null })
        setSession((x) => ({ ...x, error: x.error + 1 }))
      }
    }
    working.current = false
    setBusy(false)
    setWaiting(0)
    refreshSoon()
    inputRef.current?.focus()
  }, [refreshSoon])
  const enqueue = useCallback((value: string) => {
    queue.current.push(value)
    setWaiting(queue.current.length)
    void drain()
  }, [drain])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    const value = code.trim()
    if (!value) return
    setCode('')
    enqueue(value)
  }

  useEffect(() => { inputRef.current?.focus() }, [mode])
  const current = MODES.find((m) => m.value === mode)!
  const style = last ? RESULT_STYLE[last.result] : null
  const rows = log.data ?? []

  const resetLog = () => {
    const newest = rows[0]?.created_at
    if (!newest) return
    const before = { at: resetAt, session, last }
    saveResetPoint(newest)
    setResetAt(newest)
    setSession({ ok: 0, already: 0, error: 0 })
    setLast(null)
    setFullLog(false)
    toast.success('Scan log cleared', {
      description: 'New scans show here from now on. Every order keeps its scans in its history.',
      action: { label: 'Undo', onClick: () => { saveResetPoint(before.at); setResetAt(before.at); setSession(before.session); setLast(before.last) } },
    })
    inputRef.current?.focus()
  }
  const showEarlier = () => { saveResetPoint(null); setResetAt(null) }

  return (
    <div className="space-y-4 sm:space-y-5">
      {/* The sound switch sits beside the title; as a page action it took a line of its own on phones. */}
      <div className="flex items-start gap-3">
        <PageHeader className="mb-0 min-w-0 flex-1" title="Scan parcels"
          description="Scan the barcode on each shipping label. Works with USB / Bluetooth scanners and the phone camera." />
        <Button variant="ghost" size="icon" className="shrink-0 text-muted-foreground" title={sound ? 'Scan sounds on' : 'Scan sounds off'}
          onClick={() => { setSound(!sound); localStorage.setItem('scan_sound', sound ? 'off' : 'on') }} aria-label={sound ? 'Mute scan sounds' : 'Turn on scan sounds'}>
          {sound ? <Volume2 /> : <VolumeX />}
        </Button>
      </div>

      <div className="grid gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div className="min-w-0 space-y-4">
          {/* Four in a row at every width: icon over the name. The hint shows where there is room, and under the scan box on phones. */}
          <div className="grid grid-cols-4 gap-2" role="radiogroup" aria-label="Scan action">
            {MODES.map((m) => {
              const on = mode === m.value
              return (
                <button key={m.value} type="button" role="radio" aria-checked={on} aria-label={m.label} title={m.hint}
                  onClick={() => { setMode(m.value); sessionStorage.setItem('scan_mode', m.value); setLast(null) }}
                  className={cn('flex min-w-0 flex-col items-center gap-1.5 rounded-xl border bg-card px-1 py-2.5 text-center transition-colors hover:border-foreground/30',
                    'sm:items-start sm:gap-2.5 sm:p-3 sm:text-left',
                    on && 'border-transparent bg-sidebar text-sidebar-foreground hover:border-transparent')}>
                  <span className={cn('flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted sm:size-9 sm:rounded-xl', on && 'bg-brand text-brand-foreground')}>
                    <m.icon className="size-4" />
                  </span>
                  <span className="w-full min-w-0">
                    <span className="block truncate text-xs leading-tight font-semibold sm:text-sm">
                      {m.phone ? <><span className="sm:hidden">{m.phone}</span><span className="hidden sm:inline">{m.label}</span></> : m.label}
                    </span>
                    <span className={cn('mt-0.5 hidden text-xs leading-snug text-muted-foreground sm:line-clamp-2', on && 'text-sidebar-muted')}>{m.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>

          <Card className="@container gap-4 p-4 sm:p-5">
            {mode === 'SHIPPED' && (
              <div className="grid gap-1.5 sm:flex sm:flex-wrap sm:items-center sm:gap-x-3">
                <span className="text-sm text-muted-foreground">Handing over to</span>
                <Select value={courierId || 'none'} onValueChange={(v) => { const id = v === 'none' ? '' : v; setCourierId(id); sessionStorage.setItem('scan_courier', id) }}>
                  <SelectTrigger className="w-full sm:w-64"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Keep the assigned courier</SelectItem>
                    {(couriers.data ?? []).map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">Used for parcels that have no courier yet.</span>
              </div>
            )}
            {/* Narrow (a phone, or the desktop column beside the log): the code gets a line of its own and
                the buttons share the next one. With room, everything sits on one line. */}
            <form onSubmit={submit} className="flex flex-col gap-2 @xl:flex-row">
              <div className="relative min-w-0 @xl:flex-1">
                <ScanBarcode className="pointer-events-none absolute top-1/2 left-4 size-5 -translate-y-1/2 text-muted-foreground" />
                <Input ref={inputRef} value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCorrect="off" spellCheck={false}
                  enterKeyHint="go" placeholder="Order or tracking number"
                  className="h-12 rounded-[10px] pl-12 font-mono text-lg placeholder:font-sans placeholder:text-[15px] @xl:h-14" aria-label="Barcode" />
              </div>
              <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-2 @xl:flex">
                <Button type="submit" size="lg" className="h-12 @xl:h-14 @xl:px-7" disabled={!code.trim()}>
                  {busy ? <Spinner /> : 'Go'}
                </Button>
                <Button type="button" size="lg" variant="outline" className="h-12 has-[>svg]:px-3 @xl:h-14 @xl:has-[>svg]:px-4" onClick={() => { setCamera((c) => !c); setTorch(false); setTorchState(null); setAskedTorch(false) }} aria-pressed={camera}>
                  <Camera /> Camera
                </Button>
                {/* The flashlight: opens the camera with the light on, or switches it while scanning. */}
                <Button type="button" size="icon" variant="outline" aria-pressed={torch} disabled={camera && torchState?.supported === false}
                  aria-label="Flashlight" title={camera && torchState?.supported === false ? 'This camera has no flashlight' : torch ? 'Turn the flashlight off' : 'Turn the flashlight on'}
                  className={cn('size-12 shrink-0 @xl:size-14 [&_svg:not([class*=size-])]:size-5', torch && 'border-amber-300 bg-amber-300 text-black hover:bg-amber-200')}
                  onClick={() => { setAskedTorch(true); if (!camera) { setCamera(true); setTorch(true) } else setTorch((t) => !t) }}>
                  {torch ? <FlashlightOff /> : <Flashlight />}
                </Button>
              </div>
            </form>
            {camera && <CameraScanner onScan={enqueue} torchOn={torch} onTorchState={(st) => { setTorchState(st); setTorch(st.on) }}
              onClose={() => { setCamera(false); setTorch(false); setTorchState(null); setAskedTorch(false); inputRef.current?.focus() }} />}
            {camera && askedTorch && torchState?.supported === false && <p className="text-xs text-muted-foreground" role="status">This camera has no flashlight the browser can switch on.</p>}
            {waiting > 0 && <p className="text-xs text-muted-foreground" role="status">{waiting} more scan{waiting === 1 ? '' : 's'} being saved…</p>}

            {last && style ? (
              <div className={cn('flex gap-3 rounded-xl border-2 p-4 sm:gap-4 sm:p-5', style.cls)} role="status" aria-live="assertive">
                <style.icon className="mt-0.5 size-6 shrink-0 sm:size-8" />
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold tracking-wider uppercase opacity-70">{style.title} · {ACTION_LABEL[mode]}</p>
                  <p className="text-xl font-semibold tracking-tight break-words sm:text-2xl">{last.message}</p>
                  {last.order ? (
                    <div className="mt-3 grid gap-x-6 gap-y-1 text-sm @md:grid-cols-2">
                      <p><Link to={`/admin/orders/${last.order.id}`} className="font-mono font-semibold underline-offset-2 hover:underline">{last.order.order_number}</Link>{' '}
                        <StatusBadge value={last.order.status} map={ORDER_STATUS} /></p>
                      <p>{last.order.customer_name} · {last.order.shipping_district}</p>
                      <p>{last.order.item_count} item{last.order.item_count === 1 ? '' : 's'} · COD <Money value={last.order.cod_amount} /></p>
                      <p>{last.order.courier_name ? `${last.order.courier_name}${last.order.tracking_number ? ` · ${last.order.tracking_number}` : ''}` : 'No courier assigned'}</p>
                      {!last.order.label_printed_at && <p className="text-amber-800 @md:col-span-2">Label not printed yet</p>}
                    </div>
                  ) : <p className="mt-1 font-mono text-sm break-all">{last.code}</p>}
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-3 rounded-xl border border-dashed p-4 text-sm text-muted-foreground sm:p-5">
                <current.icon className="mt-px size-5 shrink-0" />
                <p className="min-w-0">
                  Ready — scan a label to <strong className="font-semibold text-foreground">{current.does}</strong>.
                  <span className="mt-0.5 block text-xs sm:hidden">{current.hint}</span>
                </p>
              </div>
            )}
          </Card>

          <Card className="gap-0 py-0">
            <p className="px-4 pt-3 text-[11px] font-medium tracking-wider text-muted-foreground uppercase">This session</p>
            <div className="grid grid-cols-3 divide-x">
              <Stat label="Done" value={session.ok} tone="text-emerald-700" />
              <Stat label="Already done" value={session.already} tone="text-amber-700" />
              <Stat label="Problems" value={session.error} tone="text-red-700" />
            </div>
          </Card>
        </div>

        <Card className="min-w-0 gap-0 overflow-hidden py-0">
          <div className="flex items-center justify-between gap-3 border-b px-4 py-3.5 sm:px-5 sm:py-4">
            <div className="min-w-0">
              <p className="flex items-center gap-2 font-semibold">Scan log {log.isFetching && <Spinner />}</p>
              <p className="text-xs text-muted-foreground">
                {resetAt ? (
                  <>
                    Since you cleared it, {formatDateTime(resetAt)} ·{' '}
                    <button type="button" onClick={showEarlier} className="font-medium text-foreground underline-offset-2 hover:underline">Show all</button>
                  </>
                ) : 'Every scan on every device, newest first'}
              </p>
            </div>
            <Button variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={resetLog} disabled={rows.length === 0}
              title="Start a fresh log on this device. The scans are kept in each order's history.">
              <RotateCcw className="size-3.5" /> Reset log
            </Button>
          </div>
          {/* Beside the scanner (wide screens) the log scrolls on its own; below it, the page scrolls and the list starts short. */}
          <ul className="divide-y xl:max-h-[640px] xl:overflow-y-auto">
            {rows.map((row, i) => (
              <li key={row.id} className={cn('flex items-start gap-3 px-4 py-3 text-sm sm:px-5', i >= SHORT_LOG && !fullLog && 'max-xl:hidden')}>
                <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', row.result === 'OK' ? 'bg-emerald-500' : row.result === 'ALREADY' ? 'bg-amber-500' : 'bg-red-500')} />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    {row.order_id
                      ? <Link to={`/admin/orders/${row.order_id}`} className="truncate font-mono font-medium hover:underline">{row.order_number}</Link>
                      : <span className="truncate font-mono text-muted-foreground">{row.code}</span>}
                    <Badge variant="outline" className="shrink-0 text-[10px]">{ACTION_LABEL[row.action] ?? row.action}</Badge>
                  </div>
                  <p className="truncate text-muted-foreground">{row.message}</p>
                </div>
                <span className="max-w-28 shrink-0 text-right text-xs text-muted-foreground" title={formatDateTime(row.created_at)}>
                  {timeAgo(row.created_at)}<span className="block truncate">{row.scanned_by_name}</span>
                </span>
              </li>
            ))}
            {log.data?.length === 0 && (
              <li className="px-5 py-10 text-center text-sm text-muted-foreground">
                {resetAt ? (
                  <>
                    <p>Log cleared. New scans show up here.</p>
                    <button type="button" onClick={showEarlier} className="mt-2 text-[13px] font-medium text-foreground underline underline-offset-2 hover:opacity-80">
                      Show earlier scans
                    </button>
                  </>
                ) : 'No scans yet.'}
              </li>
            )}
          </ul>
          {rows.length > SHORT_LOG && !fullLog && (
            <button type="button" onClick={() => setFullLog(true)}
              className="w-full px-4 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground xl:hidden">
              Show all {rows.length} scans
            </button>
          )}
        </Card>
      </div>
    </div>
  )
}

const RESET_KEY = 'scan_log_reset_at'

/** Where this device's scan log starts (the newest scan when the log was last cleared), or null for the full log. */
function readResetPoint(): string | null {
  try { return localStorage.getItem(RESET_KEY) || null } catch { return null }
}
function saveResetPoint(at: string | null) {
  try {
    if (at) localStorage.setItem(RESET_KEY, at)
    else localStorage.removeItem(RESET_KEY)
  } catch { /* private window: the reset lasts until the page is reloaded */ }
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-0 px-3 pt-1 pb-3 sm:px-4">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className={cn('text-2xl font-semibold tabular-nums', tone)}>{value}</p>
    </div>
  )
}
