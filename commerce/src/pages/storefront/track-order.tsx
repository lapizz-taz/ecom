import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { OrderItemsSummary, OrderTracking } from '@/features/storefront/order-views'
import { toUserMessage } from '@/lib/errors'
import { normalizePhone } from '@/lib/phone'
import { trackOrder } from '@/services/storefront'

export default function TrackOrderPage() {
  const [params] = useSearchParams()
  const [orderNumber, setOrderNumber] = useState(params.get('order') ?? '')
  const [phone, setPhone] = useState('')
  const lookup = useMutation({ meta: { silent: true }, mutationFn: () => trackOrder(orderNumber.trim().toUpperCase(), normalizePhone(phone)) })
  const order = lookup.data

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="text-2xl font-semibold">Track your order</h1>
      <p className="mt-1 text-sm text-muted-foreground">Enter your order number and the mobile number used at checkout.</p>
      <Card className="mt-6 max-w-xl">
        <CardContent>
          <form className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={(e) => { e.preventDefault(); lookup.mutate() }}>
            <Field label="Order number" htmlFor="order"><Input id="order" value={orderNumber} onChange={(e) => setOrderNumber(e.target.value)} placeholder="ISO-10001" required /></Field>
            <Field label="Mobile number" htmlFor="phone"><Input id="phone" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="01XXXXXXXXX" required /></Field>
            <Button type="submit" disabled={lookup.isPending}>{lookup.isPending && <Spinner />} Track</Button>
          </form>
          {lookup.error && <p className="mt-3 text-sm text-destructive">{toUserMessage(lookup.error)}</p>}
          {lookup.isSuccess && !order && <p className="mt-3 text-sm text-destructive">No order matches that number and phone.</p>}
        </CardContent>
      </Card>
      {order && (
        <div className="mt-8 grid gap-6 lg:grid-cols-[1fr_380px]">
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
      )}
    </div>
  )
}
