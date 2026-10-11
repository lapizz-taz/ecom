import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/features/auth/auth-context'
import { myPlan } from '@/services/billing'

/**
 * What this business's plan and the platform switches allow right now
 * (Super Admin → Features & Access). The database enforces every feature on
 * its own; this only lets screens hide or label what is switched off.
 */
export function useMerchantFeatures() {
  const { access } = useAuth()
  const q = useQuery({ queryKey: ['my-plan'], queryFn: myPlan, enabled: Boolean(access), staleTime: 60_000 })
  const features = q.data?.features
  return {
    loading: q.isLoading,
    /** True only when the feature is known to be on (unknown counts as off, so nothing flashes on). */
    isOn: (code: string) => Boolean(features?.[code]?.enabled),
    /** True when the feature is known to be off. */
    isOff: (code: string) => Boolean(features && !features[code]?.enabled),
    state: (code: string) => features?.[code]?.state,
  }
}
