import { useSignUp } from '@clerk/clerk-react'
import { ArrowRight } from 'lucide-react'
import { type FormEvent, type ReactNode, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Field } from '@/components/common/field'
import { Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { clerkErrorCode, clerkErrorMessage } from '@/features/auth/clerk'

// The account step of /start, on Clerk's sign-up API instead of Clerk's own box.
// Clerk's box can stop on "Fill in missing fields" without a word when the
// instance asks for a field that box does not draw; here every field Clerk
// still needs is asked for by name, and every error is shown.

type Stage = 'details' | 'email_code' | 'more' | 'phone_code'
type Missing = 'first_name' | 'last_name' | 'username' | 'phone_number' | 'legal_accepted' | 'password'
const ASKED: Missing[] = ['first_name', 'last_name', 'username', 'phone_number', 'password', 'legal_accepted']
const LABEL: Record<string, string> = {
  first_name: 'first name', last_name: 'last name', username: 'username', phone_number: 'mobile number',
  legal_accepted: 'terms', password: 'password', email_address: 'e-mail address', saml: 'company sign-in', enterprise_sso: 'company sign-in',
}

/** 01XXXXXXXXX → +8801XXXXXXXXX (Clerk takes numbers with the country code). */
const e164 = (phone: string) => (/^01\d{9}$/.test(phone) ? `+880${phone.slice(1)}` : phone)

export function ClerkSignUpForm({ fullName, phone, minPassword = 8, onDone }: {
  /** From the business step, for Clerk's name fields when the instance asks for them. */
  fullName: string
  phone: string
  minPassword?: number
  /** The account is created and signed in. */
  onDone: () => void
}) {
  const { isLoaded, signUp, setActive } = useSignUp()
  const [stage, setStage] = useState<Stage>('details')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [agree, setAgree] = useState(false)
  const [code, setCode] = useState('')
  const [more, setMore] = useState(() => {
    const [first = '', ...rest] = fullName.trim().split(/\s+/)
    return { first_name: first, last_name: rest.join(' '), username: '', phone_number: e164(phone), password: '', legal_accepted: false }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; exists?: boolean } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  const missing = (signUp?.missingFields ?? []) as string[]
  const askable = ASKED.filter((f) => missing.includes(f))
  const unaskable = missing.filter((f) => !ASKED.includes(f as Missing) && f !== 'email_address')

  // A sign-up already started in this browser (another tab, or Google) carries on where it stopped.
  useEffect(() => {
    if (!isLoaded || !signUp?.id || signUp.status !== 'missing_requirements') return
    if (signUp.emailAddress) setEmail(signUp.emailAddress)
    setStage(signUp.unverifiedFields.includes('email_address') ? 'email_code' : 'more')
    // Once, for the sign-up that was there when the page opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoaded])

  async function next() {
    if (!signUp) return
    if (signUp.status === 'complete') {
      await setActive?.({ session: signUp.createdSessionId })
      onDone()
      return
    }
    if (signUp.unverifiedFields.includes('email_address')) {
      await signUp.prepareEmailAddressVerification({ strategy: 'email_code' })
      setCode('')
      setStage('email_code')
      return
    }
    if (signUp.unverifiedFields.includes('phone_number') && !signUp.missingFields.includes('phone_number')) {
      await signUp.preparePhoneNumberVerification({ strategy: 'phone_code' })
      setCode('')
      setStage('phone_code')
      return
    }
    setStage('more')
  }

  async function run(e: FormEvent, step: () => Promise<unknown>) {
    e.preventDefault()
    setError(null)
    setNotice(null)
    setBusy(true)
    try {
      await step()
      await next()
    } catch (err) {
      setError({ text: clerkErrorMessage(err), exists: clerkErrorCode(err) === 'form_identifier_exists' })
    } finally {
      setBusy(false)
    }
  }

  if (!isLoaded || !signUp) return <div className="flex justify-center py-6"><Spinner className="size-5" /></div>

  const detailsError = !/^\S+@\S+\.\S+$/.test(email.trim()) ? 'Enter your e-mail address'
    : password.length < minPassword ? `Use at least ${minPassword} characters for the password`
      : !agree ? 'Accept the terms to continue' : null

  return (
    <div className="grid gap-4">
      {/* Clerk's bot check draws itself here when the instance has it on. */}
      <div id="clerk-captcha" />

      {stage === 'details' && (
        <form noValidate className="grid gap-4" onSubmit={(e) => {
          setTouched(true)
          if (detailsError) { e.preventDefault(); return }
          void run(e, () => signUp.create({ emailAddress: email.trim(), password }))
        }}>
          <Field label="Work e-mail" required>
            <Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-10" placeholder="you@yourshop.com" />
          </Field>
          <Field label="Password" required hint={`At least ${minPassword} characters`}>
            <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10" />
          </Field>
          <label className="flex items-start gap-2.5 text-[13px] text-muted-foreground">
            <Checkbox checked={agree} onCheckedChange={(v) => setAgree(v === true)} className="mt-0.5" />
            <span>I agree to the terms of service and privacy policy, and confirm I run this business.</span>
          </label>
          {touched && detailsError && !error && <p className="text-sm text-destructive" role="alert">{detailsError}</p>}
          <Submit busy={busy}>Create account</Submit>
        </form>
      )}

      {(stage === 'email_code' || stage === 'phone_code') && (
        <form noValidate className="grid gap-4" onSubmit={(e) => void run(e, () => (stage === 'email_code'
          ? signUp.attemptEmailAddressVerification({ code: code.trim() })
          : signUp.attemptPhoneNumberVerification({ code: code.trim() })))}>
          <p className="text-sm text-muted-foreground">
            We sent a 6-digit code to <span className="font-medium text-foreground">{stage === 'email_code' ? (signUp.emailAddress ?? email) : signUp.phoneNumber}</span>. Enter it here.
          </p>
          <Field label="Code" required>
            <Input inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              className="h-11 text-center text-lg tracking-[0.5em] tabular-nums" autoFocus />
          </Field>
          <Submit busy={busy} disabled={code.length < 6}>Verify</Submit>
          <button type="button" disabled={busy} className="justify-self-start text-[13px] font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
            onClick={() => {
              setError(null)
              setNotice(null)
              const send = stage === 'email_code' ? signUp.prepareEmailAddressVerification({ strategy: 'email_code' }) : signUp.preparePhoneNumberVerification({ strategy: 'phone_code' })
              send.then(() => setNotice('A new code is on its way.')).catch((err) => setError({ text: clerkErrorMessage(err) }))
            }}>
            Send a new code
          </button>
        </form>
      )}

      {stage === 'more' && (
        <form noValidate className="grid gap-4" onSubmit={(e) => void run(e, () => signUp.update({
          ...(askable.includes('first_name') ? { firstName: more.first_name.trim() } : {}),
          ...(askable.includes('last_name') ? { lastName: more.last_name.trim() } : {}),
          ...(askable.includes('username') ? { username: more.username.trim() } : {}),
          ...(askable.includes('phone_number') ? { phoneNumber: more.phone_number.trim() } : {}),
          ...(askable.includes('password') ? { password: more.password } : {}),
          ...(askable.includes('legal_accepted') ? { legalAccepted: more.legal_accepted } : {}),
        }))}>
          <p className="text-sm text-muted-foreground">One more step to finish your account{askable.length ? `: ${askable.map((f) => LABEL[f]).join(', ')}` : ''}.</p>
          {askable.includes('first_name') && <Field label="First name" required><Input value={more.first_name} onChange={(e) => setMore({ ...more, first_name: e.target.value })} className="h-10" /></Field>}
          {askable.includes('last_name') && <Field label="Last name" required><Input value={more.last_name} onChange={(e) => setMore({ ...more, last_name: e.target.value })} className="h-10" /></Field>}
          {askable.includes('username') && <Field label="Username" required><Input autoComplete="username" value={more.username} onChange={(e) => setMore({ ...more, username: e.target.value })} className="h-10" /></Field>}
          {askable.includes('phone_number') && (
            <Field label="Mobile number" required hint="With the country code, e.g. +8801712345678">
              <Input type="tel" value={more.phone_number} onChange={(e) => setMore({ ...more, phone_number: e.target.value })} className="h-10" />
            </Field>
          )}
          {askable.includes('password') && (
            <Field label="Password" required hint={`At least ${minPassword} characters`}>
              <Input type="password" autoComplete="new-password" value={more.password} onChange={(e) => setMore({ ...more, password: e.target.value })} className="h-10" />
            </Field>
          )}
          {askable.includes('legal_accepted') && (
            <label className="flex items-start gap-2.5 text-[13px] text-muted-foreground">
              <Checkbox checked={more.legal_accepted} onCheckedChange={(v) => setMore({ ...more, legal_accepted: v === true })} className="mt-0.5" />
              <span>I agree to the terms of service and privacy policy.</span>
            </label>
          )}
          {unaskable.length > 0 && (
            <p className="rounded-xl border bg-muted/40 px-3 py-2 text-[13px] text-muted-foreground">
              The sign-in service also asks for: {unaskable.map((f) => LABEL[f] ?? f.replace(/_/g, ' ')).join(', ')}. This page cannot collect that; please contact us and we will open your account.
            </p>
          )}
          <Submit busy={busy} disabled={askable.length === 0}>Continue</Submit>
        </form>
      )}

      {notice && !error && <p className="text-sm text-muted-foreground" role="status">{notice}</p>}
      {error && (
        <p className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive" role="alert">
          {error.exists
            ? <>This e-mail already has a Fullfilio account. <Link to="/admin/login?next=/start/finish" className="font-medium underline">Sign in</Link> and your business opens there.</>
            : error.text}
        </p>
      )}
    </div>
  )
}

function Submit({ busy, disabled, children }: { busy: boolean; disabled?: boolean; children: ReactNode }) {
  return (
    <Button type="submit" size="lg" variant="brand" disabled={busy || disabled} className="justify-self-end">
      {busy && <Spinner />}{children}{!busy && <ArrowRight />}
    </Button>
  )
}
