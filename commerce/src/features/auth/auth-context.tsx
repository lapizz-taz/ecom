import type { Session, User } from '@supabase/supabase-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'
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
      const { data, error } = await supabase.rpc('get_my_access')
      if (error) throw error
      return (data as unknown as MyAccess | null) ?? null
    },
  })

  const value = useMemo<AuthState>(() => {
    const access = userId ? (accessQuery.data ?? null) : null
    return {
      session,
      user: session?.user ?? null,
      access,
      loading,
      accessLoading: Boolean(userId) && accessQuery.isLoading,
      isStaff: Boolean(access),
      can: (permission) => Boolean(access && (access.role === 'OWNER' || access.permissions.includes(permission))),
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
