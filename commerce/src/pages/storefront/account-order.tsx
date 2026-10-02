import { useQuery } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import { Link, Navigate, useParams } from 'react-router'
import { ErrorState, LoadingState } from '@/components/common/states'
import { useAuth } from '@/features/auth/auth-context'
import { OrderItemsSummary, OrderTracking } from '@/features/storefront/order-views'
import { myOrder } from '@/services/storefront'

export default function AccountOrderPage() {
  const { id = '' } = useParams()
  const { user, loading } = useAuth()
  const order = useQuery({ queryKey: ['my-order', id], enabled: Boolean(user), queryFn: () => myOrder(id) })
  if (loading) return <LoadingState />
  if (!user) return <Navigate to="/login" replace />
  if (order.isLoading) return <LoadingState />
  if (order.error) return <ErrorState error={order.error} onRetry={() => order.refetch()} />
  if (!order.data) return <div className="mx-auto max-w-md px-4 py-20 text-center">Order not found.</div>
  const o = order.data
  return (
    <div className="mx-auto max-w-5xl px-4 py-10">
      <Link to="/account" className="mb-4 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" /> All orders</Link>
      <h1 className="mb-6 text-2xl font-semibold">Order {o.order_number}</h1>
      {o.status === 'ADVANCE_REQUIRED' && Number(o.amount_due_now) > 0 && (
        <div className="mb-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          Payment needed to confirm this order. <Link to={`/track-order?order=${o.order_number}`} className="font-medium underline">Pay now</Link>
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <OrderTracking order={o} />
        <OrderItemsSummary order={o} />
      </div>
    </div>
  )
}
