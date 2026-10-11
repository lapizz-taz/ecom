import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/features/auth/auth-context'
import { toUserMessage } from '@/lib/errors'
import { supabase } from '@/lib/supabase'

export function SignInForm({ onDone, forgotPath }: { onDone: () => void; forgotPath: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const signIn = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password })
      if (error) throw error
    },
    onSuccess: onDone,
  })
  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); signIn.mutate() }}>
      <Field label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="email" className="h-10" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
      <div className="grid gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="password">Password</Label>
          <Link to={forgotPath} className="text-xs text-muted-foreground hover:text-foreground">Forgot password?</Link>
        </div>
        <Input id="password" type="password" autoComplete="current-password" className="h-10" value={password} onChange={(e) => setPassword(e.target.value)} required />
      </div>
      {signIn.error && <p className="text-sm text-destructive" role="alert">{/invalid login/i.test(signIn.error.message) ? 'Email or password is incorrect' : toUserMessage(signIn.error)}</p>}
      <Button type="submit" size="lg" disabled={signIn.isPending}>{signIn.isPending && <Spinner />} Sign in</Button>
    </form>
  )
}

export default function LoginPage() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  if (user) return <Navigate to={params.get('next') ?? '/account'} replace />
  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Track orders and check out faster.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <SignInForm onDone={() => navigate(params.get('next') ?? '/account')} forgotPath="/forgot-password" />
          <p className="text-center text-sm">New here? <Link to="/register" className="underline">Create an account</Link></p>
        </CardContent>
      </Card>
    </div>
  )
}
