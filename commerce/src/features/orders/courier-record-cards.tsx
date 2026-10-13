import { useMutation, useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { useAuth } from '@/features/auth/auth-context'
import { invokeFunction } from '@/lib/functions'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type CourierLineRecord, orderCustomerRecord } from '@/services/orders'

// The customer's delivery record as a row of cards: our own orders, the overall
// courier rate, then one card per courier in its brand colour. The figures come
// from the latest courier check (BD Courier and the couriers' own panels, merged).

const BRANDS: Record<string, { name: string; style: CSSProperties }> = {
  pathao: { name: 'Pathao', style: { background: '#e4312b', color: '#fff' } },
  steadfast: { name: 'Steadfast', style: { background: '#13a281', color: '#fff' } },
  redx: { name: 'RedX', style: { background: '#e01e26', color: '#fff' } },
  carrybee: { name: 'CarryBee', style: { background: '#f6c800', color: '#1c1917' } },
  paperfly: { name: 'Paperfly', style: { background: '#1f5fbf', color: '#fff' } },
}
/** Always shown, even with no parcels, so staff see at a glance who has nothing. */
const ALWAYS = ['pathao', 'steadfast', 'redx', 'carrybee']
const OTHER_STYLE: CSSProperties = { background: '#52525b', color: '#fff' }

const keyOf = (courier: string) => courier.toLowerCase().replace(/[^a-z]/g, '')

function tone(rate: number | null | undefined) {
  if (rate === null || rate === undefined) return { text: 'text-muted-foreground', bar: 'bg-muted-foreground/40' }
  return rate >= 80 ? { text: 'text-emerald-500', bar: 'bg-emerald-500' } : rate >= 50 ? { text: 'text-amber-500', bar: 'bg-amber-500' } : { text: 'text-red-500', bar: 'bg-red-500' }
}

const pct = (rate: number | null | undefined) => (rate === null || rate === undefined ? '—' : `${Math.round(rate)}%`)

function lineRate(c: CourierLineRecord): number | null {
  if (c.success_ratio !== undefined && c.success_ratio !== null) return c.success_ratio
  return c.orders > 0 ? (c.delivered / c.orders) * 100 : null
}

function RecordCard({ title, headerStyle, headerClass, action, children, className }: {
  title: ReactNode; headerStyle?: CSSProperties; headerClass?: string; action?: ReactNode; children: ReactNode; className?: string
}) {
  return (
    <div className={cn('min-w-0 overflow-hidden rounded-lg border bg-card text-[11px]', className)}>
      <div className={cn('flex h-7 items-center justify-between gap-1 px-2.5 text-xs font-semibold', headerClass)} style={headerStyle}>
        <span className="truncate">{title}</span>
        {action}
      </div>
      <div className="space-y-0.5 px-2.5 py-2">{children}</div>
    </div>
  )
}

function Line({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={cn('font-semibold tabular-nums', className)}>{value}</span>
    </div>
  )
}

function Bar({ rate }: { rate: number | null | undefined }) {
  return (
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
      <div className={cn('h-full rounded-full', tone(rate).bar)} style={{ width: `${Math.min(Math.max(rate ?? 0, 0), 100)}%` }} />
    </div>
  )
}

function StatCard({ title, style, rate, total, delivered, cancelled, note, action }: {
  title: ReactNode; style: CSSProperties; rate: number | null | undefined; total: ReactNode; delivered: ReactNode; cancelled: ReactNode; note?: string | null; action?: ReactNode
}) {
  return (
    <RecordCard title={title} headerStyle={style} action={action}>
      <Line label="Success Rate" value={pct(rate)} className={tone(rate).text} />
      <Line label="Total" value={total} />
      <Line label="Success" value={delivered} />
      <Line label="Cancelled" value={cancelled} />
      {note ? <p className="truncate pt-1 text-[10px] text-amber-500" title={note}>{note}</p> : <Bar rate={rate} />}
    </RecordCard>
  )
}

/** The delivery record cards for an order's customer (staff only; the record needs orders.view). */
export function CourierRecordCards({ orderId, phone, className }: { orderId: string; phone: string; className?: string }) {
  const { can } = useAuth()
  const record = useQuery({ queryKey: ['order-record', orderId], queryFn: () => orderCustomerRecord(orderId) })
  const recheck = useMutation({
    mutationFn: () => invokeFunction('fraud-check', { phone }),
    onSuccess: () => { toast.success('Courier record refreshed'); void record.refetch() },
    onError: (e) => toast.error(e),
  })
  if (record.isLoading) return <div className={cn('h-[7.5rem] animate-pulse rounded-lg border bg-muted/40', className)} />
  if (record.error || !record.data) return null

  const { check, ours } = record.data
  const lines = (check?.couriers ?? []) as Array<CourierLineRecord & { notice?: string | null }>
  const byKey = new Map(lines.map((c) => [keyOf(c.courier), c]))
  const keys = [...ALWAYS, ...lines.map((c) => keyOf(c.courier)).filter((k) => !ALWAYS.includes(k) && (byKey.get(k)!.orders > 0 || byKey.get(k)!.rate_only))]
  const earlier = Math.max((ours?.total ?? 0) - 1, 0)
  const refresh = can('fraud.review') && (
    <button type="button" onClick={() => recheck.mutate()} disabled={recheck.isPending} aria-label="Check the courier record again" className="rounded p-0.5 hover:bg-black/10 disabled:opacity-50">
      <RefreshCw className={cn('size-3', recheck.isPending && 'animate-spin')} />
    </button>
  )

  return (
    <div className={cn('space-y-1', className)}>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
        <RecordCard title="Our Record" headerStyle={{ background: '#d8b4fe', color: '#2e1065' }}>
          {earlier === 0 ? (
            <p className="py-1 font-medium">New customer <span className="font-normal text-muted-foreground">· no orders before</span></p>
          ) : (
            <>
              <Line label="Orders" value={earlier} />
              <Line label="Delivered" value={ours?.delivered ?? 0} />
              <Line label="Returned" value={ours?.returned ?? 0} />
              <Line label="Cancelled" value={ours?.cancelled ?? 0} />
            </>
          )}
          {(ours?.in_progress ?? 0) > 0 && <Line label="In progress" value={ours!.in_progress} />}
        </RecordCard>

        {check ? (
          <StatCard title="Overall" style={{ background: '#c4b5fd', color: '#1e1b4b' }} rate={check.rate} total={check.total} delivered={check.delivered} cancelled={check.cancelled} action={refresh} />
        ) : (
          <RecordCard title="Overall" headerStyle={{ background: '#c4b5fd', color: '#1e1b4b' }} action={refresh}>
            <p className="py-1 text-muted-foreground">Not checked with the couriers yet.</p>
            {can('fraud.review') && <button type="button" className="font-medium underline underline-offset-2" onClick={() => recheck.mutate()} disabled={recheck.isPending}>Check now</button>}
          </RecordCard>
        )}

        {keys.map((k) => {
          const c = byKey.get(k)
          const brand = BRANDS[k]
          const title = brand?.name ?? c?.name ?? k
          if (c?.rate_only) {
            return <StatCard key={k} title={title} style={brand?.style ?? OTHER_STYLE} rate={c.success_ratio} total={c.parcel_range ?? '—'} delivered="—" cancelled="—" />
          }
          return (
            <StatCard key={k} title={title} style={brand?.style ?? OTHER_STYLE} rate={c ? lineRate(c) : null}
              total={c?.orders ?? 0} delivered={c?.delivered ?? 0} cancelled={c?.cancelled ?? 0} note={c?.notice ? 'Could not check' : null} />
          )
        })}
      </div>
      {check && <p className="text-right text-[10px] text-muted-foreground">Checked {timeAgo(check.checked_at)}</p>}
    </div>
  )
}
