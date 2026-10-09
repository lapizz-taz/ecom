import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Truck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { bookShipments, listCouriers } from '@/services/couriers'

type Result = Awaited<ReturnType<typeof bookShipments>>

/**
 * Books the selected orders with a connected courier's API in one go. While
 * the courier answers, parcels roll into a van; afterwards each order shows
 * its tracking number or why it was not booked.
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
  const [result, setResult] = useState<Result | null>(null)
  const chosen = connected.find((c) => c.id === courierId) ?? connected[0]
  const book = useMutation({
    mutationFn: () => bookShipments(orderIds, chosen!.id),
    onSuccess: (r) => { setResult(r); onDone() },
  })
  // A fresh start each time the dialog opens.
  useEffect(() => { if (open) { setResult(null); book.reset() } }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const busy = book.isPending
  const failed = result?.results.filter((r) => !r.ok) ?? []
  const n = orderIds.length

  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent showCloseButton={!busy} className="sm:max-w-md">
        {busy ? (
          <div className="grid justify-items-center gap-4 py-4 text-center" role="status" aria-live="polite">
            <BookingScene />
            <div>
              <DialogTitle className="text-base">Booking {n} parcel{n === 1 ? '' : 's'} with {chosen?.name}</DialogTitle>
              <DialogDescription className="mt-1">Sending each order to {chosen?.name}. Keep this open; it takes a few seconds per parcel.</DialogDescription>
            </div>
          </div>
        ) : result ? (
          <div className="grid gap-4">
            <div className="grid justify-items-center gap-3 pt-2 text-center">
              <ResultMark ok={failed.length === 0} />
              <div>
                <DialogTitle className="text-base">
                  {result.booked > 0 ? `${result.booked} parcel${result.booked === 1 ? '' : 's'} booked with ${chosen?.name}` : 'No parcels were booked'}
                </DialogTitle>
                <DialogDescription className="mt-1">
                  {failed.length ? `${failed.length} could not be booked; fix them and try again.` : 'Tracking numbers are saved and print on the labels.'}
                </DialogDescription>
              </div>
            </div>
            <ul className="max-h-60 divide-y overflow-y-auto rounded-xl border text-sm">
              {result.results.map((r, i) => (
                <li key={r.order_id} className="pop-in flex items-start justify-between gap-3 px-3 py-2" style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}>
                  <span className="font-medium">{orderNumber(r.order_id)}</span>
                  {r.ok
                    ? <span className="font-mono text-xs text-emerald-600">{r.tracking_number ?? 'Booked'}</span>
                    : <span className="max-w-60 text-right text-xs text-red-600">{r.error}</span>}
                </li>
              ))}
            </ul>
            <DialogFooter><Button onClick={() => onOpenChange(false)}>Done</Button></DialogFooter>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Book {n} parcel{n === 1 ? '' : 's'} with a courier</DialogTitle>
              <DialogDescription>Each order is sent to the courier's API; the tracking number is saved and printed on the label. Orders already booked are skipped.</DialogDescription>
            </DialogHeader>
            {couriers.isLoading ? <Spinner /> : connected.length === 0 ? (
              <p className="text-sm text-muted-foreground">No courier is connected yet. <Link to="/admin/couriers" className="underline">Connect Steadfast, Pathao or RedX</Link> first.</p>
            ) : (
              <Select value={chosen?.id} onValueChange={setCourierId}>
                <SelectTrigger aria-label="Courier"><SelectValue /></SelectTrigger>
                <SelectContent>{connected.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
              </Select>
            )}
            {book.error && <p className="text-sm text-red-600">{(book.error as Error).message}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => book.mutate()} disabled={!chosen}><Truck /> Book parcels</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}

function BookingScene() {
  return (
    <div className="relative h-24 w-64 overflow-hidden" aria-hidden>
      {[0, 0.55, 1.1].map((delay) => (
        <div key={delay} className="booking-parcel absolute bottom-6 left-16 size-6 rounded-[5px] border-2 border-amber-700/70 bg-amber-400"
          style={{ animationDelay: `${delay}s` }}>
          <div className="mx-auto h-full w-1 bg-amber-700/40" />
        </div>
      ))}
      <svg viewBox="0 0 72 44" className="booking-van absolute right-6 bottom-4 h-14 w-24 text-foreground">
        <rect x="2" y="6" width="42" height="26" rx="3" className="fill-current" />
        <path d="M44 14h14l10 10v8H44z" className="fill-current" />
        <path d="M48 17h9l6 6h-15z" className="fill-background/80" />
        <circle cx="14" cy="34" r="6" className="fill-background stroke-current" strokeWidth="3" />
        <circle cx="56" cy="34" r="6" className="fill-background stroke-current" strokeWidth="3" />
      </svg>
      <div className="booking-road absolute inset-x-0 bottom-3 h-0.5 opacity-40" />
    </div>
  )
}

function ResultMark({ ok }: { ok: boolean }) {
  return (
    <div className={cn('pop-in grid size-14 place-items-center rounded-full', ok ? 'bg-emerald-500/15 text-emerald-600' : 'bg-amber-500/15 text-amber-600')}>
      {ok ? (
        <svg viewBox="0 0 24 24" className="size-8" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path className="draw-check" d="M5 12.5l4.5 4.5L19 7.5" />
        </svg>
      ) : <AlertTriangle className="size-7" />}
    </div>
  )
}
