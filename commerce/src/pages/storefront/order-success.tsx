import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, CheckCircle2, Clock, Layers } from 'lucide-react'
import { useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { ErrorState, LoadingState } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PaymentPanel } from '@/features/checkout/payment-panel'
import { OrderItemsSummary, OrderTracking } from '@/features/storefront/order-views'
import { normalizePhone } from '@/lib/phone'
import { trackOrder } from '@/services/storefront'

function storedPhone(orderNumber: string): string {
  try {
    const last = JSON.parse(sessionStorage.getItem('last_order') ?? 'null') as { order_number: string; phone: string } | null
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
}

export default function OrderSuccessPage() {
  const [params] = useSearchParams()
  const orderNumber = params.get('order') ?? ''
  const paymentResult = params.get('payment')
  const merged = params.get('merged') === '1'
  const [phone, setPhone] = useState(() => storedPhone(orderNumber))
  const [phoneInput, setPhoneInput] = useState('')

  const order = useQuery({
    queryKey: ['public-order', orderNumber, phone],
    enabled: Boolean(orderNumber && phone),
    queryFn: () => trackOrder(orderNumber, phone),
    refetchInterval: (q) => (q.state.data?.status === 'ADVANCE_REQUIRED' ? 15_000 : false),
  })

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
      </div>
      {merged && (
        <div className="mb-6 flex items-center gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
          <Layers className="size-5 shrink-0" />
          <span>You ordered again a moment ago, so we added these items to the same order — <strong>one parcel, one delivery charge</strong>.</span>
        </div>
      )}
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
      <div className="mt-8 text-center"><Button asChild variant="outline"><Link to="/shop">Continue shopping</Link></Button></div>
    </div>
  )
}
