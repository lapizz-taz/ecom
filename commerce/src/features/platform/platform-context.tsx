import { useQuery } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useMemo } from 'react'
import { useAuth } from '@/features/auth/auth-context'
import { type PlatformMe, platformMe } from '@/services/platform'

interface PlatformState {
  me: PlatformMe | null
  loading: boolean
  error: unknown
  /** Hides what the employee cannot use; the database still checks every call. */
  can: (module: string, action?: string, merchantId?: string | null) => boolean
  refresh: () => void
}

const PlatformContext = createContext<PlatformState | null>(null)

export function PlatformProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const query = useQuery({
    queryKey: ['platform-me', user?.id],
    enabled: Boolean(user),
    staleTime: 60_000,
    refetchInterval: 120_000,
    queryFn: platformMe,
  })
  const value = useMemo<PlatformState>(() => {
    const me = user ? (query.data ?? null) : null
    return {
      me,
      loading: Boolean(user) && query.isLoading,
      error: query.error,
      can: (module, action = 'view', merchantId) => {
        if (!me || me.session_expired) return false
        if (!me.role.is_super && !me.permissions.includes(`${module}.${action}`)) return false
        if (merchantId && me.merchant_ids && !me.merchant_ids.includes(merchantId)) return false
        return true
      },
      refresh: () => void query.refetch(),
    }
  }, [user, query])
  return <PlatformContext.Provider value={value}>{children}</PlatformContext.Provider>
}

export function usePlatform(): PlatformState {
  const ctx = useContext(PlatformContext)
  if (!ctx) throw new Error('usePlatform must be used inside PlatformProvider')
  return ctx
}
