import { useClerk, useSignIn, useSignUp, useUser } from '@clerk/clerk-react'
import { useMutation } from '@tanstack/react-query'
import { useRef, useState } from 'react'
import { Link } from 'react-router'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/features/auth/auth-context'
import { clerkErrorCode, clerkErrorMessage, toE164 } from '@/features/auth/clerk'
import { authRedirect } from '@/lib/auth-links'
import { legacyPasswordSignIn, legacyResetEmail, moveAccountToClerk, prepareClerkReset } from '@/services/clerk-auth'

// Sign-in screens backed by Clerk, in the same layout as before. Nothing here
// shows Clerk's own widgets: the forms call Clerk directly.

type SetActive = NonNullable<ReturnType<typeof useSignIn>['setActive']>
type SignInResource = NonNullable<ReturnType<typeof useSignIn>['signIn']>
type Factor = NonNullable<SignInResource['supportedSecondFactors']>[number]

/** A 6-digit code box. */
export function CodeField({ value, onChange, label = 'Code' }: { value: string; onChange: (v: string) => void; label?: string }) {
  return (
    <Field label={label} htmlFor="code">
      <Input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} className="h-11 text-center font-mono text-lg tracking-[0.5em]"
        value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="••••••" autoFocus />
    </Field>
  )
}

/** Finishes a Clerk sign-in: makes it the active session and opens the account here. */
async function finish(res: SignInResource, setActive: SetActive, syncClerk: () => Promise<void>) {
  await setActive({ session: res.createdSessionId })
  await syncClerk()
}

/** The second step Clerk asks for (a code by e-mail or SMS), if any. */
async function startSecondStep(res: SignInResource): Promise<'email_code' | 'phone_code'> {
  const factors = res.supportedSecondFactors ?? []
  const email = factors.find((f: Factor) => f.strategy === 'email_code')
  const phone = factors.find((f: Factor) => f.strategy === 'phone_code')
  if (email) { await res.prepareSecondFactor({ strategy: 'email_code', emailAddressId: (email as { emailAddressId?: string }).emailAddressId }); return 'email_code' }
  if (phone) { await res.prepareSecondFactor({ strategy: 'phone_code', phoneNumberId: (phone as { phoneNumberId?: string }).phoneNumberId }); return 'phone_code' }
  throw new Error('This account needs a sign-in step this page does not support. Contact support.')
}

export function ClerkSignInForm({ onDone, forgotPath }: { onDone: () => void; forgotPath: string }) {
  const { isLoaded, signIn, setActive } = useSignIn()
  const { syncClerk } = useAuth()
  const [mode, setMode] = useState<'password' | 'email-code'>('password')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [code, setCode] = useState('')
  const [step, setStep] = useState<null | { kind: 'second'; strategy: 'email_code' | 'phone_code' } | { kind: 'first-code' }>(null)

  const submit = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      if (!isLoaded || !signIn || !setActive) throw new Error('Sign-in is still loading. Try again in a moment.')
      // Second screen: the code.
      if (step) {
        const res = step.kind === 'second'
          ? await signIn.attemptSecondFactor({ strategy: step.strategy, code })
          : await signIn.attemptFirstFactor({ strategy: 'email_code', code })
        if (res.status === 'complete') return finish(res, setActive, syncClerk).then(() => true)
        if (res.status === 'needs_second_factor') { setCode(''); setStep({ kind: 'second', strategy: await startSecondStep(res) }); return false }
        throw new Error('Could not finish signing in. Try again.')
      }
      if (mode === 'email-code') {
        const res = await signIn.create({ identifier: email.trim() })
        const factor = res.supportedFirstFactors?.find((f) => f.strategy === 'email_code') as { emailAddressId: string } | undefined
        if (!factor) throw new Error('Codes by e-mail are not available for this account. Use your password.')
        await res.prepareFirstFactor({ strategy: 'email_code', emailAddressId: factor.emailAddressId })
        setStep({ kind: 'first-code' })
        return false
      }
      let res: SignInResource
      try {
        res = await signIn.create({ identifier: email.trim(), password })
      } catch (error) {
        // Accounts from before Clerk: check the password against the old account and move it over.
        if (clerkErrorCode(error) !== 'form_identifier_not_found') throw error
        const moved = await moveAccountToClerk(email, password)
        if (moved.status === 'unconfirmed') throw new Error('This e-mail was never confirmed. Create your account again with it to finish.')
        if (moved.status === 'exists') throw error
        if (moved.status === 'legacy') { await legacyPasswordSignIn(email, password); return true }
        res = await signIn.create({ identifier: email.trim(), password })
      }
      if (res.status === 'complete') return finish(res, setActive, syncClerk).then(() => true)
      if (res.status === 'needs_second_factor') { setStep({ kind: 'second', strategy: await startSecondStep(res) }); return false }
      throw new Error('Could not finish signing in. Try again.')
    },
    onSuccess: (done) => { if (done) onDone() },
  })

  const error = submit.error ? clerkErrorMessage(submit.error) : null

  if (step) {
    const where = step.kind === 'second' && step.strategy === 'phone_code' ? 'your phone' : email.trim()
    return (
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); if (code.length === 6) submit.mutate() }}>
        <p className="text-sm text-muted-foreground">We sent a 6-digit code to <span className="font-medium text-foreground">{where}</span>.</p>
        <CodeField value={code} onChange={setCode} />
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        <Button type="submit" size="lg" disabled={submit.isPending || code.length !== 6}>{submit.isPending && <Spinner />} Continue</Button>
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => { setStep(null); setCode(''); submit.reset() }}>Use a different e-mail</button>
      </form>
    )
  }

  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); submit.mutate() }}>
      <Field label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="email" className="h-10" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
      {mode === 'password' && (
        <div className="grid gap-1.5">
          <div className="flex items-center justify-between gap-2">
            <Label htmlFor="password">Password</Label>
            <Link to={forgotPath} className="text-xs text-muted-foreground hover:text-foreground">Forgot password?</Link>
          </div>
          <Input id="password" type="password" autoComplete="current-password" className="h-10" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
      )}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      <Button type="submit" size="lg" disabled={submit.isPending || !isLoaded}>{(submit.isPending || !isLoaded) && <Spinner />} {mode === 'password' ? 'Sign in' : 'Email me a code'}</Button>
      <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => { setMode(mode === 'password' ? 'email-code' : 'password'); submit.reset() }}>
        {mode === 'password' ? 'Sign in with a code by e-mail instead' : 'Sign in with your password instead'}
      </button>
    </form>
  )
}

/** Forgot password: a code by e-mail, then a new password. */
export function ClerkResetForm({ onDone, size }: { onDone: () => void; size: 'lg' | 'default' }) {
  const { isLoaded, signIn, setActive } = useSignIn()
  const { syncClerk } = useAuth()
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [sent, setSent] = useState(false)
  const [linkSent, setLinkSent] = useState(false)

  const send = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      if (!isLoaded || !signIn) throw new Error('Still loading. Try again in a moment.')
      await prepareClerkReset(email).catch(() => {})
      try {
        await signIn.create({ strategy: 'reset_password_email_code', identifier: email.trim() })
        setSent(true)
      } catch (error) {
        // Not in Clerk (yet): send the built-in reset link instead.
        if (clerkErrorCode(error) !== 'form_identifier_not_found') throw error
        await legacyResetEmail(email, authRedirect('/admin/reset-password'))
        setLinkSent(true)
      }
    },
  })
  const save = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      if (!signIn || !setActive) throw new Error('Still loading. Try again in a moment.')
      const res = await signIn.attemptFirstFactor({ strategy: 'reset_password_email_code', code, password })
      if (res.status !== 'complete') throw new Error('Your password was changed. Sign in with it now.')
      await finish(res, setActive, syncClerk)
    },
    onSuccess: onDone,
  })

  if (linkSent) return <p className="text-sm">If an account exists for <strong>{email.trim()}</strong>, a reset link is on its way.</p>
  if (!sent) {
    return (
      <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); send.mutate() }}>
        <Field label="Email" htmlFor="email"><Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        {send.error && <p className="text-sm text-destructive">{clerkErrorMessage(send.error)}</p>}
        <Button type="submit" size={size} disabled={send.isPending || !isLoaded}>{send.isPending && <Spinner />} Send code</Button>
      </form>
    )
  }
  return (
    <form className="grid gap-4" onSubmit={(e) => { e.preventDefault(); save.mutate() }}>
      <p className="text-sm text-muted-foreground">We sent a 6-digit code to <span className="font-medium text-foreground">{email.trim()}</span>.</p>
      <CodeField value={code} onChange={setCode} />
      <Field label="New password" htmlFor="new-password"><Input id="new-password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
      {save.error && <p className="text-sm text-destructive" role="alert">{clerkErrorMessage(save.error)}</p>}
      <Button type="submit" size={size} disabled={save.isPending || code.length !== 6 || !password}>{save.isPending && <Spinner />} Save password and sign in</Button>
      <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={() => send.mutate()} disabled={send.isPending}>Send a new code</button>
    </form>
  )
}

export interface OwnerSignUp {
  ready: boolean
  /** Shortest password Clerk accepts. */
  minPassword: number
  /** Creates the account and e-mails the first code. */
  start: (input: { email: string; password: string; fullName: string; phone: string }) => Promise<void>
  /** Checks a code: done, or Clerk also wants the phone confirmed by SMS. */
  verify: (code: string) => Promise<'done' | 'phone_code'>
  resend: () => Promise<void>
}

/** Sign-up for a new business owner: e-mail + password, then a 6-digit code by e-mail. */
export function useClerkOwnerSignUp(): OwnerSignUp {
  const { isLoaded, signUp, setActive } = useSignUp()
  const clerk = useClerk()
  const { syncClerk } = useAuth()
  const stage = useRef<'email' | 'phone'>('email')
  const settings = (clerk as unknown as { __unstable__environment?: { userSettings?: { passwordSettings?: { min_length?: number } } } }).__unstable__environment
  return {
    ready: isLoaded,
    minPassword: Math.max(8, settings?.userSettings?.passwordSettings?.min_length ?? 8),
    async start({ email, password, fullName, phone }) {
      if (!signUp) throw new Error('Sign-up is still loading. Try again in a moment.')
      const [firstName, ...rest] = fullName.trim().split(/\s+/)
      let res = await signUp.create({ emailAddress: email.trim(), password, firstName: firstName || undefined, lastName: rest.join(' ') || undefined })
      // Some Clerk setups also ask for a mobile number: use the one from the business details.
      if (res.missingFields.includes('phone_number')) {
        const e164 = toE164(phone)
        if (!e164) throw new Error('Enter your mobile number as 01XXXXXXXXX in the business details')
        res = await res.update({ phoneNumber: e164 })
      }
      await res.prepareEmailAddressVerification({ strategy: 'email_code' })
      stage.current = 'email'
    },
    async verify(code) {
      if (!signUp || !setActive) throw new Error('Sign-up is still loading. Try again in a moment.')
      const res = stage.current === 'email'
        ? await signUp.attemptEmailAddressVerification({ code })
        : await signUp.attemptPhoneNumberVerification({ code })
      if (res.status === 'complete') {
        await setActive({ session: res.createdSessionId })
        await syncClerk()
        return 'done'
      }
      if (res.unverifiedFields.includes('phone_number')) {
        await res.preparePhoneNumberVerification({ strategy: 'phone_code' })
        stage.current = 'phone'
        return 'phone_code'
      }
      throw new Error(`Could not finish: ${res.missingFields.join(', ') || 'unknown step'} is missing`)
    },
    async resend() {
      if (!signUp) return
      if (stage.current === 'email') await signUp.prepareEmailAddressVerification({ strategy: 'email_code' })
      else await signUp.preparePhoneNumberVerification({ strategy: 'phone_code' })
    },
  }
}

/** Password change for a Clerk account; null when this session did not come from Clerk. */
export function useClerkPasswordChange(): ((current: string, next: string) => Promise<void>) | null {
  const { user } = useUser()
  if (!user) return null
  return async (current, next) => {
    try {
      await user.updatePassword({ currentPassword: current, newPassword: next, signOutOfOtherSessions: true })
    } catch (error) {
      throw new Error(clerkErrorCode(error) === 'form_password_incorrect' ? 'Your current password is incorrect' : clerkErrorMessage(error))
    }
  }
}
