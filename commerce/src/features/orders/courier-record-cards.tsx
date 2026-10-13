import { useMutation, useQuery } from '@tanstack/react-query'
import { Gauge, RefreshCw, Store } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAuth } from '@/features/auth/auth-context'
import { invokeFunction } from '@/lib/functions'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type CourierLineRecord, orderCustomerRecord } from '@/services/orders'

// The customer's delivery record: one panel, a small card per source — our own
// orders, the overall courier rate, then each courier with its mark and colour.
// The figures come from the latest courier check (BD Courier and the couriers'
// own panels, merged per courier).

/** Simple marks in each courier's colours (not the couriers' official artwork). */
const MARKS: Record<string, ReactNode> = {
  pathao: (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden><circle cx="12" cy="12" r="12" fill="#e4312b" />
      <path d="M9 17.5V7h3.6a3.3 3.3 0 0 1 0 6.6H9" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
  ),
  steadfast: (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden><circle cx="12" cy="12" r="12" fill="#13a281" />
      <path d="M6.5 11.6 17.5 7l-4.6 11-2-4.4-4.4-2Z" fill="#fff" /></svg>
  ),
  redx: (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden><rect width="24" height="24" rx="6" fill="#e01e26" />
      <path d="m8 8 8 8M16 8l-8 8" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" /></svg>
  ),
  carrybee: (
    <svg viewBox="0 0 24 24" className="size-5" aria-hidden><circle cx="12" cy="12" r="12" fill="#f2c200" />
      <ellipse cx="12" cy="13" rx="4.2" ry="5" fill="#1c1917" /><path d="M8 11.5h8M8 14.5h8" stroke="#f2c200" strokeWidth="1.4" />
      <ellipse cx="8.4" cy="7.6" rx="2.4" ry="1.6" fill="#fff" opacity=".9" /><ellipse cx="15.6" cy="7.6" rx="2.4" ry="1.6" fill="#fff" opacity=".9" /></svg>
  ),
}

const COURIERS: Record<string, { name: string; color: string }> = {
  pathao: { name: 'Pathao', color: '#e4312b' },
  steadfast: { name: 'Steadfast', color: '#13a281' },
  redx: { name: 'RedX', color: '#e01e26' },
  carrybee: { name: 'CarryBee', color: '#e0b100' },
}
/** Always shown, even with no parcels, so staff see at a glance who has nothing. */
const ALWAYS = ['pathao', 'steadfast', 'redx', 'carrybee']

const keyOf = (courier: string) => courier.toLowerCase().replace(/[^a-z]/g, '')
const pct = (rate: number | null | undefined) => (rate === null || rate === undefined ? '—' : `${Math.round(rate)}%`)
const rateColor = (rate: number | null | undefined) =>
  rate === null || rate === undefined ? '#a1a1aa' : rate >= 80 ? '#10b981' : rate >= 50 ? '#f59e0b' : '#ef4444'

function lineRate(c: CourierLineRecord): number | null {
  if (c.success_ratio !== undefined && c.success_ratio !== null) return c.success_ratio
  return c.orders > 0 ? (c.delivered / c.orders) * 100 : null
}

function Tile({ icon, name, fill, color, value, detail, warn }: {
  icon: ReactNode; name: string; fill: number | null | undefined; color: string; value: ReactNode; detail?: ReactNode; warn?: boolean
}) {
  return (
    <div className="min-w-0 rounded-xl border bg-background/40 px-3.5 py-3">
      <div className="flex items-center gap-2">
        <span className="grid size-5 shrink-0 place-items-center">{icon}</span>
        <span className="truncate text-sm">{name}</span>
      </div>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.min(Math.max(fill ?? 0, 0), 100)}%`, background: color }} />
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className="text-sm font-medium tabular-nums">{value}</span>
        {detail !== undefined && <span className={cn('truncate text-[11px] tabular-nums', warn ? 'text-amber-500' : 'text-muted-foreground')}>{detail}</span>}
      </div>
    </div>
  )
}

/** The delivery record panel for an order's customer (staff only; the record needs orders.view). */
export function CourierRecordCards({ orderId, phone, className }: { orderId: string; phone: string; className?: string }) {
  const { can } = useAuth()
  const record = useQuery({ queryKey: ['order-record', orderId], queryFn: () => orderCustomerRecord(orderId) })
  const recheck = useMutation({
    mutationFn: () => invokeFunction<{ check?: { status?: string; error?: string | null } }>('fraud-check', { phone }),
    onSuccess: (r) => {
      const c = r?.check
      if (c?.status && c.status !== 'SUCCESS' && c.error) toast.error(c.error)
      else toast.success('Delivery record refreshed')
      void record.refetch()
    },
    onError: (e) => toast.error(e),
  })
  if (record.isLoading) return <div className={cn('h-56 animate-pulse rounded-2xl border bg-muted/40', className)} />
  if (record.error || !record.data) return null

  const { check, ours } = record.data
  const lines = (check?.couriers ?? []) as CourierLineRecord[]
  const byKey = new Map(lines.map((c) => [keyOf(c.courier), c]))
  const extra = lines.map((c) => keyOf(c.courier)).filter((k) => !ALWAYS.includes(k) && (byKey.get(k)!.orders > 0 || byKey.get(k)!.rate_only))
  const earlier = Math.max((ours?.total ?? 0) - 1, 0)
  const ourRate = earlier > 0 ? ((ours?.delivered ?? 0) / earlier) * 100 : null

  return (
    <section className={cn('rounded-2xl border bg-card px-4 pt-4 pb-4 sm:px-5', className)}>
      <div className="flex items-center justify-between gap-3 border-b pb-3">
        <h3 className="text-base font-medium">Delivery record</h3>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{check ? `Checked ${timeAgo(check.checked_at)}` : 'Not checked yet'}</span>
          {can('fraud.review') && (
            <button type="button" onClick={() => recheck.mutate()} disabled={recheck.isPending} aria-label="Check the delivery record again"
              className="rounded-md p-1 hover:bg-muted hover:text-foreground disabled:opacity-50">
              <RefreshCw className={cn('size-3.5', recheck.isPending && 'animate-spin')} />
            </button>
          )}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tile icon={<Store className="size-4 text-violet-400" />} name="Our record" fill={ourRate} color="#a78bfa"
          value={earlier === 0 ? 'New' : `${earlier} order${earlier === 1 ? '' : 's'}`}
          detail={earlier === 0 ? 'first order' : `${ours?.delivered ?? 0} delivered`} />
        <Tile icon={<Gauge className="size-4 text-indigo-400" />} name="Overall" fill={check?.rate} color={rateColor(check?.rate)}
          value={pct(check?.rate)} detail={check && check.total > 0 ? `${check.total} parcels` : 'no parcels'} />
        {[...ALWAYS, ...extra].map((k) => {
          const c = byKey.get(k)
          const brand = COURIERS[k]
          const name = brand?.name ?? c?.name ?? k
          const color = brand?.color ?? '#71717a'
          const icon = MARKS[k] ?? <span className="size-4 rounded-full" style={{ background: color }} />
          if (c?.rate_only) return <Tile key={k} icon={icon} name={name} fill={c.success_ratio} color={color} value={pct(c.success_ratio)} detail={c.parcel_range ? `${c.parcel_range} parcels` : 'rate only'} />
          const rate = c ? lineRate(c) : null
          return (
            <Tile key={k} icon={icon} name={name} fill={rate} color={color} value={pct(rate)}
              detail={c?.notice ? 'couldn’t check' : (c?.orders ?? 0) > 0 ? <>{c!.delivered}/{c!.orders}<span className="hidden sm:inline"> delivered</span></> : 'no parcels'} warn={!!c?.notice} />
          )
        })}
      </div>
    </section>
  )
}
