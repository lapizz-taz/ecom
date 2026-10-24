import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, MailCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { clearAuthLinkError, readAuthLinkError, resendSignupEmail, type AuthLinkError } from '@/lib/auth-links'
import { toUserMessage } from '@/lib/errors'

/** The link error in the address when the page opened (read once, then cleared). */
export function useAuthLinkError(): AuthLinkError | null {
  const [error] = useState(() => (typeof window === 'undefined' ? null : readAuthLinkError()))
  useEffect(() => { if (error) clearAuthLinkError() }, [error])
  return error
}

export function LinkErrorNotice({ error, action }: { error: AuthLinkError; action?: React.ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10" role="alert">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1"><p>{error.message}</p>{action}</div>
    </div>
  )
}

/** Sends the confirmation e-mail again, with a short wait between sends. */
export function ResendConfirmation({ email: initial = '', returnPath, compact }: { email?: string; returnPath: string; compact?: boolean }) {
  const [email, setEmail] = useState(initial)
  const [wait, setWait] = useState(0)
  useEffect(() => {
    if (!wait) return
    const t = setTimeout(() => setWait((w) => Math.max(0, w - 1)), 1000)
    return () => clearTimeout(t)
  }, [wait])
  const send = useMutation({
    meta: { silent: true },
    mutationFn: () => resendSignupEmail(email, returnPath),
    onSuccess: () => setWait(60),
  })
  return (
    <form className="grid gap-2" onSubmit={(e) => { e.preventDefault(); if (/^\S+@\S+\.\S+$/.test(email.trim()) && !wait) send.mutate() }}>
      {!compact && <Input type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="E-mail" />}
      <Button type="submit" variant="outline" disabled={send.isPending || wait > 0 || !/^\S+@\S+\.\S+$/.test(email.trim())}>
        {send.isPending ? <Spinner /> : <MailCheck />} {wait > 0 ? `Sent — send again in ${wait}s` : 'Send the confirmation e-mail again'}
      </Button>
      {send.error && <p className="text-sm text-destructive">{toUserMessage(send.error)}</p>}
    </form>
  )
}

export function NewResetLink({ admin }: { admin: boolean }) {
  return <Link to={admin ? '/admin/forgot-password' : '/forgot-password'} className="font-medium underline underline-offset-4">Request a new reset link</Link>
}
