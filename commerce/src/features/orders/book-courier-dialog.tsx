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
import { bookShipments, type CourierRow, listCouriers } from '@/services/couriers'

type RowStatus = 'QUEUED' | 'UPLOADING' | 'SUCCESS' | 'FAILED' | 'SKIPPED'
interface Row { id: string; status: RowStatus; tracking: string | null; message: string }

const STATUS: Record<RowStatus, { label: string; className: string }> = {
  QUEUED: { label: 'Queued', className: 'bg-muted text-muted-foreground' },
  UPLOADING: { label: 'Uploading', className: 'animate-pulse bg-foreground/15 text-foreground' },
  SUCCESS: { label: 'Success', className: 'bg-foreground text-background' },
  FAILED: { label: 'Failed', className: 'bg-transparent text-foreground ring-1 ring-foreground/60 ring-inset' },
  SKIPPED: { label: 'Stopped', className: 'bg-muted text-muted-foreground' },
}

const trackingUrl = (c: CourierRow | undefined, code: string) => {
  const template = c?.tracking_url_template ?? (c?.provider === 'steadfast' ? 'https://steadfast.com.bd/t/{tracking}'
    : c?.provider === 'pathao' ? 'https://merchant.pathao.com/tracking?consignment_id={tracking}'
    : c?.provider === 'redx' ? 'https://redx.com.bd/track-parcel/?trackingId={tracking}' : null)
  return template ? template.replace('{tracking}', encodeURIComponent(code)) : null
}

/**
 * Books the selected orders with a courier one parcel at a time, so each row
 * shows live: queued → uploading → its tracking ID or the courier's reason.
 * A van drives along the road as parcels go out. Orders already booked are
 * skipped by the server.
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
  const [rows, setRows] = useState<Row[] | null>(null)
  const [running, setRunning] = useState(false)
  const stop = useRef(false)
  // Order numbers are read once, so they survive the list refreshing underneath.
  const names = useRef(new Map<string, string>())

  useEffect(() => {
    if (!open) return
    setRows(null)
    setRunning(false)
    stop.current = false
    names.current = new Map(orderIds.map((id) => [id, orderNumber(id)]))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (id: string, next: Partial<Row>) => setRows((rs) => rs?.map((r) => (r.id === id ? { ...r, ...next } : r)) ?? null)

  async function run(ids: string[]) {
    if (!chosen) return
    stop.current = false
    setRunning(true)
    setRows((rs) => {
      const base = rs ?? orderIds.map((id) => ({ id, status: 'QUEUED' as RowStatus, tracking: null, message: 'Waiting…' }))
      return base.map((r) => (ids.includes(r.id) ? { ...r, status: 'QUEUED', tracking: null, message: 'Waiting…' } : r))
    })
    for (const id of ids) {
      if (stop.current) {
        patch(id, { status: 'SKIPPED', message: 'Stopped before upload' })
        continue
      }
      patch(id, { status: 'UPLOADING', message: 'Processing…' })
      try {
        const r = await bookShipments([id], chosen.id)
        const res = r.results[0]
        if (res?.ok) patch(id, { status: 'SUCCESS', tracking: res.tracking_number ?? null, message: res.tracking_number ? 'Booked' : 'Booked (no tracking ID yet)' })
        else patch(id, { status: 'FAILED', message: res?.error ?? 'The courier did not accept this parcel' })
      } catch (e) {
        patch(id, { status: 'FAILED', message: (e as Error).message })
      }
    }
    setRunning(false)
    onDone()
  }

  const total = rows?.length ?? orderIds.length
  const done = rows?.filter((r) => r.status === 'SUCCESS' || r.status === 'FAILED' || r.status === 'SKIPPED').length ?? 0
  const success = rows?.filter((r) => r.status === 'SUCCESS').length ?? 0
  const failed = rows?.filter((r) => r.status === 'FAILED').length ?? 0
  const pct = total ? (done / total) * 100 : 0
  const finished = rows !== null && !running

  return (
    <Dialog open={open} onOpenChange={(o) => !running && onOpenChange(o)}>
      <DialogContent showCloseButton={!running} className="gap-4 sm:max-w-2xl">
        {rows === null ? (
          <>
            <DialogHeader>
              <DialogTitle>Upload {orderIds.length} parcel{orderIds.length === 1 ? '' : 's'} to a courier</DialogTitle>
              <DialogDescription>Each order is sent to the courier's API one by one; you see every tracking ID as it comes back. Orders already booked are skipped.</DialogDescription>
            </DialogHeader>
            {couriers.isLoading ? <Spinner /> : connected.length === 0 ? (
              <p className="text-sm text-muted-foreground">No courier is connected yet. <Link to="/admin/couriers" className="underline">Connect Steadfast, Pathao or RedX</Link> first.</p>
            ) : (
              <Select value={chosen?.id} onValueChange={setCourierId}>
                <SelectTrigger aria-label="Courier"><SelectValue /></SelectTrigger>
                <SelectContent>{connected.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
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
                {running ? `Processing (${done}/${total})` : failed ? `Done · ${failed} failed` : 'All booked'}
              </Badge>
            </div>

            <Road pct={pct} running={running} rows={rows} />

            <div className="flex flex-wrap items-center justify-between gap-2 text-sm" aria-live="polite">
              <span className="font-medium tabular-nums">Progress: {done} / {total}</span>
              <span className="tabular-nums text-muted-foreground">Success <b className="text-foreground">{success}</b><span className="ml-4">Failed <b className="text-foreground">{failed}</b></span></span>
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
                    const url = r.tracking ? trackingUrl(chosen, r.tracking) : null
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
                <Button variant="outline" onClick={() => { stop.current = true }}><Square /> Stop after this parcel</Button>
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

/** The road: one checkpoint per parcel (filled booked, hollow failed); the van drives to the current progress. */
function Road({ pct, running, rows }: { pct: number; running: boolean; rows: Row[] }) {
  return (
    <div className="relative h-16 select-none" aria-hidden>
      <div className="absolute inset-x-0 bottom-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-foreground transition-[width] duration-500 ease-out" style={{ width: `${pct}%` }} />
      </div>
      <div className={cn('absolute inset-x-0 bottom-1 h-0.5 opacity-30', running && 'booking-road')} />
      {rows.length <= 40 && rows.map((r, i) => (
        <span key={r.id} title={r.status}
          className={cn('absolute bottom-2.5 size-2.5 -translate-x-1/2 rounded-[3px] border transition-colors',
            r.status === 'SUCCESS' ? 'border-foreground bg-foreground' : r.status === 'FAILED' ? 'rotate-45 border-2 border-foreground bg-background'
              : r.status === 'UPLOADING' ? 'animate-pulse border-foreground bg-muted-foreground' : 'border-muted-foreground/50 bg-muted')}
          style={{ left: `${((i + 1) / rows.length) * 100}%` }} />
      ))}
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
