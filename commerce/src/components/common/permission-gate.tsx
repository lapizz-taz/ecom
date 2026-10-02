import type { ReactNode } from 'react'
import { useAuth } from '@/features/auth/auth-context'

/** UI convenience only — the database enforces every permission. */
export function Can({ permission, children, fallback = null }: { permission: string; children: ReactNode; fallback?: ReactNode }) {
  const { can } = useAuth()
  return <>{can(permission) ? children : fallback}</>
}
