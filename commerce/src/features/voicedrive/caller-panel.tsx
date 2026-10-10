import { useQuery } from '@tanstack/react-query'
import { ExternalLink, PackageCheck, ShieldCheck, Truck, UserRound } from 'lucide-react'
import { Link } from 'react-router'
import { formatMoney, formatShortDate } from '@/lib/format'
import { ORDER_STATUS, type OrderStatus } from '@/lib/status'
import { cn } from '@/lib/utils'
import { pbx } from '@/services/voicedrive'

const statusLabel = (s: string) => ORDER_STATUS[s as OrderStatus]?.label ?? s.replace(/_/g, ' ').toLowerCase()

/**
 * Screen-pop for a caller: who they are, their latest order with delivery
 * status, and earlier orders. The courier record is for staff only.
 */
export function CallerPanel({ phone, dark = false, compact = false }: { phone: string; dark?: boolean; compact?: boolean }) {
  const q = useQuery({
    queryKey: ['vd-caller', phone],
    queryFn: async () => {
      const [ctx, order, rating] = await Promise.all([
        pbx.resolveInboundCallerContext(phone),
        pbx.getInboundCallerOrderDetail(phone),
        pbx.resolveInboundCallerCourierRating(phone).catch(() => null),
      ])
      return { ctx, order, rating }
    },
    enabled: phone.replace(/\D/g, '').length >= 6,
    staleTime: 30_000,
  })
  const muted = dark ? 'text-zinc-400' : 'text-muted-foreground'
  const box = dark ? 'border-zinc-800 bg-zinc-900/60' : 'border-border bg-muted/30'
  if (q.isLoading) return <div className={cn('rounded-lg border p-3 text-xs', box, muted)}>Looking up the caller… · কলার খোঁজা হচ্ছে…</div>
  if (q.error) return <div className={cn('rounded-lg border p-3 text-xs', box, muted)}>Could not load the caller's orders: {(q.error as Error).message}</div>
  if (!q.data) return null
  const { ctx, order, rating } = q.data

  if (!ctx.known) {
    return (
      <div className={cn('rounded-lg border p-3 text-sm', box)}>
        <p className="flex items-center gap-1.5 font-medium"><UserRound className="size-4" /> New caller · নতুন কলার</p>
        <p className={cn('mt-1 text-xs', muted)}>No orders from {ctx.phone}. Take the order with New Order.</p>
        <Link to={`/admin/orders/new?phone=${encodeURIComponent(ctx.phone)}`} className="mt-2 inline-block text-xs font-medium underline underline-offset-2">New order for this number</Link>
      </div>
    )
  }

  return (
    <div className={cn('space-y-2 text-sm', compact && 'text-xs')}>
      <div className={cn('rounded-lg border p-3', box)}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold">{ctx.name ?? 'Customer'}</p>
            <p className={cn('text-xs', muted)}>{ctx.phone}{ctx.customer?.district ? ` · ${ctx.customer.district}` : ''}</p>
          </div>
          {ctx.customer && (
            <div className={cn('shrink-0 text-right text-xs', muted)}>
              <p>{ctx.customer.totalOrders} orders · {ctx.customer.deliveredOrders} delivered</p>
              {(ctx.customer.cancelledOrders > 0 || ctx.customer.returnedOrders > 0) && (
                <p>{ctx.customer.cancelledOrders} cancelled · {ctx.customer.returnedOrders} returned</p>
              )}
            </div>
          )}
        </div>
        {rating?.checked && rating.successRate !== null && rating.successRate !== undefined && (
          <p className={cn('mt-2 flex items-center gap-1 text-xs', muted)} title="Courier history for staff — never tell the customer">
            <ShieldCheck className="size-3.5" /> Courier success {Math.round(Number(rating.successRate))}% · {rating.totalParcels ?? 0} parcels <span className="opacity-70">(staff only)</span>
          </p>
        )}
      </div>

      {order && (
        <div className={cn('rounded-lg border p-3', box)}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium uppercase tracking-wide opacity-80">Latest order · সর্বশেষ অর্ডার</p>
            <Link to={`/admin/orders/${order.id}`} className="inline-flex items-center gap-1 text-xs underline underline-offset-2">{order.orderNumber} <ExternalLink className="size-3" /></Link>
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="inline-flex items-center gap-1 font-semibold"><PackageCheck className="size-4" /> {statusLabel(order.status)}</span>
            <span className={cn('text-xs', muted)}>{formatMoney(order.totalAmount)} · {order.paymentMethod} · {order.paymentStatus.toLowerCase()} · {formatShortDate(order.createdAt)}</span>
          </p>
          <ul className={cn('mt-1.5 space-y-0.5 text-xs', muted)}>
            {order.items.slice(0, 4).map((i, n) => (
              <li key={n} className="truncate">{i.quantity} × {i.name}{i.variant && i.variant !== 'Default Title' ? ` (${i.variant})` : ''}</li>
            ))}
            {order.items.length > 4 && <li>+{order.items.length - 4} more</li>}
          </ul>
          {order.shipment && (
            <p className="mt-1.5 flex flex-wrap items-center gap-1 text-xs">
              <Truck className="size-3.5" /> {order.shipment.courier} · {order.shipment.status.replace(/_/g, ' ').toLowerCase()}
              {order.shipment.trackingNumber && (order.shipment.trackingUrl
                ? <a href={order.shipment.trackingUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{order.shipment.trackingNumber}</a>
                : <span>{order.shipment.trackingNumber}</span>)}
            </p>
          )}
          {order.customerNote && <p className={cn('mt-1 text-xs italic', muted)}>“{order.customerNote}”</p>}
        </div>
      )}

      {ctx.orders.length > 1 && !compact && (
        <div className={cn('rounded-lg border p-3', box)}>
          <p className="mb-1 text-xs font-medium uppercase tracking-wide opacity-80">Earlier orders · আগের অর্ডার</p>
          <ul className="space-y-1 text-xs">
            {ctx.orders.slice(1, 6).map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-2">
                <Link to={`/admin/orders/${o.id}`} className="underline underline-offset-2">{o.orderNumber}</Link>
                <span className={muted}>{statusLabel(o.status)} · {formatMoney(o.totalAmount)} · {formatShortDate(o.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
