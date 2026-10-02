import { useMutation } from '@tanstack/react-query'
import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { useAuth } from '@/features/auth/auth-context'
import { toUserMessage } from '@/lib/errors'
import { supabase } from '@/lib/supabase'

// Reached from the password-reset / invite email; Supabase signs the user in
// from the link before this page renders.
export default function ResetPasswordPage() {
  const { session, loading } = useAuth()
  const isAdmin = useLocation().pathname.startsWith('/admin')
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const update = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      if (password.length < 8) throw new Error('VALIDATION: use at least 8 characters')
      if (password !== confirm) throw new Error('VALIDATION: passwords do not match')
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw error
    },
    onSuccess: () => {
      toast.success('Password updated')
      navigate(isAdmin ? '/admin' : '/account')
    },
  })
  return (
    <div className="mx-auto max-w-sm px-4 py-16">
      <Card>
        <CardHeader><CardTitle>Choose a new password</CardTitle><CardDescription>{session?.user.email}</CardDescription></CardHeader>
        <CardContent>
          {!loading && !session ? (
            <p className="text-sm text-muted-foreground">This link has expired or was already used. Request a new one.</p>
          ) : (
            <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); update.mutate() }}>
              <Field label="New password" htmlFor="password"><Input id="password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
              <Field label="Confirm password" htmlFor="confirm"><Input id="confirm" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
              {update.error && <p className="text-sm text-destructive">{toUserMessage(update.error)}</p>}
              <Button type="submit" disabled={update.isPending}>{update.isPending && <Spinner />} Save password</Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
