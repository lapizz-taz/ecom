import type { Session, User } from '@supabase/supabase-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
import { registerDevice } from '@/lib/device'
import { setStaffMerchant } from '@/lib/merchant'
import { setMonitoringUser } from '@/lib/monitoring'
import { getMyAccess } from '@/services/users'
import { supabase } from '@/lib/supabase'
import type { MyAccess } from '@/types/domain'

interface AuthState {
  session: Session | null
  user: User | null
  /** Staff access (role + permissions) or null for customers/visitors. */
  access: MyAccess | null
  loading: boolean
  accessLoading: boolean
  isStaff: boolean
  can: (permission: string) => boolean
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  const queryClient = useQueryClient()

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      setSession(next)
      if (event === 'SIGNED_OUT') queryClient.clear()
    })
    return () => data.subscription.unsubscribe()
  }, [queryClient])

  const userId = session?.user.id
  const accessQuery = useQuery({
    queryKey: ['my-access', userId],
    enabled: Boolean(userId),
    staleTime: 5 * 60_000,
    queryFn: async () => {
      // Link this sign-in to this browser first, so device approval (when on) can recognise it.
      await registerDevice()
      return getMyAccess()
    },
  })

  const staffAccess = userId ? (accessQuery.data ?? null) : null
  // Uploads go into the staff member's merchant folder.
  setStaffMerchant(staffAccess?.merchant_id ?? null)
  useEffect(() => {
    setMonitoringUser(userId && staffAccess ? { id: userId, role: staffAccess.role } : null)
  }, [userId, staffAccess])

  const value = useMemo<AuthState>(() => {
    const access = userId ? (accessQuery.data ?? null) : null
    return {
      session,
      user: session?.user ?? null,
      access,
      loading,
      accessLoading: Boolean(userId) && accessQuery.isLoading,
      isStaff: Boolean(access),
      // Mirrors the database: a read-only account keeps *.view and *.export, a blocked one nothing.
      can: (permission) => Boolean(access && !access.device_blocked && access.access_mode !== 'BLOCKED'
        && (access.access_mode !== 'READ_ONLY' || /\.(view|export)$/.test(permission))
        && (access.role === 'OWNER' || access.permissions.includes(permission))),
      signOut: async () => {
        await supabase.auth.signOut()
      },
    }
  }, [session, loading, userId, accessQuery.data, accessQuery.isLoading])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
