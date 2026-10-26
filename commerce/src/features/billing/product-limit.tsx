import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router'
import { Card } from '@/components/ui/card'
import { formatNumber } from '@/lib/format'
import { myPlan, type MyPlan } from '@/services/billing'

export interface ProductLimitState {
  used: number
  limit: number
  plan: string | null
  /** More products than the plan includes (products synced from a store keep coming in). */
  over: boolean
}

/**
 * Where the store stands against its plan's product limit, once it is reached. Products added by hand
 * stop at the limit; products synced from Shopify or WooCommerce are not stopped, so a store can be over.
 */
export function productLimitState(p: Pick<MyPlan, 'limits' | 'usage' | 'subscription'>): ProductLimitState | null {
  const limit = p.limits.products
  if (limit == null) return null
  const used = Number(p.usage.products ?? 0)
  if (used < limit) return null
  return { used, limit, plan: p.subscription?.plan.name ?? null, over: used > limit }
}

export function productLimitText(s: ProductLimitState): string {
  const plan = s.plan ? `your ${s.plan} plan` : 'your plan'
  return s.over
    ? `This store has ${formatNumber(s.used)} products; ${plan} includes ${formatNumber(s.limit)}. Products from your Shopify or WooCommerce store keep syncing, but you can't add more here until you upgrade.`
    : `You've reached the ${formatNumber(s.limit)} products ${plan} includes. Products from your Shopify or WooCommerce store keep syncing, but you can't add more here until you upgrade.`
}

/** A notice on the Products page when the store is at or over its plan's product limit. */
export function ProductLimitNotice() {
  // Same query as Plan & Billing; any active staff member may read it. Hidden if it cannot load.
  const plan = useQuery({ queryKey: ['my-plan'], queryFn: myPlan, staleTime: 60_000 })
  const state = plan.data ? productLimitState(plan.data) : null
  if (!state) return null
  return (
    <Card className={state.over ? 'border-red-500/50 px-4 py-3 text-sm' : 'border-amber-500/50 px-4 py-3 text-sm'}>
      <p>{productLimitText(state)} <Link to="/admin/settings/billing" className="font-medium underline">See plans</Link></p>
    </Card>
  )
}
