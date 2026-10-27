import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Clock, Layers } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { Money } from '@/components/common/money'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PaymentPanel } from '@/features/checkout/payment-panel'
import { OrderItemsSummary, OrderTracking } from '@/features/storefront/order-views'
import { WhatsAppConfirm } from '@/features/storefront/whatsapp-confirm'
import { useStoreConfig } from '@/hooks/use-store-config'
import { normalizePhone } from '@/lib/phone'
import { trackOrder } from '@/services/storefront'
import { lastOrderKey, readMergedLines } from '@/features/cart/last-order'

function storedPhone(orderNumber: string): string {
  try {
    const last = JSON.parse(sessionStorage.getItem(lastOrderKey()) ?? 'null') as { order_number: string; phone: string } | null
    return last?.order_number === orderNumber ? last.phone : ''
  } catch {
    return ''
  }
}

const PAYMENT_MESSAGES: Record<string, { tone: string; icon: React.ReactNode; text: string }> = {
  success: { tone: 'bg-emerald-50 text-emerald-900', icon: <CheckCircle2 className="size-5" />, text: 'Payment received. Thank you!' },
  failed: { tone: 'bg-red-50 text-red-900', icon: <AlertTriangle className="size-5" />, text: 'The payment did not go through. You can try again below.' },
  cancelled: { tone: 'bg-red-50 text-red-900', icon: <AlertTriangle className="size-5" />, text: 'Payment was cancelled. You can try again below.' },
  review: { tone: 'bg-amber-50 text-amber-900', icon: <Clock className="size-5" />, text: 'We are verifying your payment and will confirm shortly.' },
  pending: { tone: 'bg-amber-50 text-amber-900', icon: <Clock className="size-5" />, text: 'We are waiting for confirmation from the payment provider.' },
  unavailable: { tone: 'bg-amber-50 text-amber-900', icon: <AlertTriangle className="size-5" />, text: 'Your order is placed, but online payment could not open just now. Please try again or choose another way to pay below.' },
}

/**
 * A checkout that joined the same number's earlier order. The page shows what was just added and
 * never the earlier order itself: its number and details come to the customer by SMS (security
 * audit run 6: anyone could type someone else's number at checkout).
 */
function MergedThankYou() {
  const [lines] = useState(readMergedLines)
  return (
    <div className="mx-auto max-w-xl px-4 py-12">
      <div className="mb-8 text-center">
        <Layers className="mx-auto mb-3 size-10 text-sky-600" />
        <h1 className="text-2xl font-semibold text-balance">Added to your earlier order</h1>
        <p className="mt-2 text-muted-foreground text-pretty">
          This mobile number already has an order with us, so these items go in the same parcel, with <strong>one delivery charge</strong>.
          We'll confirm the updated order by SMS.
        </p>
      </div>
      {lines && lines.items.length > 0 && (
        <div className="rounded-xl border p-4">
          <p className="mb-2 text-sm font-medium">Just added</p>
          <ul className="divide-y text-sm">
            {lines.items.map((item, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="font-medium">{item.product_name}</span>
                  <span className="text-muted-foreground">{item.variant_title ? ` · ${item.variant_title}` : ''} · Qty {item.quantity}</span>
                </span>
                <Money value={item.line_subtotal} />
              </li>
            ))}
          </ul>
          <div className="mt-2 flex justify-between border-t pt-2 text-sm font-medium"><span>Items</span><Money value={lines.subtotal} /></div>
        </div>
      )}
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline"><Link to="/track-order">Track an order</Link></Button>
        <Button asChild><Link to="/shop">Continue shopping</Link></Button>
      </div>
    </div>
  )
}

export default function OrderSuccessPage() {
  const [params] = useSearchParams()
  const orderNumber = params.get('order') ?? ''
  const paymentResult = params.get('payment')
  const merged = params.get('merged') === '1'
  const { data: config } = useStoreConfig()
  const [phone, setPhone] = useState(() => storedPhone(orderNumber))
  const [phoneInput, setPhoneInput] = useState('')

  const order = useQuery({
    queryKey: ['public-order', orderNumber, phone],
    enabled: Boolean(orderNumber && phone),
    queryFn: () => trackOrder(orderNumber, phone),
    refetchInterval: (q) => (q.state.data?.status === 'ADVANCE_REQUIRED' ? 15_000 : false),
  })

  if (!orderNumber && merged) return <MergedThankYou />
  if (!orderNumber) {
    return <div className="mx-auto max-w-md px-4 py-20 text-center"><p>No order selected.</p><Button asChild className="mt-4"><Link to="/track-order">Track an order</Link></Button></div>
  }

  if (!phone) {
    return (
      <div className="mx-auto max-w-sm px-4 py-16">
        <h1 className="text-xl font-semibold">Order {orderNumber}</h1>
        <p className="mt-1 text-sm text-muted-foreground">Enter the mobile number used for this order to see its details.</p>
        <form className="mt-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); setPhone(normalizePhone(phoneInput)) }}>
          <Input value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} placeholder="01XXXXXXXXX" inputMode="tel" aria-label="Mobile number" />
          <Button type="submit">View</Button>
        </form>
      </div>
    )
  }

  if (order.isLoading) return <LoadingState />
  if (order.error) return <ErrorState error={order.error} onRetry={() => order.refetch()} />
  if (!order.data) {
    return <div className="mx-auto max-w-md px-4 py-20 text-center"><p>We couldn't find that order.</p><Button variant="outline" className="mt-4" onClick={() => setPhone('')}>Try another number</Button></div>
  }

  const o = order.data
  const banner = paymentResult ? PAYMENT_MESSAGES[paymentResult] : null
  const needsPayment = ['ADVANCE_REQUIRED', 'PENDING', 'FRAUD_CHECK', 'CONFIRMATION_REQUIRED'].includes(o.status) && Number(o.amount_due_now) > 0

  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <div className="mb-8 text-center">
        <CheckCircle2 className="mx-auto mb-3 size-10 text-emerald-600" />
        <h1 className="text-2xl font-semibold">{needsPayment ? 'Almost done!' : 'Thank you for your order!'}</h1>
        <p className="mt-1 text-muted-foreground">Order <strong>{o.order_number}</strong> · we'll keep you updated by SMS.</p>
        {!needsPayment && config?.store.whatsapp && (
          <div className="mx-auto mt-5 max-w-sm">
            <WhatsAppConfirm storeName={config.store.name} whatsapp={config.store.whatsapp} order={o} phone={phone} />
          </div>
        )}
      </div>
      {banner && <div className={`mb-6 flex items-center gap-3 rounded-lg p-4 text-sm ${banner.tone}`}>{banner.icon}{banner.text}</div>}
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          {needsPayment && <PaymentPanel order={o} phone={phone} onSubmitted={() => order.refetch()} />}
          {o.status === 'FRAUD_REVIEW' && (
            <div className="rounded-lg border bg-muted/40 p-4 text-sm">Our team will call you shortly to confirm this order.</div>
          )}
          <OrderTracking order={o} />
        </div>
        <OrderItemsSummary order={o} />
      </div>
      <div className="mt-8 flex flex-wrap justify-center gap-2">
        <Button asChild variant="outline"><Link to={`/track-order?order=${encodeURIComponent(o.order_number)}`}>Track order</Link></Button>
        <Button asChild><Link to="/shop">Continue shopping</Link></Button>
      </div>
    </div>
  )
}
