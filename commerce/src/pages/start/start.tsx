import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, MailCheck } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { Field } from '@/components/common/field'
import { ErrorState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { AuthShell } from '@/features/auth/auth-shell'
import { useAuth } from '@/features/auth/auth-context'
import { BusinessFields, businessErrors, PlanPicker, Steps } from '@/features/onboarding/signup-parts'
import { useAdminTheme } from '@/hooks/use-admin-theme'
import { toUserMessage } from '@/lib/errors'
import { normalizePhone } from '@/lib/phone'
import {
  clearSignupDraft, readSignupDraft, saveSignupDraft, selfOnboard, signUpOwner, signupOptions, type SignupBusiness,
} from '@/services/onboarding'

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
  const { session, access, loading, accessLoading } = useAuth()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const options = useQuery({ queryKey: ['signup-options'], queryFn: signupOptions, staleTime: 5 * 60_000 })
  const [step, setStep] = useState(0)
  const [business, setBusiness] = useState<SignupBusiness>(() => readSignupDraft() ?? EMPTY)
  const [touched, setTouched] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [agree, setAgree] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)

  // Start on the default plan once the plans are known.
  useEffect(() => {
    const o = options.data
    if (!o || business.plan_code) return
    const code = o.plans.find((p) => p.code === o.default_plan)?.code ?? o.plans[0]?.code ?? ''
    setBusiness((b) => ({ ...b, plan_code: code }))
  }, [options.data, business.plan_code])

  const open = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      const payload = { ...business, phone: normalizePhone(business.phone), business_name: business.business_name.trim(), full_name: business.full_name.trim(), website: business.website.trim() }
      if (session) return { opened: await selfOnboard(payload) }
      saveSignupDraft(payload)
      const res = await signUpOwner(email, password, payload)
      if (res.session) return { opened: await selfOnboard(payload) }
      return { confirm: email.trim() }
    },
    onSuccess: async (r) => {
      if ('confirm' in r && r.confirm) { setSentTo(r.confirm); return }
      clearSignupDraft()
      await queryClient.invalidateQueries({ queryKey: ['my-access'] })
      navigate('/admin?welcome=1', { replace: true })
    },
  })

  if (loading || (session && accessLoading)) return <AuthShell><div className="flex justify-center"><Spinner className="size-5" /></div></AuthShell>
  if (session && access) return <Navigate to="/admin" replace />

  const errors = businessErrors(business)
  const stepsLabels = ['Plan', 'Business', session ? 'Confirm' : 'Account']
  const accountError = !session && (!/^\S+@\S+\.\S+$/.test(email.trim()) ? 'Enter your e-mail address' : password.length < 8 ? 'Use at least 8 characters for the password' : !agree ? 'Accept the terms to continue' : null)

  if (sentTo) {
    return (
      <AuthShell>
        <span className="flex size-12 items-center justify-center rounded-2xl border bg-card shadow-xs"><MailCheck className="size-6 text-brand" /></span>
        <h1 className="mt-5 text-[26px] leading-tight font-semibold tracking-[-0.025em]">Check your inbox</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          We sent a confirmation link to <span className="font-medium text-foreground">{sentTo}</span>. Open it on this device and {business.business_name.trim() || 'your business'} opens straight away, with everything you entered.
        </p>
        <div className="mt-6 rounded-2xl border bg-muted/40 p-4 text-[13px] text-muted-foreground">
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
          if (step === 1) { setTouched(true); if (!Object.keys(errors).length) setStep(2); return }
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
                <Field label="Password" required hint="At least 8 characters">
                  <Input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} className="h-10" />
                </Field>
                <label className="flex items-start gap-2.5 text-[13px] text-muted-foreground">
                  <Checkbox checked={agree} onCheckedChange={(v) => setAgree(v === true)} className="mt-0.5" />
                  <span>I agree to the terms of service and privacy policy, and confirm I run this business.</span>
                </label>
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
              {open.error ? (/already has an account/.test(open.error.message)
                ? <>This e-mail already has an account. <Link to="/admin/login?next=/start/finish" className="font-medium underline">Sign in</Link> and your business opens there.</>
                : toUserMessage(open.error)) : accountError}
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
