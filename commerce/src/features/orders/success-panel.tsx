import { useMutation, useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import { toast } from '@/lib/toast'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAuth } from '@/features/auth/auth-context'
import { invokeFunction } from '@/lib/functions'
import { timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { type CourierLineRecord, orderCustomerRecord } from '@/services/orders'

const COURIER_NAME: Record<string, string> = {
  pathao: 'Pathao', steadfast: 'Steadfast', redx: 'RedX', carrybee: 'CarryBee', paperfly: 'Paperfly', parceldex: 'ParcelDex', courierfast: 'CourierFast',
}

export const courierName = (c: CourierLineRecord) =>
  c.name ?? COURIER_NAME[c.courier.replace(/[^a-z]/g, '')] ?? c.courier.replace(/^\w/, (x) => x.toUpperCase())

/** Green / amber / red only for the rate itself; everything else stays grey. */
export function rateColor(rate: number | null | undefined) {
  if (rate === null || rate === undefined) return { text: 'text-muted-foreground', bar: 'bg-muted-foreground' }
  return rate >= 80 ? { text: 'text-emerald-500', bar: 'bg-emerald-500' }
    : rate >= 50 ? { text: 'text-amber-500', bar: 'bg-amber-500' } : { text: 'text-red-500', bar: 'bg-red-500' }
}

/** The customer's delivery record for an order: the courier check's rate, per-courier breakdown and our own orders. */
export function SuccessPanel({ orderId, phone, compact }: { orderId: string; phone: string; compact?: boolean }) {
  const { can } = useAuth()
  const record = useQuery({ queryKey: ['order-record', orderId], queryFn: () => orderCustomerRecord(orderId) })
  const recheck = useMutation({
    mutationFn: () => invokeFunction('fraud-check', { phone }),
    onSuccess: () => { toast.success('Courier history refreshed'); void record.refetch() },
  })
  if (record.isLoading) return <div className="grid place-items-center py-6"><Spinner /></div>
  if (record.error) return <p className="text-sm text-muted-foreground">Could not load the record.</p>
  const check = record.data?.check
  const ours = record.data?.ours
  const couriers = (check?.couriers ?? []) as CourierLineRecord[]
  const tone = rateColor(check?.rate)

  return (
    <div className={cn('space-y-3 text-sm', compact && 'text-xs')}>
      {check ? (
        <>
          <div>
            <p className="flex items-baseline gap-2">
              <span className={cn('text-2xl font-semibold tabular-nums', tone.text)}>{check.rate === null ? '—' : `${Math.round(check.rate)}%`}</span>
              <span className="text-xs text-muted-foreground">success rate</span>
            </p>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
              <div className={cn('h-full rounded-full', tone.bar)} style={{ width: `${Math.min(Math.max(check.rate ?? 0, 0), 100)}%` }} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <Stat label="Orders" value={check.total} />
            <Stat label="Delivered" value={check.delivered} />
            <Stat label="Cancelled" value={check.cancelled} />
          </div>
          {couriers.length > 0 && (
            <div className="border-t pt-2">
              <p className="mb-1.5 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Breakdown</p>
              <ul className="space-y-1">
                {couriers.map((c) => (
                  <li key={c.courier} className="flex justify-between gap-3">
                    <span>{courierName(c)}</span>
                    <span className="font-medium tabular-nums">{c.rate_only ? (c.parcel_range ?? '—') : `${c.delivered}/${c.orders}`}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      ) : <p className="text-muted-foreground">No courier check for this number yet.</p>}
      {ours && (
        <p className="border-t pt-2 text-xs text-muted-foreground">
          With us: <b className="text-foreground">{ours.total}</b> order{ours.total === 1 ? '' : 's'} · {ours.delivered} delivered · {ours.returned} returned · {ours.cancelled} cancelled
        </p>
      )}
      <div className="flex items-center justify-between gap-2 border-t pt-2">
        <span className="text-[11px] text-muted-foreground">{check ? `Latest courier rating · ${timeAgo(check.checked_at)}` : ''}</span>
        {can('fraud.review') && (
          <Button size="sm" variant="outline" className="h-7" onClick={() => recheck.mutate()} disabled={recheck.isPending}>
            <RefreshCw className={cn(recheck.isPending && 'animate-spin')} /> Refresh
          </Button>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border px-2 py-1.5">
      <p className="text-[10px] tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  )
}

/** The rate shown in a list row; click it for the full record. */
export function SuccessRateButton({ orderId, phone, rate, className, children }: { orderId: string; phone: string; rate: number; className?: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" className={cn('font-semibold tabular-nums underline decoration-dotted underline-offset-2 hover:opacity-80', rateColor(rate).text, className)}
          aria-label={`Delivery success ${Math.round(rate)}%, show details`} onClick={(e) => e.stopPropagation()}>
          {children ?? `${Math.round(rate)}%`}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72" align="start" onClick={(e) => e.stopPropagation()}>
        {open && <SuccessPanel orderId={orderId} phone={phone} />}
      </PopoverContent>
    </Popover>
  )
}
