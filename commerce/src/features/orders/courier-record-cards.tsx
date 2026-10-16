import { useMutation, useQuery } from '@tanstack/react-query'
import { Gauge, RefreshCw, Store } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'
import { Reveal } from '@/components/common/reveal'
import { useAuth } from '@/features/auth/auth-context'
import { invokeFunction } from '@/lib/functions'
import { timeAgo } from '@/lib/format'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { type CourierLineRecord, type DeliveryPolicy, type OrderCustomerRecord, orderCustomerRecord, type PhoneCustomerRecord, phoneCustomerRecord } from '@/services/orders'
import { deliveryRisk, type RiskLevel } from './delivery-risk'

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
const rateColor = (rate: number | null | undefined, p?: DeliveryPolicy | null) =>
  rate === null || rate === undefined ? '#a1a1aa' : rate >= (p?.good_min ?? 80) ? '#10b981' : rate >= (p?.mid_min ?? 50) ? '#f59e0b' : '#ef4444'
const RISK_TONE: Record<RiskLevel, string> = {
  low: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  medium: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  high: 'bg-red-500/10 text-red-600 dark:text-red-400',
  insufficient: 'bg-muted text-muted-foreground',
  unavailable: 'bg-sky-500/10 text-sky-600 dark:text-sky-400',
  unchecked: 'bg-muted text-muted-foreground',
}
const SOURCE: Record<string, string> = { bd_courier: 'BD Courier', sign_in: 'sign-in' }

function lineRate(c: CourierLineRecord): number | null {
  if (c.success_ratio !== undefined && c.success_ratio !== null) return c.success_ratio
  return c.orders > 0 ? (c.delivered / c.orders) * 100 : null
}

/** Each tile's bar and shimmer start a little after the one before it. */
const stagger = (i: number): CSSProperties => ({ animationDelay: `${i * 110}ms` })

function Tile({ icon, name, fill, color, value, detail, warn, tag, title, index = 0, busy }: {
  icon: ReactNode; name: string; fill: number | null | undefined; color: string; value: ReactNode; detail?: ReactNode; warn?: boolean
  /** Where the figure came from (BD Courier / sign-in). */ tag?: string; title?: string
  /** Position in the grid (for the staggered entrance). */ index?: number
  /** A fresh check is running: a light sweeps over the bar. */ busy?: boolean
}) {
  return (
    <div className="record-tile min-w-0 rounded-xl border bg-background/40 px-3.5 py-3" style={stagger(index)} title={title}>
      <div className="flex items-center gap-2">
        <span className="grid size-5 shrink-0 place-items-center">{icon}</span>
        <span className="truncate text-sm">{name}</span>
        {tag && <span className="ml-auto hidden shrink-0 text-[10px] text-muted-foreground sm:inline">{tag}</span>}
      </div>
      <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="record-bar h-full rounded-full transition-[width] duration-700 ease-[var(--ease-out)]"
          style={{ width: `${Math.min(Math.max(fill ?? 0, 0), 100)}%`, background: color, ...stagger(index + 2) }} />
        {busy && <span className="record-shimmer absolute inset-y-0 left-0 w-1/2 bg-gradient-to-r from-transparent via-foreground/35 to-transparent" style={stagger(index)} />}
      </div>
      <div className="mt-2 flex flex-wrap items-baseline justify-between gap-x-2">
        <span className="whitespace-nowrap text-sm font-medium tabular-nums">{value}</span>
        {detail !== undefined && <span className={cn('min-w-0 truncate text-[11px] tabular-nums', warn ? 'text-amber-500' : 'text-muted-foreground')}>{detail}</span>}
      </div>
    </div>
  )
}

/** A new order's courier check runs in the background; how long the panel keeps looking for it. */
const CHECK_WAIT_MS = 3 * 60_000
/** A check this much older than the order is a reused one from the same visit (the 30-minute cache). */
const REUSE_MS = 30 * 60_000

/** The delivery record panel for an order's customer (staff only; the record needs orders.view). */
export function CourierRecordCards({ orderId, phone, createdAt, className }: { orderId: string; phone: string; createdAt?: string; className?: string }) {
  const { can } = useAuth()
  const placed = createdAt ? Date.parse(createdAt) : NaN
  const waiting = (d?: OrderCustomerRecord) =>
    Date.now() - placed < CHECK_WAIT_MS && (!d?.check || Date.parse(d.check.checked_at) < placed - REUSE_MS)
  const record = useQuery({
    queryKey: ['order-record', orderId],
    queryFn: () => orderCustomerRecord(orderId),
    refetchInterval: (q) => (waiting(q.state.data) ? 4_000 : false),
  })
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
  if (record.isLoading) return <CheckingPanel className={className} />
  if (record.error || !record.data) return null
  return (
    <DeliveryRecordPanel data={record.data} waiting={waiting(record.data)} className={className} countsCurrentOrder
      onRecheck={can('fraud.review') ? () => recheck.mutate() : undefined} rechecking={recheck.isPending} />
  )
}

/**
 * The same panel for a phone typed on New Order (or an incomplete checkout), before any order exists.
 * The lookup reuses a check from the last half hour, so typing the same number again costs nothing.
 */
export function PhoneRecordCards({ phone, className }: { phone: string; className?: string }) {
  const { can } = useAuth()
  const record = useQuery({
    queryKey: ['phone-record', phone],
    queryFn: () => phoneCustomerRecord(phone),
    staleTime: 5 * 60_000,
    retry: false,
  })
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
  if (record.isLoading) return <CheckingPanel phone={phone} className={className} />
  if (record.error || !record.data) {
    return record.error ? <p className={cn('rounded-xl border px-4 py-3 text-xs text-muted-foreground', className)}>Couldn’t check the delivery record: {(record.error as Error).message}</p> : null
  }
  return (
    <DeliveryRecordPanel data={record.data.record} waiting={false} className={className}
      notice={record.data.lookup_error ? `The courier check could not run: ${record.data.lookup_error}` : !record.data.looked_up && !record.data.record.check ? 'Not checked yet: someone who can create orders or review fraud can run the check.' : undefined}
      onRecheck={can('fraud.review') ? () => recheck.mutate() : undefined} rechecking={recheck.isPending} />
  )
}

const CHECKING_TILES: { key: string; name: string; icon: ReactNode; color: string }[] = [
  { key: 'ours', name: 'Our record', icon: <Store className="size-4 text-violet-400" />, color: '#a78bfa' },
  { key: 'overall', name: 'Overall', icon: <Gauge className="size-4 text-indigo-400" />, color: '#818cf8' },
  ...ALWAYS.map((k) => ({ key: k, name: COURIERS[k].name, icon: MARKS[k], color: COURIERS[k].color })),
]

/** While the record loads: the panel's own shape, each source pulsing and its bar sweeping. */
function CheckingPanel({ phone, className }: { phone?: string; className?: string }) {
  return (
    <section role="status" aria-live="polite" aria-busy="true" className={cn('rounded-2xl border bg-card px-4 pt-4 pb-4 sm:px-5', className)}>
      <div className="relative flex items-center justify-between gap-3 border-b pb-3">
        <h3 className="text-base font-medium">Delivery record</h3>
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          Checking<span className="hidden tabular-nums sm:inline">{phone}</span>
          <span className="flex items-center gap-0.5" aria-hidden>
            {[0, 1, 2].map((i) => <span key={i} className="record-dot size-1 rounded-full bg-current" style={{ animationDelay: `${i * 160}ms` }} />)}
          </span>
        </span>
        <span className="absolute inset-x-0 -bottom-px h-px overflow-hidden" aria-hidden>
          <span className="block h-full w-1/3 animate-[loader_1.4s_var(--ease-in-out)_infinite] bg-gradient-to-r from-transparent via-foreground/50 to-transparent motion-reduce:animate-none" />
        </span>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">Looking up this number in your orders and with Pathao, Steadfast, RedX and CarryBee…</p>
      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3" aria-hidden>
        {CHECKING_TILES.map((t, i) => (
          <div key={t.key} className="record-tile min-w-0 rounded-xl border bg-background/40 px-3.5 py-3" style={stagger(i)}>
            <div className="flex items-center gap-2">
              <span className="relative grid size-5 shrink-0 place-items-center">
                <span className="record-ping absolute inset-0 rounded-full" style={{ boxShadow: `0 0 0 2px ${t.color}`, ...stagger(i) }} />
                {t.icon}
              </span>
              <span className="truncate text-sm text-muted-foreground">{t.name}</span>
            </div>
            <div className="relative mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
              <span className="record-shimmer absolute inset-y-0 left-0 w-1/2 rounded-full" style={{ background: `linear-gradient(90deg, transparent, ${t.color}, transparent)`, ...stagger(i) }} />
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="my-[3px] h-3.5 w-9 animate-pulse rounded bg-muted motion-reduce:animate-none" />
              <span className="h-2.5 w-14 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function DeliveryRecordPanel({ data, waiting, className, countsCurrentOrder = false, onRecheck, rechecking, notice }: {
  data: OrderCustomerRecord | PhoneCustomerRecord; waiting: boolean; className?: string
  /** On an order's page the record includes that order itself. */ countsCurrentOrder?: boolean
  onRecheck?: () => void; rechecking?: boolean; notice?: string
}) {
  const { check, ours, policy } = data
  const risk = deliveryRisk(data as OrderCustomerRecord)
  const lines = (check?.couriers ?? []) as CourierLineRecord[]
  const byKey = new Map(lines.map((c) => [keyOf(c.courier), c]))
  const extra = lines.map((c) => keyOf(c.courier)).filter((k) => !ALWAYS.includes(k) && (byKey.get(k)!.orders > 0 || byKey.get(k)!.rate_only))
  const earlier = Math.max((ours?.total ?? 0) - (countsCurrentOrder ? 1 : 0), 0)
  const from = (src: string) => lines.filter((c) => c.source === src && !c.notice).map((c) => COURIERS[keyOf(c.courier)]?.name ?? c.name ?? c.courier)
  const groups = [
    from('sign_in').length ? `courier sign-ins (${from('sign_in').join(', ')})` : '',
    from('bd_courier').length ? `BD Courier (${from('bd_courier').join(', ')})` : '',
  ].filter(Boolean)
  const sources = groups.length ? `Sources: ${groups.join(' · ')}` : ''
  const ourRate = earlier > 0 ? ((ours?.delivered ?? 0) / earlier) * 100 : null
  const busy = waiting || !!rechecking

  return (
    <section className={cn('rounded-2xl border bg-card px-4 pt-4 pb-4 sm:px-5', className)}>
      <div className="relative flex items-center justify-between gap-3 border-b pb-3">
        <h3 className="text-base font-medium">Delivery record</h3>
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span>{busy ? 'Checking…' : check ? `Checked ${timeAgo(check.checked_at)}` : 'Not checked yet'}</span>
          {onRecheck && (
            <button type="button" onClick={onRecheck} disabled={rechecking} aria-label="Check the delivery record again"
              className="rounded-md p-1 hover:bg-muted hover:text-foreground disabled:opacity-50">
              <RefreshCw className={cn('size-3.5', rechecking && 'animate-spin')} />
            </button>
          )}
        </div>
        {busy && (
          <span className="absolute inset-x-0 -bottom-px h-px overflow-hidden" aria-hidden>
            <span className="block h-full w-1/3 animate-[loader_1.4s_var(--ease-in-out)_infinite] bg-gradient-to-r from-transparent via-foreground/50 to-transparent motion-reduce:animate-none" />
          </span>
        )}
      </div>

      {notice && <p className="mt-3 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">{notice}</p>}
      <Reveal open={!waiting && risk.level !== 'unchecked'} gap="">
        <div className="mt-3 flex flex-col items-start gap-1.5 sm:flex-row sm:gap-3">
          <span className={cn('shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium', RISK_TONE[risk.level])}>{risk.label}</span>
          {risk.reasons.length > 0 && (
            <ul className="min-w-0 flex-1 space-y-0.5 text-xs text-muted-foreground">
              {risk.reasons.map((r) => <li key={r} className="break-words">{r}</li>)}
            </ul>
          )}
        </div>
      </Reveal>

      <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Tile index={0} busy={busy} icon={<Store className="size-4 text-violet-400" />} name="Our record" fill={ourRate} color="#a78bfa"
          value={earlier === 0 ? 'New' : `${earlier} order${earlier === 1 ? '' : 's'}`}
          detail={earlier === 0 ? 'first order' : `${ours?.delivered ?? 0} delivered`} />
        <Tile index={1} busy={busy} icon={<Gauge className="size-4 text-indigo-400" />} name="Overall" fill={check?.rate} color={rateColor(check?.rate, policy)}
          value={pct(check?.rate)}
          title="Delivered ÷ (delivered + cancelled or returned at the door), over the couriers that report parcel counts"
          detail={check && check.total > 0 ? `${check.total} parcels${check.cancelled ? ` · ${check.cancelled} back` : ''}` : 'no parcels'} />
        {[...ALWAYS, ...extra].map((k, i) => {
          const c = byKey.get(k)
          const brand = COURIERS[k]
          const name = brand?.name ?? c?.name ?? k
          const color = brand?.color ?? '#71717a'
          const icon = MARKS[k] ?? <span className="size-4 rounded-full" style={{ background: color }} />
          const tag = c?.source ? SOURCE[c.source] : undefined
          const reports = c?.fraud_reports ? ` · ${c.fraud_reports} report${c.fraud_reports === 1 ? '' : 's'}` : ''
          if (c?.rate_only) {
            return <Tile key={k} index={i + 2} busy={busy} icon={icon} name={name} fill={c.success_ratio} color={color} value={pct(c.success_ratio)} tag={tag}
              title={`${name} reports only its own rate${c.parcel_range ? ` and a volume band (${c.parcel_range})` : ''}, not parcel counts`}
              detail={`${c.parcel_range ? `${c.parcel_range} parcels` : 'rate only'}${reports}`} warn={!!c.fraud_reports} />
          }
          const rate = c ? lineRate(c) : null
          return (
            <Tile key={k} index={i + 2} busy={busy} icon={icon} name={name} fill={rate} color={color} value={pct(rate)} tag={c?.notice ? undefined : tag}
              title={c?.notice ?? undefined}
              detail={c?.notice ? 'couldn’t check' : (c?.orders ?? 0) > 0 ? <>{c!.delivered}/{c!.orders}<span className="hidden sm:inline"> delivered</span>{reports}</> : 'no parcels'}
              warn={!!c?.notice || !!c?.fraud_reports} />
          )
        })}
      </div>
      {sources && <p className="mt-3 text-[11px] text-muted-foreground">{sources}</p>}
    </section>
  )
}
