import { useQuery } from '@tanstack/react-query'
import { ExternalLink, RotateCcw, Square, Truck } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Spinner } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { bookedParcels, bookShipments, courierConfig, listCouriers, type ParcelCourier } from '@/services/couriers'

type RowStatus = 'QUEUED' | 'UPLOADING' | 'SUCCESS' | 'FAILED' | 'SKIPPED' | 'STOPPED'
interface Row { id: string; status: RowStatus; tracking: string | null; message: string; courier?: Pick<ParcelCourier, 'provider' | 'tracking_url_template'> | null }

const STATUS: Record<RowStatus, { label: string; className: string }> = {
  QUEUED: { label: 'Queued', className: 'bg-muted text-muted-foreground' },
  UPLOADING: { label: 'Uploading', className: 'animate-pulse bg-foreground/15 text-foreground' },
  SUCCESS: { label: 'Success', className: 'bg-foreground text-background' },
  FAILED: { label: 'Failed', className: 'bg-transparent text-foreground ring-1 ring-foreground/60 ring-inset' },
  SKIPPED: { label: 'Skipped', className: 'bg-foreground/10 text-foreground' },
  STOPPED: { label: 'Stopped', className: 'bg-muted text-muted-foreground' },
}

/** Parcels sent at the same time: quick, and still gentle on the courier's API. */
const PARALLEL = 3

export const trackingUrl = (c: { tracking_url_template: string | null; provider: string | null } | null | undefined, code: string) => {
  const template = c?.tracking_url_template ?? (c?.provider === 'steadfast' ? 'https://steadfast.com.bd/t/{tracking}'
    : c?.provider === 'pathao' ? 'https://merchant.pathao.com/tracking?consignment_id={tracking}'
    : c?.provider === 'redx' ? 'https://redx.com.bd/track-parcel/?trackingId={tracking}' : null)
  return template ? template.replace('{tracking}', encodeURIComponent(code)) : null
}

/**
 * Books the selected orders with a courier. Orders a courier already has are found in one
 * lookup first and skipped at once; the rest go up a few at a time, each row live: queued →
 * uploading → its tracking ID or the courier's reason. A van drives along the road as they go.
 */
export function BookCourierDialog({ open, onOpenChange, orderIds, orderNumber, onDone }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  orderIds: string[]
  orderNumber: (id: string) => string
  onDone: () => void
}) {
  const couriers = useQuery({ queryKey: ['couriers', 'active'], queryFn: () => listCouriers(true), enabled: open })
  const connected = (couriers.data ?? []).filter((c) => c.api_enabled)
  const [courierId, setCourierId] = useState('')
  const chosen = connected.find((c) => c.id === courierId) ?? connected[0]
  // Pathao: pick the pickup store for this batch (the default store unless changed).
  const cfg = courierConfig(chosen)
  const stores = (chosen?.provider === 'pathao' || chosen?.provider === 'redx') ? (cfg.stores ?? []).filter((s) => s.active || s.id === cfg.store_id) : []
  const [storeId, setStoreId] = useState('')
  const store = stores.find((s) => s.id === storeId)?.id ?? cfg.store_id ?? ''
  const [rows, setRows] = useState<Row[] | null>(null)
  const [running, setRunning] = useState(false)
  const [checking, setChecking] = useState(false)
  const stop = useRef(false)
  // Order numbers are read once, so they survive the list refreshing underneath.
  const names = useRef(new Map<string, string>())

  useEffect(() => {
    if (!open) return
    setRows(null)
    setRunning(false)
    setChecking(false)
    stop.current = false
    names.current = new Map(orderIds.map((id) => [id, orderNumber(id)]))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (id: string, next: Partial<Row>) => setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, ...next } : r)) ?? null)

  async function run(ids: string[]) {
    if (!chosen) return
    const courierId = chosen.id
    const storeId = stores.length ? store : undefined
    stop.current = false
    setRunning(true)
    setChecking(true)
    setRows((rs) => {
      const base = rs ?? orderIds.map((id) => ({ id, status: 'QUEUED' as RowStatus, tracking: null, message: 'Waiting…' }))
      return base.map((r) => (ids.includes(r.id) ? { ...r, status: 'QUEUED', tracking: null, courier: null, message: 'Waiting…' } : r))
    })

    // Checked in one go before uploading: a parcel a courier already has is skipped, never sent twice.
    let booked = new Map<string, { tracking: string; courier: ParcelCourier | null }>()
    try {
      booked = await bookedParcels(ids)
    } catch {
      // The server refuses a booked parcel anyway; the upload just goes ahead.
    }
    setChecking(false)
    const queue: string[] = []
    for (const id of ids) {
      const b = booked.get(id)
      if (b) patch(id, { status: 'SKIPPED', tracking: b.tracking, courier: b.courier, message: `Already uploaded to ${b.courier?.name ?? 'a courier'}` })
      else queue.push(id)
    }

    const refused = (id: string, message: string | undefined) => {
      // Booked by someone else since the check: the server names its tracking ID.
      const already = message?.match(/is already booked \(([^)]+)\)/)
      if (already) patch(id, { status: 'SKIPPED', tracking: already[1], courier: null, message: 'Already uploaded' })
      else patch(id, { status: 'FAILED', message: message ?? 'The courier did not accept this parcel' })
    }
    let next = 0
    const worker = async () => {
      while (next < queue.length) {
        const id = queue[next++]
        if (stop.current) {
          patch(id, { status: 'STOPPED', message: 'Stopped before upload' })
          continue
        }
        patch(id, { status: 'UPLOADING', message: 'Processing…' })
        try {
          const res = (await bookShipments([id], courierId, storeId)).results[0]
          if (res?.ok) patch(id, { status: 'SUCCESS', tracking: res.tracking_number ?? null, courier: chosen, message: res.tracking_number ? 'Upload successful' : 'Booked (no tracking ID yet)' })
          else refused(id, res?.error)
        } catch (e) {
          refused(id, (e as Error).message)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(PARALLEL, queue.length) }, worker))
    setRunning(false)
    onDone()
  }

  // Progress counts the parcels that go up; the ones a courier already has are only skipped.
  const skipped = rows?.filter((r) => r.status === 'SKIPPED').length ?? 0
  const total = (rows?.length ?? orderIds.length) - skipped
  const done = rows?.filter((r) => r.status === 'SUCCESS' || r.status === 'FAILED' || r.status === 'STOPPED').length ?? 0
  const success = rows?.filter((r) => r.status === 'SUCCESS').length ?? 0
  const failed = rows?.filter((r) => r.status === 'FAILED').length ?? 0
  const pct = checking ? 0 : total ? (done / total) * 100 : 100
  const finished = rows !== null && !running

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent showCloseButton={!running} className="gap-4 sm:max-w-2xl">
        {rows === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Upload {orderIds.length} parcel{orderIds.length === 1 ? '' : 's'} to a courier</DialogTitle>
              <DialogDescription>Orders a courier already has are skipped at once. The rest go to the courier's API a few at a time, and you see every tracking ID as it comes back.</DialogDescription>
            </DialogHeader>
            {couriers.isLoading ? <Spinner /> : connected.length === 0 ? (
              <p className="text-sm text-muted-foreground">No courier is connected yet. <Link to="/admin/couriers" className="underline">Connect Steadfast, Pathao or RedX</Link> first.</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <Select value={chosen?.id} onValueChange={(v) => { setCourierId(v); setStoreId('') }}>
                  <SelectTrigger aria-label="Courier" className="w-full"><SelectValue /></SelectTrigger>
                  <SelectContent>{connected.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
                {stores.length > 1 && (
                  <Select value={store} onValueChange={(v) => { if (v) setStoreId(v) }}>
                    <SelectTrigger aria-label="Pickup store" className="w-full"><SelectValue placeholder="Pickup store" /></SelectTrigger>
                    <SelectContent>{stores.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}{s.id === cfg.store_id ? ' · default' : ''}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </div>
            )}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => void run(orderIds)} disabled={!chosen}><Truck /> Start upload</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3 pr-6">
              <div>
                <DialogTitle className="text-base">{chosen?.name} upload progress</DialogTitle>
                <DialogDescription className="sr-only">Live status of each parcel being booked</DialogDescription>
              </div>
              <Badge className={cn('shrink-0', running ? 'bg-muted text-foreground' : failed ? 'bg-transparent text-foreground ring-1 ring-foreground/60 ring-inset' : 'bg-foreground text-background')}>
                {checking ? 'Checking…' : running ? `Processing (${done}/${total})` : failed ? `Done · ${failed} failed`
                  : total === 0 ? 'Already uploaded' : 'All booked'}
              </Badge>
            </div>

            <Road pct={pct} running={running} />

            <div className="flex flex-wrap items-center justify-between gap-2 text-sm" aria-live="polite">
              <span className="inline-flex items-center gap-2 font-medium tabular-nums">
                {checking ? <><Spinner className="size-3.5" /> Checking before uploading…</> : `Progress: ${done} / ${total}`}
              </span>
              <span className="flex gap-4 tabular-nums text-muted-foreground">
                <span>Success <b className="text-foreground">{success}</b></span>
                {skipped > 0 && <span>Skipped <b className="text-foreground">{skipped}</b></span>}
                <span>Failed <b className="text-foreground">{failed}</b></span>
              </span>
            </div>

            <div className="max-h-72 overflow-auto rounded-xl border">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-card text-xs text-muted-foreground">
                  <tr className="border-b">
                    <th className="px-3 py-2 text-left font-medium">Order ID</th>
                    <th className="px-3 py-2 text-left font-medium">Status</th>
                    <th className="px-3 py-2 text-left font-medium">Tracking ID</th>
                    <th className="px-3 py-2 text-left font-medium">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const url = r.tracking ? trackingUrl(r.courier ?? chosen, r.tracking) : null
                    return (
                      <tr key={r.id} className={cn('border-b last:border-0 transition-colors', r.status === 'UPLOADING' && 'bg-muted/60')}>
                        <td className="px-3 py-2 font-medium whitespace-nowrap">{names.current.get(r.id) ?? r.id.slice(0, 8)}</td>
                        <td className="px-3 py-2">
                          <span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold tracking-wide uppercase', STATUS[r.status].className)}>
                            {r.status === 'UPLOADING' && <span className="size-1.5 animate-pulse rounded-full bg-current" />}{STATUS[r.status].label}
                          </span>
                        </td>
                        <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">
                          {r.tracking ? (url
                            ? <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-foreground underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground">{r.tracking}<ExternalLink className="size-3" /></a>
                            : r.tracking) : '—'}
                        </td>
                        <td className={cn('px-3 py-2 text-xs', r.status === 'FAILED' ? 'font-medium text-foreground' : 'text-muted-foreground')}>{r.message}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <DialogFooter className="gap-2 sm:justify-between">
              {running ? (
                <Button variant="outline" disabled={checking} onClick={() => { stop.current = true }}><Square /> Stop the rest</Button>
              ) : failed > 0 ? (
                <Button variant="outline" onClick={() => void run(rows.filter((r) => r.status === 'FAILED').map((r) => r.id))}><RotateCcw /> Retry failed</Button>
              ) : <span />}
              <Button variant={finished ? 'default' : 'ghost'} disabled={running} onClick={() => onOpenChange(false)}>Close</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The road: a clean line that fills as parcels go out, with the van driving to the current progress. */
function Road({ pct, running }: { pct: number; running: boolean }) {
  return (
    <div className="relative h-16 select-none" aria-hidden>
      <div className="absolute inset-x-0 bottom-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
      </div>
      <div className={cn('absolute inset-x-0 bottom-1 h-0.5 opacity-30', running && 'booking-road')} />
      <div className="absolute bottom-4 transition-[left] duration-700 ease-out" style={{ left: `calc(${pct}% - ${pct * 0.56}px)` }}>
        <svg viewBox="0 0 72 44" className={cn('h-9 w-14 text-foreground', running && 'booking-van')}>
          <rect x="2" y="6" width="42" height="26" rx="3" className="fill-current" />
          <rect x="8" y="12" width="10" height="9" rx="1.5" className="fill-background/80" />
          <rect x="21" y="12" width="10" height="9" rx="1.5" className="fill-background/80" />
          <path d="M44 14h14l10 10v8H44z" className="fill-current" />
          <path d="M48 17h9l6 6h-15z" className="fill-background/70" />
          <circle cx="14" cy="34" r="6" className="fill-background stroke-current" strokeWidth="3" />
          <circle cx="56" cy="34" r="6" className="fill-background stroke-current" strokeWidth="3" />
        </svg>
      </div>
    </div>
  )
}
