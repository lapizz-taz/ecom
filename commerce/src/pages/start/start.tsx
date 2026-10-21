import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ArrowRight, Copy, MailCheck, MessageCircle, UserPlus } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Link, Navigate, useNavigate } from 'react-router'
import { Field } from '@/components/common/field'
import { ErrorState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { ResendConfirmation } from '@/features/auth/link-problem'
import { AuthShell } from '@/features/auth/auth-shell'
import { useAuth } from '@/features/auth/auth-context'
import { ClerkSignUpForm } from '@/features/auth/clerk-signup'
import { ClerkLinkNotice, useClerkLinkPending } from '@/features/auth/clerk-link-notice'
import { BusinessFields, businessErrors, PlanPicker, Steps } from '@/features/onboarding/signup-parts'
import { useTrackVisit } from '@/features/site/site-chrome'
import { useAdminTheme } from '@/hooks/use-admin-theme'
import { toUserMessage } from '@/lib/errors'
import { toast } from '@/lib/toast'
import { cn } from '@/lib/utils'
import { formatMoney } from '@/lib/format'
import { normalizePhone, normalizeWhatsapp } from '@/lib/phone'
import {
  clearSignupDraft, planOfferText, planThenText, readSignupDraft, saveSignupDraft, selfOnboard, signInOnceConfirmed, type SignupBusiness, signupOptions, signUpOwner, type SignupPlan, signupRequest, type SignupRequestResult, whatsappLink,
} from '@/services/onboarding'

const EMPTY: SignupBusiness = {
  business_name: '', full_name: '', phone: '', whatsapp: '', business_type: '', website: '', sells_on: [], orders_per_month: '', plan_code: '',
}

/**
 * Public sign-up: choose a plan, describe the business, create the owner
 * account. The business opens as soon as the e-mail is confirmed (at once
 * when the project does not ask for confirmation).
 */
export default function StartPage() {
  useAdminTheme()
  useTrackVisit()
  const { session, access, loading, accessLoading, usesClerk } = useAuth()
  const linkPending = useClerkLinkPending()
  const minPassword = 8
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
  // Normal sign-up (own login now) or sign-up by WhatsApp (the team opens it); each is switched on in Super Admin.
  const [chosen, setChosen] = useState<'account' | 'whatsapp' | null>(null)
  const [requestEmail, setRequestEmail] = useState('')
  const [requested, setRequested] = useState<SignupRequestResult | null>(null)

  // Start on the default plan once the plans are known.
  useEffect(() => {
    const o = options.data
    if (!o || business.plan_code) return
    // A plan picked on the product site comes in as ?plan=CODE.
    const wanted = new URLSearchParams(window.location.search).get('plan')
    const code = o.plans.find((p) => p.code === wanted)?.code ?? o.plans.find((p) => p.code === o.default_plan)?.code ?? o.plans[0]?.code ?? ''
    setBusiness((b) => ({ ...b, plan_code: code }))
  }, [options.data, business.plan_code])

  const payload = () => ({ ...business, phone: normalizePhone(business.phone), whatsapp: normalizeWhatsapp(business.whatsapp ?? ''), business_name: business.business_name.trim(), full_name: business.full_name.trim(), website: business.website.trim() })
  const open = useMutation({
    meta: { silent: true },
    mutationFn: async () => {
      if (session) return { opened: await selfOnboard(payload()) }
      saveSignupDraft(payload())
      const res = await signUpOwner(email, password, payload())
      if (res.session) return { opened: await selfOnboard(payload()) }
      return { confirm: email.trim() }
    },
    onSuccess: async (r) => {
      if ('confirm' in r && r.confirm) { setSentTo(r.confirm); return }
      clearSignupDraft()
      await queryClient.invalidateQueries({ queryKey: ['my-access'] })
      navigate('/admin?welcome=1', { replace: true })
    },
  })

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

  if (loading || (session && accessLoading)) return <AuthShell><div className="flex justify-center"><Spinner className="size-5" /></div></AuthShell>
  if (session && access) return <Navigate to={open.isSuccess ? '/admin?welcome=1' : '/admin'} replace />

  const errors = businessErrors(business)
  const normalOpen = options.data?.enabled ?? false
  const whatsappOpen = Boolean(options.data?.whatsapp_signup?.enabled && options.data.whatsapp_signup.number)
  const mode: 'account' | 'whatsapp' = chosen === 'whatsapp' && whatsappOpen ? 'whatsapp' : chosen === 'account' && normalOpen ? 'account' : normalOpen ? 'account' : 'whatsapp'
  const stepsLabels = ['Plan', 'Business', mode === 'whatsapp' ? 'Send' : session ? 'Confirm' : 'Account']
  const chooser = normalOpen && whatsappOpen && !session && <ModeChooser value={mode} onChange={setChosen} />
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
      ) : !normalOpen && !whatsappOpen ? (
        <div>
          <h1 className="text-[26px] font-semibold tracking-[-0.025em]">Sign-ups are paused</h1>
          <p className="mt-2 text-sm text-muted-foreground">New businesses cannot open an account on their own right now. E-mail help@fullfilio.com and we will set yours up.</p>
          <Button asChild variant="outline" className="mt-6"><Link to="/admin/login">Sign in instead</Link></Button>
        </div>
      ) : step === 2 && mode === 'whatsapp' ? (
        <WhatsappStep steps={<Steps steps={stepsLabels} current={step} />} chooser={chooser} business={payload()} email={requestEmail} onEmail={setRequestEmail}
          planLabel={planLabel(options.data, business)} sent={requested} onSent={setRequested} onBack={() => { setRequested(null); setStep(1) }} />
      ) : step === 2 && !session && usesClerk ? (
        // The account on Clerk (e-mail with a 6-digit code). The details above are
        // saved in this browser and the business opens on /start/finish.
        <div>
          <Steps steps={stepsLabels} current={step} />
          {chooser}
          <div className="mt-6 rounded-2xl border bg-muted/40 p-4 text-[13px]">
            <p className="font-medium">{business.business_name.trim() || 'Your business'}</p>
            <p className="mt-0.5 text-muted-foreground">
              {planLabel(options.data, business)}
              {' · '}{normalizePhone(business.phone)}
            </p>
          </div>
          <div className="mt-6">
            {linkPending ? <ClerkLinkNotice className="w-full" />
              : <ClerkSignUpForm fullName={business.full_name} phone={normalizePhone(business.phone)} minPassword={minPassword}
                  onDone={() => navigate('/start/finish', { replace: true })} />}
          </div>
          <div className="mt-6"><Button type="button" variant="ghost" onClick={() => setStep(1)}><ArrowLeft /> Back</Button></div>
        </div>
      ) : (
        <form noValidate onSubmit={(e) => {
          e.preventDefault()
          if (step === 0) { if (business.plan_code) setStep(1); return }
          if (step === 1) {
            setTouched(true)
            if (Object.keys(errors).length) return
            if (usesClerk && !session) saveSignupDraft(payload())
            setStep(2); return
          }
          setTouched(true)
          if (!accountError && !Object.keys(errors).length) open.mutate()
        }}>
          <Steps steps={stepsLabels} current={step} />
          {step === 2 && chooser}
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

              </div>
            )}
            {step === 2 && (
              <div className="mt-5 rounded-2xl border bg-muted/40 p-4 text-[13px]">
                <p className="font-medium">{business.business_name.trim() || 'Your business'}</p>
                <p className="mt-0.5 text-muted-foreground">
                  {planLabel(options.data, business)}
                  {' · '}{normalizePhone(business.phone)}
                </p>
              </div>
            )}
          </div>

          {(open.error || (touched && step === 2 && accountError)) && (
            <p className="mt-4 text-sm text-destructive" role="alert">
              {open.error ? (/already has an account/i.test(open.error.message)
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

function planLabel(options: { plans: SignupPlan[] }, business: SignupBusiness) {
  const plan = options.plans.find((p) => p.code === business.plan_code)
  if (!plan) return 'No plan chosen'
  const offer = planOfferText(plan, formatMoney)
  return `${plan.name} plan${offer ? ` · ${offer} · ${planThenText(plan, formatMoney)}` : ''}`
}

/** Both ways are switched on: the visitor picks one. */
function ModeChooser({ value, onChange }: { value: 'account' | 'whatsapp'; onChange: (v: 'account' | 'whatsapp') => void }) {
  const option = (v: 'account' | 'whatsapp', icon: ReactNode, title: string, text: string) => (
    <button type="button" onClick={() => onChange(v)} aria-pressed={value === v}
      className={cn('flex min-w-0 items-start gap-3 rounded-2xl border p-3.5 text-left transition-colors',
        value === v ? 'border-brand bg-brand/5 ring-1 ring-brand' : 'hover:bg-muted/50')}>
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-xl', value === v ? 'bg-brand text-white' : 'bg-muted text-muted-foreground')}>{icon}</span>
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-[12.5px] text-muted-foreground">{text}</span>
      </span>
    </button>
  )
  return (
    <div className="mt-6 grid gap-2.5 sm:grid-cols-2" role="group" aria-label="How do you want to start?">
      {option('account', <UserPlus className="size-4" />, 'Create my account now', 'Choose an e-mail and password and start right away.')}
      {option('whatsapp', <MessageCircle className="size-4" />, 'Set up with our team', 'Send your details on WhatsApp; we open the account for you.')}
    </div>
  )
}

/**
 * Sign-up by WhatsApp: the details are kept as a request (no login is created)
 * and the visitor sends the prepared message to the official number.
 */
function WhatsappStep({ steps, chooser, business, email, onEmail, planLabel: plan, sent, onSent, onBack }: {
  steps: ReactNode; chooser: ReactNode; business: SignupBusiness; email: string; onEmail: (v: string) => void; planLabel: string
  sent: SignupRequestResult | null; onSent: (r: SignupRequestResult) => void; onBack: () => void
}) {
  const [agree, setAgree] = useState(false)
  const [touched, setTouched] = useState(false)
  const send = useMutation({ meta: { silent: true }, mutationFn: () => signupRequest({ ...business, email: email.trim() }), onSuccess: onSent })
  const problem = !email.trim() ? 'Enter your e-mail address' : !/^\S+@\S+\.\S+$/.test(email.trim()) ? 'Enter a valid e-mail address' : !agree ? 'Accept the terms to continue' : null

  if (sent) {
    const link = whatsappLink(sent.whatsapp_number, sent.message)
    return (
      <div>
        {steps}
        <span className="mt-8 flex size-12 items-center justify-center rounded-2xl border bg-card shadow-xs"><MessageCircle className="size-6 text-emerald-500" /></span>
        <h1 className="mt-5 text-[26px] leading-tight font-semibold tracking-[-0.025em]">Send your details on WhatsApp</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Tap the button: WhatsApp opens with the message ready. Press send, and our team replies there and opens {business.business_name || 'your business'} for you.
        </p>
        <Button asChild size="lg" variant="brand" className="mt-6 w-full sm:w-auto">
          <a href={link} target="_blank" rel="noopener noreferrer"><MessageCircle /> Open WhatsApp</a>
        </Button>
        <div className="mt-6 rounded-2xl border bg-muted/40 p-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-[13px] font-medium">Your message · ref {sent.reference}</p>
            <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => {
              navigator.clipboard.writeText(sent.message).then(() => toast.success('Message copied'), () => toast.error('Could not copy; select the text instead'))
            }}><Copy /> Copy</Button>
          </div>
          <pre className="mt-2 font-sans text-[13px] whitespace-pre-wrap break-words text-muted-foreground">{sent.message}</pre>
          <p className="mt-3 text-[12px] text-muted-foreground">WhatsApp did not open? Message <span className="font-medium text-foreground tabular-nums">+{sent.whatsapp_number}</span> and paste the text above.</p>
        </div>
        <div className="mt-6"><Button type="button" variant="ghost" onClick={onBack}><ArrowLeft /> Change details</Button></div>
      </div>
    )
  }

  return (
    <form noValidate onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!problem) send.mutate() }}>
      {steps}
      {chooser}
      <h1 className="mt-8 text-[28px] leading-tight font-semibold tracking-[-0.025em]">Get set up on WhatsApp</h1>
      <p className="mt-2 text-sm text-muted-foreground">We prepare a message with your details. You send it to our official WhatsApp, and our team opens the account and helps you get started. No password needed now.</p>
      <div className="mt-7 grid gap-4">
        <Field label="E-mail" required hint="For your login">
          <Input type="email" autoComplete="email" required value={email} onChange={(e) => onEmail(e.target.value)} className="h-10" placeholder="you@yourshop.com" />
        </Field>
        <label className="flex items-start gap-2.5 text-[13px] text-muted-foreground">
          <Checkbox checked={agree} onCheckedChange={(v) => setAgree(v === true)} className="mt-0.5" />
          <span>I agree to the terms of service and privacy policy, and confirm I run this business.</span>
        </label>
      </div>
      <div className="mt-5 rounded-2xl border bg-muted/40 p-4 text-[13px]">
        <p className="font-medium">{business.business_name || 'Your business'}</p>
        <p className="mt-0.5 text-muted-foreground">{plan} · {business.phone}</p>
      </div>
      {(send.error || (touched && problem)) && (
        <p className="mt-4 text-sm text-destructive" role="alert">{send.error ? toUserMessage(send.error) : problem}</p>
      )}
      <div className="mt-8 flex items-center justify-between gap-3">
        <Button type="button" variant="ghost" onClick={onBack} disabled={send.isPending}><ArrowLeft /> Back</Button>
        <Button type="submit" size="lg" variant="brand" disabled={send.isPending}>
          {send.isPending ? <Spinner /> : <MessageCircle />} Continue to WhatsApp
        </Button>
      </div>
    </form>
  )
}
