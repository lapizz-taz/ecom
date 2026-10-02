import { useQuery } from '@tanstack/react-query'
import { LogOut, Package } from 'lucide-react'
import { Link, Navigate } from 'react-router'
import { Money } from '@/components/common/money'
import { EmptyState, ErrorState, LoadingState } from '@/components/common/states'
import { StatusBadge } from '@/components/common/status-badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/auth-context'
import { formatDate } from '@/lib/format'
import { ORDER_STATUS } from '@/lib/status'
import { myOrders } from '@/services/storefront'

const CUSTOMER_STATUS = Object.fromEntries(
  Object.entries(ORDER_STATUS).map(([k, v]) => [k, { label: v.customer, variant: v.variant }]),
) as Record<keyof typeof ORDER_STATUS, { label: string; variant: (typeof ORDER_STATUS)[keyof typeof ORDER_STATUS]['variant'] }>

export default function AccountPage() {
  const { user, loading, isStaff, signOut } = useAuth()
  const orders = useQuery({ queryKey: ['my-orders'], enabled: Boolean(user), queryFn: () => myOrders(50, 0) })
  if (loading) return <LoadingState />
  if (!user) return <Navigate to="/login?next=/account" replace />
  const meta = user.user_metadata as { full_name?: string; phone?: string }

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Hi{meta.full_name ? `, ${meta.full_name.split(' ')[0]}` : ''}</h1>
          <p className="text-sm text-muted-foreground">{user.email}{meta.phone ? ` · ${meta.phone}` : ''}</p>
        </div>
        <div className="flex gap-2">
          {isStaff && <Button asChild variant="outline"><Link to="/admin">Admin</Link></Button>}
          <Button variant="outline" onClick={() => signOut()}><LogOut /> Sign out</Button>
        </div>
      </div>
      <Card>
        <CardHeader><CardTitle className="text-base">Your orders</CardTitle></CardHeader>
        <CardContent className="p-0">
          {orders.isLoading ? <LoadingState /> : orders.error ? <ErrorState error={orders.error} onRetry={() => orders.refetch()} />
            : !orders.data?.items.length ? (
              <EmptyState icon={<Package className="size-5" />} title="No orders yet" description="Orders you place while signed in appear here."
                action={<Button asChild><Link to="/shop">Start shopping</Link></Button>} />
            ) : (
              <ul className="divide-y">
                {orders.data.items.map((o) => (
                  <li key={o.id}>
                    <Link to={`/account/orders/${o.id}`} className="flex items-center justify-between gap-3 px-5 py-4 hover:bg-muted/40">
                      <div>
                        <p className="font-medium">{o.order_number}</p>
                        <p className="text-sm text-muted-foreground">{formatDate(o.created_at)} · {o.item_count} items</p>
                      </div>
                      <div className="flex items-center gap-3">
                        <StatusBadge value={o.status} map={CUSTOMER_STATUS} />
                        <Money value={o.total_amount} className="font-medium" />
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
        </CardContent>
      </Card>
    </div>
  )
}
