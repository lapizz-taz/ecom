import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, Navigate, useLocation } from 'react-router'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/auth-context'
import { AuthFrame } from '@/features/auth/auth-shell'
import { toUserMessage } from '@/lib/errors'
import { authRedirect } from '@/lib/auth-links'
import { supabase } from '@/lib/supabase'

export default function ForgotPasswordPage() {
  const isAdmin = useLocation().pathname.startsWith('/admin')
  const { usesClerk } = useAuth()
  // Clerk's sign-in box has its own "Forgot password?" (a code by e-mail).
  if (usesClerk) return <Navigate to="/admin/login" replace />
  return <LinkResetForm isAdmin={isAdmin} />
}

function LinkResetForm({ isAdmin }: { isAdmin: boolean }) {
  const [email, setEmail] = useState('')
  const send = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const redirectTo = authRedirect(`${isAdmin ? '/admin' : ''}/reset-password`)
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo })
      if (error) throw error
    },
  })
  return (
    <AuthFrame admin={isAdmin} title="Reset your password" description="We'll email you a link to choose a new password.">
          {send.isSuccess ? (
            <p className="text-sm">If an account exists for <strong>{email}</strong>, a reset link is on its way.</p>
          ) : (
            <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); send.mutate() }}>
              <Field label="Email" htmlFor="email"><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
              {send.error && <p className="text-sm text-destructive">{toUserMessage(send.error)}</p>}
              <Button type="submit" size={isAdmin ? 'lg' : 'default'} disabled={send.isPending}>{send.isPending && <Spinner />} Send reset link</Button>
            </form>
          )}
          <Link to={isAdmin ? '/admin/login' : '/login'} className="mt-4 block text-center text-sm text-muted-foreground hover:text-foreground">Back to sign in</Link>
    </AuthFrame>
  )
}
