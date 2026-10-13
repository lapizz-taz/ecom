import { useMutation, useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { useAuth } from '@/features/auth/auth-context'
import { invokeFunction } from '@/lib/functions'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type CourierLineRecord, orderCustomerRecord } from '@/services/orders'

// The customer's delivery record as a row of cards: our own orders, the overall
// courier rate, then one card per courier (its brand colour as a thin line). The
// figures come from the latest courier check — BD Courier and the couriers' own
// panels, merged per courier.

const BRANDS: Record<string, { name: string; color: string }> = {
  pathao: { name: 'Pathao', color: '#e4312b' },
  steadfast: { name: 'Steadfast', color: '#13a281' },
  redx: { name: 'RedX', color: '#e01e26' },
  carrybee: { name: 'CarryBee', color: '#f2c200' },
}
/** Always shown, even with no parcels, so staff see at a glance who has nothing. */
const ALWAYS = ['pathao', 'steadfast', 'redx', 'carrybee']

const keyOf = (courier: string) => courier.toLowerCase().replace(/[^a-z]/g, '')

function tone(rate: number | null | undefined) {
  if (rate === null || rate === undefined) return { text: 'text-muted-foreground', bar: 'bg-muted-foreground/30' }
  return rate >= 80 ? { text: 'text-emerald-500', bar: 'bg-emerald-500' } : rate >= 50 ? { text: 'text-amber-500', bar: 'bg-amber-500' } : { text: 'text-red-500', bar: 'bg-red-500' }
}

function lineRate(c: CourierLineRecord): number | null {
  if (c.success_ratio !== undefined && c.success_ratio !== null) return c.success_ratio
  return c.orders > 0 ? (c.delivered / c.orders) * 100 : null
}

function Card({ title, accent, action, children }: { title: string; accent?: string; action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2 overflow-hidden rounded-xl border bg-card px-3 pt-2.5 pb-3" style={accent ? { boxShadow: `inset 0 3px 0 ${accent}` } : undefined}>
      <div className="flex h-5 items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium">
          {accent && <span className="size-2 shrink-0 rounded-full" style={{ background: accent }} />}
          <span className="truncate">{title}</span>
        </span>
        {action}
      </div>
      {children}
    </div>
  )
}

/** Big rate, a thin bar, and one line of counts. */
function Stat({ rate, total, delivered, cancelled, note }: { rate: number | null | undefined; total: number; delivered: number; cancelled: number; note?: string | null }) {
  const t = tone(rate)
  return (
    <>
      <p className={cn('text-2xl leading-none font-semibold tabular-nums', t.text)}>{rate === null || rate === undefined ? '—' : `${Math.round(rate)}%`}</p>
      <div className="h-1 overflow-hidden rounded-full bg-muted">
        <div className={cn('h-full rounded-full', t.bar)} style={{ width: `${Math.min(Math.max(rate ?? 0, 0), 100)}%` }} />
      </div>
      {note ? (
        <p className="truncate text-[11px] text-amber-500" title={note}>Could not check</p>
      ) : total > 0 ? (
        <p className="truncate text-[11px] text-muted-foreground tabular-nums">
          <b className="font-medium text-foreground">{total}</b> · {delivered} ok · {cancelled} cancelled
        </p>
      ) : (
        <p className="text-[11px] text-muted-foreground">No parcels</p>
      )}
    </>
  )
}

/** The delivery record cards for an order's customer (staff only; the record needs orders.view). */
export function CourierRecordCards({ orderId, phone, className }: { orderId: string; phone: string; className?: string }) {
  const { can } = useAuth()
  const record = useQuery({ queryKey: ['order-record', orderId], queryFn: () => orderCustomerRecord(orderId) })
  const recheck = useMutation({
    mutationFn: () => invokeFunction<{ check?: { status?: string; error?: string | null } }>('fraud-check', { phone }),
    onSuccess: (r) => {
      const c = r?.check
      if (c?.status && c.status !== 'SUCCESS' && c.error) toast.error(c.error)
      else toast.success('Courier record refreshed')
      void record.refetch()
    },
    onError: (e) => toast.error(e),
  })
  if (record.isLoading) return <div className={cn('h-[6.5rem] animate-pulse rounded-xl border bg-muted/40', className)} />
  if (record.error || !record.data) return null

  const { check, ours } = record.data
  const lines = (check?.couriers ?? []) as CourierLineRecord[]
  const byKey = new Map(lines.map((c) => [keyOf(c.courier), c]))
  const extra = lines.map((c) => keyOf(c.courier)).filter((k) => !ALWAYS.includes(k) && (byKey.get(k)!.orders > 0 || byKey.get(k)!.rate_only))
  const earlier = Math.max((ours?.total ?? 0) - 1, 0)
  const refresh = can('fraud.review') && (
    <button type="button" onClick={() => recheck.mutate()} disabled={recheck.isPending} aria-label="Check the courier record again"
      className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50">
      <RefreshCw className={cn('size-3.5', recheck.isPending && 'animate-spin')} />
    </button>
  )

  return (
    <div className={cn('space-y-1.5', className)}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <Card title="Our record">
          <p className="text-2xl leading-none font-semibold tabular-nums">{earlier}</p>
          <div className="h-1" />
          <p className="truncate text-[11px] text-muted-foreground">
            {earlier === 0 ? 'New customer' : `${ours?.delivered ?? 0} delivered · ${ours?.returned ?? 0} returned · ${ours?.cancelled ?? 0} cancelled`}
          </p>
        </Card>

        <Card title="Overall" action={refresh}>
          {check
            ? <Stat rate={check.rate} total={check.total} delivered={check.delivered} cancelled={check.cancelled} />
            : <Stat rate={null} total={0} delivered={0} cancelled={0} />}
        </Card>

        {[...ALWAYS, ...extra].map((k) => {
          const c = byKey.get(k)
          const brand = BRANDS[k]
          const title = brand?.name ?? c?.name ?? k
          return (
            <Card key={k} title={title} accent={brand?.color ?? '#71717a'}>
              {c?.rate_only ? (
                <>
                  <p className={cn('text-2xl leading-none font-semibold tabular-nums', tone(c.success_ratio).text)}>{c.success_ratio == null ? '—' : `${Math.round(c.success_ratio)}%`}</p>
                  <div className="h-1" />
                  <p className="text-[11px] text-muted-foreground">{c.parcel_range ? `${c.parcel_range} parcels` : 'Rate only'}</p>
                </>
              ) : (
                <Stat rate={c ? lineRate(c) : null} total={c?.orders ?? 0} delivered={c?.delivered ?? 0} cancelled={c?.cancelled ?? 0} note={c?.notice} />
              )}
            </Card>
          )
        })}
      </div>
      <p className="text-right text-[10px] text-muted-foreground">{check ? `Checked ${timeAgo(check.checked_at)}` : 'Not checked with the couriers yet'}</p>
    </div>
  )
}
