import { useMutation } from '@tanstack/react-query'
import { PackageSearch } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { OrderItemsSummary, OrderTracking } from '@/features/storefront/order-views'
import { ORDER_STATUS } from '@/lib/status'
import { toUserMessage } from '@/lib/errors'
import { formatDateTime } from '@/lib/format'
import { normalizePhone } from '@/lib/phone'
import { trackOrder } from '@/services/storefront'

// Track an order with its number and the phone used at checkout: a centred form like the checkout's
// boxes, then the order's status, timeline and items.

const box = 'h-12 rounded-[6px] bg-background px-3.5 text-[calc(15px*var(--fs-body,1))] shadow-none'

export default function TrackOrderPage() {
  const [params] = useSearchParams()
  const [orderNumber, setOrderNumber] = useState(params.get('order') ?? '')
  const [phone, setPhone] = useState('')
  const lookup = useMutation({ meta: { silent: true }, mutationFn: () => trackOrder(orderNumber.trim().toUpperCase(), normalizePhone(phone)) })
  const order = lookup.data

  return (
    <div className="px-4 py-12 sm:py-16">
      <div className="mx-auto max-w-md">
        <div className="text-center">
          <span className="mx-auto grid size-12 place-items-center rounded-full bg-foreground/[0.06]"><PackageSearch className="size-5" strokeWidth={1.75} /></span>
          <h1 className="mt-4 text-2xl font-semibold tracking-tight sm:text-3xl">Track your order</h1>
          <p className="mt-2 text-sm text-muted-foreground">Enter your order number and the mobile number you used at checkout.</p>
        </div>

        <form className="mt-8 grid gap-4" onSubmit={(e) => { e.preventDefault(); lookup.mutate() }}>
          <div className="grid gap-1.5">
            <Label htmlFor="order" className="text-[13px] font-medium">Order number</Label>
            <Input id="order" className={box} value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="e.g. ISO-10001" autoComplete="off" required />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="phone" className="text-[13px] font-medium">Mobile number</Label>
            <Input id="phone" className={box} value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" autoComplete="tel" placeholder="01XXXXXXXXX" required />
          </div>
          <Button type="submit" size="lg" className="mt-1 h-12 rounded-[6px] text-[calc(15px*var(--fs-body,1))] font-semibold" disabled={lookup.isPending}>
            {lookup.isPending && <Spinner />} Track order
          </Button>
          {lookup.error && <p role="alert" className="text-center text-sm text-destructive">{toUserMessage(lookup.error)}</p>}
          {lookup.isSuccess && !order && <p role="alert" className="text-center text-sm text-destructive">No order matches that number and mobile number.</p>}
        </form>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          The order number is in your confirmation SMS. Need help? <Link to="/contact" className="font-medium text-foreground underline underline-offset-2">Contact us</Link>
        </p>
      </div>

      {order && (
        <div className="mx-auto mt-12 max-w-5xl">
          <div className="mb-5 flex flex-wrap items-end justify-between gap-2 border-b pb-4">
            <div>
              <p className="text-xs text-muted-foreground">Order</p>
              <p className="text-xl font-semibold tracking-tight">{order.order_number}</p>
            </div>
            <div className="text-right">
              <span className="inline-flex rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background">{ORDER_STATUS[order.status].customer}</span>
              <p className="mt-1 text-xs text-muted-foreground">Placed {formatDateTime(order.created_at)}</p>
            </div>
          </div>
          <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
            <div className="space-y-4">
              {Number(order.amount_due_now) > 0 && order.status === 'ADVANCE_REQUIRED' && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
                  A payment is needed to confirm this order.{' '}
                  <Link className="font-medium underline" to={`/order-success?order=${order.order_number}`}
                    onClick={() => sessionStorage.setItem('last_order', JSON.stringify({ order_number: order.order_number, phone: normalizePhone(phone) }))}>
                    Pay now
                  </Link>
                </div>
              )}
              <OrderTracking order={order} />
            </div>
            <OrderItemsSummary order={order} />
          </div>
        </div>
      )}
    </div>
  )
}
