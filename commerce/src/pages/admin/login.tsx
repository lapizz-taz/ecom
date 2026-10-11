import { ArrowRight } from 'lucide-react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { Button } from '@/components/ui/button'
import { AuthShell } from '@/features/auth/auth-shell'
import { useAuth } from '@/features/auth/auth-context'
import { useAdminTheme } from '@/hooks/use-admin-theme'
import { SignInForm } from '@/pages/storefront/login'

export default function AdminLoginPage() {
  useAdminTheme()
  const { session, access, accessLoading, clerkError, signOut } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next') ?? '/admin'
  if (session && access) return <Navigate to={next} replace />
  return (
    <AuthShell>
      <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.025em]">Welcome back</h1>
      <p className="mt-2 text-sm text-muted-foreground">Sign in to manage your orders, stock and couriers.</p>
      {clerkError && (
        <div className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm" role="alert">
          <p className="text-destructive">{clerkError.message}</p>
          <button type="button" className="mt-1 text-xs font-medium underline underline-offset-4" onClick={() => void signOut()}>Sign out and try another account</button>
        </div>
      )}
      {session && !access && !accessLoading ? (
        <div className="mt-8 rounded-2xl border bg-muted/40 p-4 text-sm">
          <p>Signed in as <span className="font-medium">{session.user.email}</span>. This account has no business yet.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button asChild size="sm"><Link to="/start">Open my business</Link></Button>
            <Button size="sm" variant="outline" onClick={() => void signOut()}>Sign out</Button>
          </div>
        </div>
      ) : (
        <div className="mt-8">
          <SignInForm onDone={() => navigate(next)} forgotPath="/admin/forgot-password" />
        </div>
      )}
      <div className="mt-8 rounded-2xl border bg-muted/40 p-4 text-sm">
        <p className="font-medium">New to Fullfilio?</p>
        <p className="mt-0.5 text-muted-foreground">Open your business in two minutes and start with a free trial.</p>
        <Link to="/start" className="mt-2 inline-flex items-center gap-1 font-medium text-brand hover:underline">Create your business <ArrowRight className="size-3.5" /></Link>
      </div>
    </AuthShell>
  )
}
