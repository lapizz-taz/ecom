import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useAuth } from '@/features/auth/auth-context'
import { useStoreConfig } from '@/hooks/use-store-config'
import { SignInForm } from '@/pages/storefront/login'

export default function AdminLoginPage() {
  const { session, access } = useAuth()
  const { data: config } = useStoreConfig()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = params.get('next') ?? '/admin'
  if (session && access) return <Navigate to={next} replace />
  return (
    <div className="flex min-h-dvh items-center justify-center bg-muted/40 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{config?.store.name ?? 'Store'} admin</CardTitle>
          <CardDescription>Sign in with your staff account.</CardDescription>
        </CardHeader>
        <CardContent>
          <SignInForm onDone={() => navigate(next)} forgotPath="/admin/forgot-password" />
        </CardContent>
      </Card>
    </div>
  )
}
