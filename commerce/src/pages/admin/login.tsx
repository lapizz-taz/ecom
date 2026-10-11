import { ArrowRight } from 'lucide-react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { AuthShell } from '@/features/auth/auth-shell'
import { useAuth } from '@/features/auth/auth-context'
import { useAdminTheme } from '@/hooks/use-admin-theme'
import { SignInForm } from '@/pages/storefront/login'

export default function AdminLoginPage() {
  useAdminTheme()
  const { session, access } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next') ?? '/admin'
  if (session && access) return <Navigate to={next} replace />
  return (
    <AuthShell>
      <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.025em]">Welcome back</h1>
      <p className="mt-2 text-sm text-muted-foreground">Sign in to manage your orders, stock and couriers.</p>
      <div className="mt-8">
        <SignInForm onDone={() => navigate(next)} forgotPath="/admin/forgot-password" />
      </div>
      <div className="mt-8 rounded-2xl border bg-muted/40 p-4 text-sm">
        <p className="font-medium">New to Fullfilio?</p>
        <p className="mt-0.5 text-muted-foreground">Open your business in two minutes and start with a free trial.</p>
        <Link to="/start" className="mt-2 inline-flex items-center gap-1 font-medium text-brand hover:underline">Create your business <ArrowRight className="size-3.5" /></Link>
      </div>
    </AuthShell>
  )
}
