import { CheckCircle2, Circle, ExternalLink, Truck } from 'lucide-react'
import { Money } from '@/components/common/money'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatDateTime } from '@/lib/format'
import { CUSTOMER_STEPS, ORDER_STATUS } from '@/lib/status'
import { cn } from '@/lib/utils'
import { imageUrl } from '@/services/catalog'
import type { PublicOrder } from '@/types/domain'

const STOPPED = ['CANCELLED', 'REJECTED_FRAUD', 'RETURNED']

export function OrderProgress({ order }: { order: PublicOrder }) {
  if (STOPPED.includes(order.status)) {
    return <Badge variant="neutral" className="text-sm">{ORDER_STATUS[order.status].customer}</Badge>
  }
  const current = CUSTOMER_STEPS.findIndex((s) => s.statuses.includes(order.status))
  return (
    <ol className="grid grid-cols-4 gap-2">
      {CUSTOMER_STEPS.map((step, i) => (
        <li key={step.label} className="flex flex-col items-center gap-1.5 text-center">
          {i <= current ? <CheckCircle2 className="size-5 text-emerald-600" /> : <Circle className="size-5 text-muted-foreground/40" />}
          <span className={cn('text-xs', i <= current ? 'font-medium' : 'text-muted-foreground')}>{step.label}</span>
        </li>
      ))}
    </ol>
  )
}

export function OrderItemsSummary({ order }: { order: PublicOrder }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Order {order.order_number}</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <ul className="divide-y">
          {order.items.map((item, i) => (
            <li key={i} className="flex gap-3 py-3 first:pt-0">
              {item.image_url && <img src={imageUrl(item.image_url, 120)} alt="" className="size-14 rounded-md bg-muted object-cover" />}
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate font-medium">{item.product_name}</p>
                <p className="text-muted-foreground">{item.variant_title ? `${item.variant_title} · ` : ''}Qty {item.quantity}</p>
              </div>
              <Money value={item.line_total} className="text-sm" />
            </li>
          ))}
        </ul>
        <dl className="space-y-1.5 border-t pt-3 text-sm">
          <Row label="Subtotal" value={<Money value={order.subtotal} />} />
          {Number(order.discount_total) > 0 && <Row label="Discount" value={<Money value={-order.discount_total} />} />}
          <Row label="Delivery" value={Number(order.delivery_charge) > 0 ? <Money value={order.delivery_charge} /> : 'Free'} />
          <Row label="Total" value={<Money value={order.total_amount} />} strong />
          {Number(order.amount_paid) > 0 && <Row label="Paid" value={<Money value={-order.amount_paid} />} />}
          <Row label="Pay on delivery" value={<Money value={order.cod_amount} />} strong />
        </dl>
        <div className="border-t pt-3 text-sm text-muted-foreground">
          <p className="font-medium text-foreground">Delivery to</p>
          <p>{order.customer_name}</p>
          <p>{[order.shipping_address, order.shipping_area, order.shipping_district].filter(Boolean).join(', ')}</p>
        </div>
      </CardContent>
    </Card>
  )
}

function Row({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between gap-4', strong && 'font-medium')}>
      <dt className={strong ? '' : 'text-muted-foreground'}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}

export function OrderTracking({ order }: { order: PublicOrder }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Status: {ORDER_STATUS[order.status].customer}</CardTitle></CardHeader>
      <CardContent className="space-y-5">
        <OrderProgress order={order} />
        {order.shipment && (
          <div className="flex items-start gap-3 rounded-lg bg-muted/50 p-3 text-sm">
            <Truck className="mt-0.5 size-4" />
            <div>
              <p className="font-medium">{order.shipment.courier}</p>
              {order.shipment.tracking_number && <p className="text-muted-foreground">Tracking: {order.shipment.tracking_number}</p>}
              {order.shipment.tracking_url && (
                <a href={order.shipment.tracking_url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 underline">
                  Track with courier <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          </div>
        )}
        <ol className="space-y-3 border-l pl-4 text-sm">
          {order.timeline.slice().reverse().map((t, i) => (
            <li key={i} className="relative">
              <span className="absolute top-1.5 -left-[21px] size-2 rounded-full bg-foreground/60" />
              <p className="font-medium">{t.status ? ORDER_STATUS[t.status].customer : t.message}</p>
              {t.status && t.message && <p className="text-muted-foreground">{t.message}</p>}
              <p className="text-xs text-muted-foreground">{formatDateTime(t.created_at)}</p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  )
}
