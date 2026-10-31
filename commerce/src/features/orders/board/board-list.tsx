import { Eye } from 'lucide-react'
import { Link } from 'react-router'
import { DataTable, type Column } from '@/components/common/data-table'
import { Money } from '@/components/common/money'
import { Pagination } from '@/components/common/pagination'
import { EmptyState } from '@/components/common/states'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDateTime, formatMoney, formatNumber } from '@/lib/format'
import { ORDER_STATUS, SHIPMENT_STATUS } from '@/lib/status'
import { cn } from '@/lib/utils'
import type { BoardOrder, OrdersBoard, OrdersBoardOptions } from '@/services/order-tools'
import { type DateBy, splitList, statusChoices, statusInfo, type StatusInfo } from './board-state'

export const PAGE_SIZES = [20, 50, 100, 200]

const DOT: Record<string, string> = {
  success: 'bg-emerald-500', info: 'bg-sky-500', warning: 'bg-amber-500', danger: 'bg-red-500', destructive: 'bg-red-600',
  violet: 'bg-violet-500', neutral: 'bg-zinc-400', outline: 'bg-zinc-400', default: 'bg-foreground', secondary: 'bg-zinc-400',
}

const DATE_WORD: Record<DateBy, string> = { approved: 'Approved', order: 'Ordered', shipped: 'Shipped', delivered: 'Delivered' }

/**
 * How many orders are in each status for the filters (the status filter itself left out).
 * Tapping a status shows only that status; tapping it again shows them all.
 */
export function BoardStatusBar({ board, options, picked, onPick }: {
  board: OrdersBoard | undefined
  options: OrdersBoardOptions | undefined
  picked: string
  onPick: (status: string) => void
}) {
  const counts = new Map((board?.counts ?? []).map((c) => [c.key, c]))
  const chosen = new Set(splitList(picked))
  const all = [...counts.values()].reduce((s, c) => ({ n: s.n + c.n, value: s.value + Number(c.value) }), { n: 0, value: 0 })
  // Known statuses in their usual order, then any the store no longer lists (a removed call status).
  const known = statusChoices(options?.call_statuses)
  const extra = [...counts.keys()].filter((k) => !known.some((s) => s.key === k)).map((k) => statusInfo(k, options?.call_statuses))
  const shown = [...known, ...extra].filter((s) => (counts.get(s.key)?.n ?? 0) > 0 || chosen.has(s.key))
  const group = (g: StatusInfo['group']) => shown.filter((s) => s.group === g)

  return (
    <section className="rounded-xl border bg-card p-3 shadow-xs sm:px-4" aria-label="Orders by status">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm">
          <span className="font-semibold tabular-nums">{board ? formatNumber(board.total) : '…'}</span>{' '}
          <span className="text-muted-foreground">{board?.total === 1 ? 'order' : 'orders'}{chosen.size > 0 ? ' in the picked statuses' : ''}</span>
        </p>
        {board && <p className="text-[13px] text-muted-foreground tabular-nums">Value <span className="font-medium text-foreground">{formatMoney(board.value)}</span></p>}
      </div>
      <div className="mt-2.5 space-y-2">
        <Chip on={chosen.size === 0} onClick={() => onPick('')} label="All statuses" n={all.n} title={formatMoney(all.value)} />
        {(['approved', 'web'] as const).map((g) => group(g).length > 0 && (
          <div key={g} className="flex flex-wrap items-center gap-1.5">
            <span className="w-full text-[11px] font-medium tracking-wide whitespace-nowrap text-muted-foreground uppercase sm:w-32 sm:shrink-0">
              {g === 'approved' ? 'Approved orders' : 'Web orders'}
            </span>
            {group(g).map((s) => {
              const c = counts.get(s.key)
              const only = chosen.size === 1 && chosen.has(s.key)
              return (
                <Chip key={s.key} on={chosen.has(s.key)} dot={DOT[s.variant] ?? DOT.neutral} label={s.label} n={c?.n ?? 0}
                  title={`${s.hint ? `${s.hint}. ` : ''}${formatMoney(c?.value ?? 0)}`} onClick={() => onPick(only ? '' : s.key)} />
              )
            })}
          </div>
        ))}
      </div>
    </section>
  )
}

function Chip({ on, onClick, label, n, dot, title }: { on: boolean; onClick: () => void; label: string; n: number; dot?: string; title?: string }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={on} title={title}
      className={cn('press inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors',
        on ? 'border-foreground bg-foreground text-background' : 'bg-card hover:border-foreground/30')}>
      {dot && <span className={cn('size-2 rounded-full', dot)} />}
      <span>{label}</span>
      <span className={cn('tabular-nums', on ? 'text-background/70' : 'text-muted-foreground')}>{formatNumber(n)}</span>
    </button>
  )
}

/** Every order that matches, with its status now; a row opens the order. */
export function BoardList({ board, loading, error, onRetry, options, dateBy, page, pageSize, onPage, onPageSize, filtered }: {
  board: OrdersBoard | undefined
  loading: boolean
  error: unknown
  onRetry: () => void
  options: OrdersBoardOptions | undefined
  dateBy: DateBy
  page: number
  pageSize: number
  onPage: (page: number) => void
  onPageSize: (size: number) => void
  filtered: boolean
}) {
  const calls = options?.call_statuses
  const columns: Column<BoardOrder>[] = [
    { key: 'order', header: 'Order', primary: true, cell: (o) => <OrderCell o={o} dateBy={dateBy} /> },
    { key: 'customer', header: 'Customer', cell: (o) => <CustomerCell o={o} /> },
    { key: 'products', header: 'Products', hideOnMobile: true, cell: (o) => <ProductsCell o={o} /> },
    { key: 'status', header: 'Status', cell: (o) => <StatusCell o={o} calls={calls} /> },
    { key: 'courier', header: 'Courier', cell: (o) => <CourierCell o={o} /> },
    { key: 'amount', header: 'Amount', align: 'right', cell: (o) => <AmountCell o={o} /> },
    { key: 'taken', header: 'Taken by', hideOnMobile: true, className: 'max-w-32', cell: (o) => <span className="block truncate text-[13px]">{o.taken_by ?? '—'}</span> },
    { key: 'open', header: <span className="sr-only">Open</span>, align: 'right', cell: (o) => (
      <Button size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" asChild>
        <Link to={`/admin/orders/${o.id}`} onClick={(e) => e.stopPropagation()} aria-label={`Open ${o.order_number}`}><Eye className="size-3.5" /> Open</Link>
      </Button>
    ) },
  ]
  return (
    <div className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <DataTable columns={columns} rows={board?.items} rowKey={(o) => o.id} loading={loading} error={error} onRetry={onRetry}
        rowHref={(o) => `/admin/orders/${o.id}`} mobileRow={(o) => <MobileRow o={o} dateBy={dateBy} calls={calls} />}
        empty={<EmptyState title={filtered ? 'No orders match these filters' : 'No orders yet'}
          description={filtered ? 'Change or clear a filter to see more.' : 'Orders show up here as soon as they come in.'} />}
        footer={board && board.total > 0 ? (
          <Pagination page={page} pageSize={pageSize} total={board.total} onPage={onPage} pageSizes={PAGE_SIZES} onPageSize={onPageSize} />
        ) : undefined} />
    </div>
  )
}

function storeName(channel: string | null) {
  return channel === 'SHOPIFY' ? 'Shopify' : channel === 'WOOCOMMERCE' ? 'WooCommerce' : channel ? channel.toLowerCase() : null
}

function OrderCell({ o, dateBy }: { o: BoardOrder; dateBy: DateBy }) {
  const store = storeName(o.channel)
  return (
    <div className="min-w-0 space-y-0.5">
      <Link to={`/admin/orders/${o.id}`} onClick={(e) => e.stopPropagation()} className="font-medium underline-offset-2 hover:text-sky-600 hover:underline">
        {o.order_number}
      </Link>
      {store && o.store_number && o.store_number !== o.order_number && <p className="text-xs text-muted-foreground">{store} {o.store_number}</p>}
      <p className="text-xs text-muted-foreground tabular-nums">
        {o.date ? `${DATE_WORD[dateBy]} ${formatDateTime(o.date)}` : `Ordered ${formatDateTime(o.created_at)}`}
      </p>
    </div>
  )
}

function CustomerCell({ o }: { o: BoardOrder }) {
  return (
    <div className="min-w-0 max-w-44 space-y-0.5 text-[13px]">
      <p className="truncate font-medium">{o.customer_name}</p>
      <p className="text-muted-foreground tabular-nums">{o.customer_phone}</p>
      {o.district && <p className="truncate text-xs text-muted-foreground">{o.district}</p>}
    </div>
  )
}

function ProductsCell({ o }: { o: BoardOrder }) {
  return (
    <div className="max-w-56 text-[13px]">
      <p className="line-clamp-2" title={o.items ?? ''}>{o.items ?? '—'}</p>
      {o.item_count > 1 && <p className="text-xs text-muted-foreground">{formatNumber(o.item_count)} items</p>}
    </div>
  )
}

/** The status now, and what is under it: the finer order status, the parcel's status at the courier, or the calls made. */
function statusLines(o: BoardOrder, calls: OrdersBoardOptions['call_statuses'] | undefined) {
  const info = statusInfo(o.status_key, calls)
  const notes: string[] = []
  if (info.group === 'web') {
    if (o.status === 'ADVANCE_REQUIRED') notes.push('Advance due')
    if (o.contact_attempts > 0) notes.push(`${o.contact_attempts} call${o.contact_attempts === 1 ? '' : 's'}`)
    if (o.follow_up_at) notes.push(`call ${formatDateTime(o.follow_up_at)}`)
  } else {
    const detail = ORDER_STATUS[o.status]?.label
    if (detail && detail !== info.label) notes.push(detail)
    const parcel = o.courier?.status ? SHIPMENT_STATUS[o.courier.status]?.label : null
    if (parcel && parcel !== detail && parcel !== info.label && !['PENDING', 'BOOKED'].includes(o.courier?.status ?? '')) notes.push(`Courier: ${parcel}`)
  }
  return { info, notes }
}

function StatusCell({ o, calls }: { o: BoardOrder; calls: OrdersBoardOptions['call_statuses'] | undefined }) {
  const { info, notes } = statusLines(o, calls)
  return (
    <div className="max-w-44 space-y-0.5">
      <Badge variant={info.variant}>{info.group === 'web' ? `Web · ${info.label}` : info.label}</Badge>
      {notes.map((n) => <p key={n} className="text-xs text-muted-foreground">{n}</p>)}
    </div>
  )
}

function CourierPaid({ o }: { o: BoardOrder }) {
  if (o.courier_payment === 'paid') {
    return <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400" title={o.courier_paid.statement ? `Statement ${o.courier_paid.statement}` : undefined}>Paid {formatMoney(o.courier_paid.amount)}</p>
  }
  if (o.courier_payment === 'unpaid') return <p className="text-xs font-medium text-amber-600 dark:text-amber-400">Not paid yet</p>
  return null
}

function CourierCell({ o }: { o: BoardOrder }) {
  if (!o.courier) return <div className="space-y-0.5"><span className="text-xs text-muted-foreground">Not booked</span><CourierPaid o={o} /></div>
  return (
    <div className="max-w-40 space-y-0.5 text-[13px]">
      <p className="truncate font-medium">{o.courier.name}</p>
      {o.courier.number && (o.courier.tracking_url
        ? <a href={o.courier.tracking_url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}
            className="block truncate font-mono text-xs text-sky-600 hover:underline">{o.courier.number}</a>
        : <p className="truncate font-mono text-xs text-muted-foreground">{o.courier.number}</p>)}
      <CourierPaid o={o} />
    </div>
  )
}

function AmountCell({ o }: { o: BoardOrder }) {
  const due = Number(o.cod_amount)
  return (
    <div className="space-y-0.5 text-right">
      <p className="font-medium tabular-nums"><Money value={o.total_amount} /></p>
      {due > 0 && due !== Number(o.total_amount) && <p className="text-xs text-muted-foreground tabular-nums">COD {formatMoney(due)}</p>}
    </div>
  )
}

function MobileRow({ o, dateBy, calls }: { o: BoardOrder; dateBy: DateBy; calls: OrdersBoardOptions['call_statuses'] | undefined }) {
  const { info, notes } = statusLines(o, calls)
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-medium">{o.order_number}</p>
          <p className="text-xs text-muted-foreground tabular-nums">{o.date ? `${DATE_WORD[dateBy]} ${formatDateTime(o.date)}` : `Ordered ${formatDateTime(o.created_at)}`}</p>
        </div>
        <div className="shrink-0 text-right">
          <Badge variant={info.variant}>{info.group === 'web' ? `Web · ${info.label}` : info.label}</Badge>
          {notes[0] && <p className="mt-0.5 text-xs text-muted-foreground">{notes[0]}</p>}
        </div>
      </div>
      <p className="truncate text-[13px]"><span className="font-medium">{o.customer_name}</span> <span className="text-muted-foreground tabular-nums">· {o.customer_phone}</span></p>
      {o.items && <p className="line-clamp-1 text-[13px] text-muted-foreground">{o.items}</p>}
      <div className="flex items-end justify-between gap-3 text-[13px]">
        <div className="min-w-0">
          <p className="truncate text-muted-foreground">{o.courier ? `${o.courier.name}${o.courier.number ? ` · ${o.courier.number}` : ''}` : 'Not booked'}</p>
          <CourierPaid o={o} />
        </div>
        <p className="shrink-0 font-medium tabular-nums"><Money value={o.total_amount} /></p>
      </div>
    </div>
  )
}
