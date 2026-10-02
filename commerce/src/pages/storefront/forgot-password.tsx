import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { Link, useLocation } from 'react-router'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { toUserMessage } from '@/lib/errors'
import { supabase } from '@/lib/supabase'

export default function ForgotPasswordPage() {
  const isAdmin = useLocation().pathname.startsWith('/admin')
  const [email, setEmail] = useState('')
  const send = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const redirectTo = `${window.location.origin}${isAdmin ? '/admin' : ''}/reset-password`
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo })
      if (error) throw error
    },
  })
  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <Card>
        <CardHeader><CardTitle>Reset your password</CardTitle><CardDescription>We'll email you a link to choose a new password.</CardDescription></CardHeader>
        <CardContent>
          {send.isSuccess ? (
            <p className="text-sm">If an account exists for <strong>{email}</strong>, a reset link is on its way.</p>
          ) : (
            <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); send.mutate() }}>
              <Field label="Email" htmlFor="email"><Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
              {send.error && <p className="text-sm text-destructive">{toUserMessage(send.error)}</p>}
              <Button type="submit" disabled={send.isPending}>{send.isPending && <Spinner />} Send reset link</Button>
            </form>
          )}
          <Link to={isAdmin ? '/admin/login' : '/login'} className="mt-4 block text-center text-sm text-muted-foreground hover:text-foreground">Back to sign in</Link>
        </CardContent>
      </Card>
    </div>
  )
}
