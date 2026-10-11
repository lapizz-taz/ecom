import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, MailCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { Field } from '@/components/common/field'
import { ErrorState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { CodeField, type OwnerSignUp, useClerkOwnerSignUp } from '@/features/auth/clerk-forms'
import { clerkErrorMessage } from '@/features/auth/clerk'
import { ResendConfirmation } from '@/features/auth/link-problem'
import { AuthShell } from '@/features/auth/auth-shell'
import { useAuth } from '@/features/auth/auth-context'
import { BusinessFields, businessErrors, PlanPicker, Steps } from '@/features/onboarding/signup-parts'
import { useAdminTheme } from '@/hooks/use-admin-theme'
import { toUserMessage } from '@/lib/errors'
import { normalizePhone } from '@/lib/phone'
import {
  clearSignupDraft, readSignupDraft, signInOnceConfirmed, saveSignupDraft, selfOnboard, signUpOwner, signupOptions, type SignupBusiness,
} from '@/services/onboarding'

const noClerk = (): OwnerSignUp | null => null

const EMPTY: SignupBusiness = {
  business_name: '', full_name: '', phone: '', business_type: '', website: '', sells_on: [], orders_per_month: '', plan_code: '',
}

/**
 * Public sign-up: choose a plan, describe the business, create the owner
 * account. The business opens as soon as the e-mail is confirmed (at once
 * when the project does not ask for confirmation).
 */
export default function StartPage() {
  useAdminTheme()
  const { session, access, loading, accessLoading, usesClerk } = useAuth()
  // With Clerk the account is confirmed with a 6-digit code (the hook choice is fixed for the page's life).
  const [useOwnerSignUp] = useState(() => (usesClerk ? useClerkOwnerSignUp : noClerk))
  const clerkFlow = useOwnerSignUp()
  const minPassword = clerkFlow?.minPassword ?? 8
  const [codeStep, setCodeStep] = useState<null | 'email_code' | 'phone_code'>(null)
  const [code, setCode] = useState('')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const options = useQuery({ queryKey: ['signup-options'], queryFn: signupOptions, staleTime: 5 * 60_000 })
  const [step, setStep] = useState(0)
  const [business, setBusiness] = useState<SignupBusiness>(() => ({ ...EMPTY, ...readSignupDraft() }))
  const [touched, setTouched] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [agree, setAgree] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  // Start on the default plan once the plans are known.
  useEffect(() => {
    const o = options.data
    if (!o || business.plan_code) return
    // A plan picked on the product site comes in as ?plan=CODE.
    const wanted = new URLSearchParams(window.location.search).get('plan')
    const code = o.plans.find((p) => p.code === wanted)?.code ?? o.plans.find((p) => p.code === o.default_plan)?.code ?? o.plans[0]?.code ?? ''
    setBusiness((b) => ({ ...b, plan_code: code }))
  }, [options.data, business.plan_code])

  const payload = () => ({ ...business, phone: normalizePhone(business.phone), business_name: business.business_name.trim(), full_name: business.full_name.trim(), website: business.website.trim() })
  const open = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      if (session) return { opened: await selfOnboard(payload()) }
      saveSignupDraft(payload())
      if (clerkFlow) {
        await clerkFlow.start({ email, password, fullName: business.full_name, phone: business.phone })
        setCode('')
        setCodeStep('email_code')
        return { code: true }
      }
      const res = await signUpOwner(email, password, payload())
      if (res.session) return { opened: await selfOnboard(payload()) }
      return { confirm: email.trim() }
    },
    onSuccess: async (r) => {
      if ('code' in r) return
      if ('confirm' in r && r.confirm) { setSentTo(r.confirm); return }
      clearSignupDraft()
      await queryClient.invalidateQueries({ queryKey: ['my-access'] })
      navigate('/admin?welcome=1', { replace: true })
    },
  })

  // Clerk: the code from the e-mail (or SMS) finishes the account, then the business opens.
  const verify = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const next = await clerkFlow!.verify(code)
      if (next === 'phone_code') { setCode(''); setCodeStep('phone_code'); return false }
      await selfOnboard(payload())
      return true
    },
    onSuccess: async (done) => {
      if (!done) return
      clearSignupDraft()
      await queryClient.invalidateQueries({ queryKey: ['my-access'] })
      navigate('/admin?welcome=1', { replace: true })
    },
  })
  const resend = useMutation({ meta: { silent: true }, mutationFn: () => clerkFlow!.resend() })

  // While waiting for the confirmation, check now and then (and whenever this
  // tab comes back into view) whether the link was opened somewhere else.
  useEffect(() => {
    if (!sentTo || session) return
    let stopped = false
    let tries = 0
    const check = async () => {
      if (stopped || document.visibilityState !== 'visible' || ++tries > 80) return
      try {
        if (await signInOnceConfirmed(sentTo, password)) { stopped = true; navigate('/start/finish', { replace: true }) }
      } catch { /* rate limit or network: try again on the next tick */ }
    }
    const timer = window.setInterval(check, 15_000)
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    return () => { stopped = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', check); window.removeEventListener('focus', check) }
  }, [sentTo, session, password, navigate])

  if (codeStep && !verify.isSuccess) {
    return (
      <AuthShell>
        <span className="flex size-12 items-center justify-center rounded-2xl border bg-card shadow-xs"><MailCheck className="size-6 text-brand" /></span>
        <h1 className="mt-5 text-[26px] leading-tight font-semibold tracking-[-0.025em]">{codeStep === 'email_code' ? 'Check your inbox' : 'Check your phone'}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We sent a 6-digit code to <span className="font-medium text-foreground">{codeStep === 'email_code' ? email.trim() : business.phone}</span>. Enter it here and {business.business_name.trim() || 'your business'} opens with everything you entered.
        </p>
        <form className="mt-6 grid gap-4" onSubmit={(e) => { e.preventDefault(); if (code.length === 6) verify.mutate() }}>
          <CodeField value={code} onChange={setCode} label={codeStep === 'email_code' ? 'Code from the e-mail' : 'Code from the SMS'} />
          {verify.error && <p className="text-sm text-destructive" role="alert">{clerkErrorMessage(verify.error)}</p>}
          <Button type="submit" size="lg" variant="brand" disabled={verify.isPending || code.length !== 6}>{verify.isPending && <Spinner />} Confirm and open my business</Button>
        </form>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-[13px] text-muted-foreground">
          <button type="button" className="hover:text-foreground disabled:opacity-50" disabled={resend.isPending || resend.isSuccess} onClick={() => resend.mutate()}>
            {resend.isSuccess ? 'New code sent' : 'Send a new code'}
          </button>
          <button type="button" className="hover:text-foreground" onClick={() => { setCodeStep(null); setStep(2); open.reset(); verify.reset() }}>Use a different e-mail</button>
        </div>
        {resend.error && <p className="mt-2 text-sm text-destructive">{clerkErrorMessage(resend.error)}</p>}
      </AuthShell>
    )
  }

  if (loading || (session && accessLoading)) return <AuthShell><div className="flex justify-center"><Spinner className="size-5" /></div></AuthShell>
  if (session && access) return <Navigate to={open.isSuccess ? '/admin?welcome=1' : '/admin'} replace />

  const errors = businessErrors(business)
  const stepsLabels = ['Plan', 'Business', session ? 'Confirm' : 'Account']
  const accountError = !session && (!/^\S+@\S+\.\S+$/.test(email.trim()) ? 'Enter your e-mail address' : password.length < minPassword ? `Use at least ${minPassword} characters for the password` : !agree ? 'Accept the terms to continue' : null)

  if (sentTo) {
    return (
      <AuthShell>
        <span className="flex size-12 items-center justify-center rounded-2xl border bg-card shadow-xs"><MailCheck className="size-6 text-brand" /></span>
        <h1 className="mt-5 text-[26px] leading-tight font-semibold tracking-[-0.025em]">Check your inbox</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We sent a confirmation link to <span className="font-medium text-foreground">{sentTo}</span>. Click it once, on any device, then come back to this tab: {business.business_name.trim() || 'your business'} opens here by itself, with everything you entered.
        </p>
        <div className="mt-6"><ResendConfirmation email={sentTo} returnPath="/start/finish" compact /></div>
        <div className="mt-4 rounded-2xl border bg-muted/40 p-4 text-[13px] text-muted-foreground">
          No e-mail after a few minutes? Check spam, or <button type="button" className="font-medium text-foreground underline-offset-4 hover:underline" onClick={() => { setSentTo(null); setStep(2) }}>use a different address</button>.
        </div>
        <p className="mt-6 text-sm text-muted-foreground">Already confirmed? <Link to="/start/finish" className="font-medium text-brand hover:underline">Continue</Link></p>
      </AuthShell>
    )
  }

  return (
    <AuthShell wide footer={<>Already have an account? <Link to="/admin/login" className="font-medium text-foreground hover:underline">Sign in</Link></>}>
      {options.error ? <ErrorState error={options.error} onRetry={() => options.refetch()} /> : !options.data ? (
        <div className="flex justify-center"><Spinner className="size-5" /></div>
      ) : !options.data.enabled ? (
        <div>
          <h1 className="text-[26px] font-semibold tracking-[-0.025em]">Sign-ups are paused</h1>
          <p className="mt-2 text-sm text-muted-foreground">New businesses cannot open an account on their own right now. Contact us and we will set yours up.</p>
          <Button asChild variant="outline" className="mt-6"><Link to="/admin/login">Sign in instead</Link></Button>
        </div>
      ) : (
        <form noValidate onSubmit={(e) => {
          e.preventDefault()
          if (step === 0) { if (business.plan_code) setStep(1); return }
          if (step === 1) {
            setTouched(true)
            if (Object.keys(errors).length) return
            setStep(2); return
          }
          setTouched(true)
          if (!accountError && !Object.keys(errors).length) open.mutate()
        }}>
          <Steps steps={stepsLabels} current={step} />
          <h1 className="mt-8 text-[28px] leading-tight font-semibold tracking-[-0.025em]">
            {step === 0 ? 'Start your business on Fullfilio' : step === 1 ? 'Tell us about your business' : session ? 'Open your business' : 'Create your account'}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {step === 0 ? 'Pick a plan. Every paid plan starts with a free trial, and you can change plans later.'
              : step === 1 ? 'This sets up your store name, invoices and order screens. You can change it later in Settings.'
                : session ? `You are signed in as ${session.user.email}. Your business opens on this account.` : 'You will use this to sign in. We send one e-mail to confirm the address.'}
          </p>

          <div className="mt-7">
            {step === 0 && <PlanPicker options={options.data} value={business.plan_code} onChange={(plan_code) => setBusiness((b) => ({ ...b, plan_code }))} />}
            {step === 1 && <BusinessFields value={business} onChange={setBusiness} errors={errors} showErrors={touched} />}
            {step === 2 && !session && (
              <div className="grid gap-4">
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
                {usesClerk && <div id="clerk-captcha" />}
              </div>
            )}
            {step === 2 && (
              <div className="mt-5 rounded-2xl border bg-muted/40 p-4 text-[13px]">
                <p className="font-medium">{business.business_name.trim() || 'Your business'}</p>
                <p className="mt-0.5 text-muted-foreground">
                  {options.data.plans.find((p) => p.code === business.plan_code)?.name} plan
                  {(options.data.plans.find((p) => p.code === business.plan_code)?.trial_days ?? 0) > 0 && ` · ${options.data.plans.find((p) => p.code === business.plan_code)?.trial_days}-day free trial`}
                  {' · '}{normalizePhone(business.phone)}
                </p>
              </div>
            )}
          </div>

          {(open.error || (touched && step === 2 && accountError)) && (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {open.error ? (/already has an account/i.test(clerkErrorMessage(open.error))
                ? <>This e-mail already has an account. <Link to="/admin/login?next=/start/finish" className="font-medium underline">Sign in</Link> and your business opens there.</>
                : usesClerk ? clerkErrorMessage(open.error) : toUserMessage(open.error)) : accountError}
            </p>
          )}

          <div className="mt-8 flex items-center justify-between gap-3">
            {step > 0 ? <Button type="button" variant="ghost" onClick={() => setStep(step - 1)} disabled={open.isPending}><ArrowLeft /> Back</Button> : <span />}
            <Button type="submit" size="lg" variant={step === 2 ? 'brand' : 'default'} disabled={open.isPending || (step === 0 && !business.plan_code)}>
              {open.isPending && <Spinner />}
              {step < 2 ? <>Continue <ArrowRight /></> : session ? 'Open my business' : 'Create account'}
            </Button>
          </div>
        </form>
      )}
    </AuthShell>
  )
}
