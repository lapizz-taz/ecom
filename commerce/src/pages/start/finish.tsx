import { SignIn } from '@clerk/clerk-react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { ErrorState, Spinner } from '@/components/common/states'
import { Button } from '@/components/ui/button'
import { LinkErrorNotice, ResendConfirmation, useAuthLinkError } from '@/features/auth/link-problem'
import { AuthShell } from '@/features/auth/auth-shell'
import { useAuth } from '@/features/auth/auth-context'
import { ClerkLinkNotice, useClerkLinkPending } from '@/features/auth/clerk-link-notice'
import { BusinessFields, businessErrors, PlanPicker } from '@/features/onboarding/signup-parts'
import { useSitePageView } from '@/features/site/site-chrome'
import { trackSignup } from '@/features/site/site-pixel'
import { useAdminTheme } from '@/hooks/use-admin-theme'
import { toUserMessage } from '@/lib/errors'
import { normalizePhone, normalizeWhatsapp } from '@/lib/phone'
import { SignInForm } from '@/pages/storefront/login'
import { clearSignupDraft, readSignupDraft, selfOnboard, signupOptions, type SignupBusiness } from '@/services/onboarding'

/**
 * Where the confirmation e-mail lands (and where a signed-in person without a
 * business is sent): opens the business from the details given at sign-up,
 * or asks for them when there are none.
 */
export default function StartFinishPage() {
  useAdminTheme()
  useSitePageView()
  const linkError = useAuthLinkError()
  const { session, user, access, loading, accessLoading, usesClerk } = useAuth()
  const linkPending = useClerkLinkPending()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const options = useQuery({ queryKey: ['signup-options'], queryFn: signupOptions, staleTime: 5 * 60_000, enabled: Boolean(session) })
  const [business, setBusiness] = useState<SignupBusiness | null>(null)
  const [touched, setTouched] = useState(false)
  const tried = useRef(false)

  const open = useMutation({
    meta: { silent: true },
    mutationFn: (b: SignupBusiness) => selfOnboard({ ...b, phone: normalizePhone(b.phone), whatsapp: normalizeWhatsapp(b.whatsapp ?? '') }),
    onSuccess: async (_r, b) => {
      trackSignup(options.data?.plans.find((p) => p.code === b.plan_code), { email: user?.email, phone: b.phone, name: b.full_name })
      clearSignupDraft()
      await queryClient.invalidateQueries({ queryKey: ['my-access'] })
      navigate('/admin?welcome=1', { replace: true })
    },
  })

  // The details typed at sign-up open the business on arrival (once).
  useEffect(() => {
    if (!user || access || accessLoading || tried.current) return
    const draft = readSignupDraft(user.user_metadata)
    const fallback = { business_name: '', full_name: String(user.user_metadata?.full_name ?? ''), phone: String(user.user_metadata?.phone ?? ''), whatsapp: '', business_type: '', website: '', sells_on: [], orders_per_month: '', plan_code: '' }
    setBusiness(draft ?? fallback)
    tried.current = true
    if (draft) open.mutate(draft)
  }, [user, access, accessLoading, open])

  useEffect(() => {
    const o = options.data
    if (!o || !business || business.plan_code) return
    setBusiness({ ...business, plan_code: o.plans.find((p) => p.code === o.default_plan)?.code ?? o.plans[0]?.code ?? '' })
  }, [options.data, business])

  if (!linkPending && (loading || (session && accessLoading))) return <AuthShell><div className="flex justify-center"><Spinner className="size-5" /></div></AuthShell>
  if (access) return <Navigate to={open.isSuccess ? '/admin?welcome=1' : '/admin'} replace />
  if (!session) {
    return (
      <AuthShell>
        <h1 className="text-[26px] leading-tight font-semibold tracking-[-0.025em]">{linkError ? 'Confirm your e-mail' : 'Sign in to finish'}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sign in with the account you created and your business opens right after.</p>
        {linkError && (
          <div className="mt-6 space-y-3">
            <LinkErrorNotice error={linkError} />
            <ResendConfirmation returnPath="/start/finish" />
          </div>
        )}
        <div className="mt-8 flex justify-center">
          {linkPending ? <ClerkLinkNotice className="w-full" />
            : usesClerk ? <SignIn routing="hash" signUpUrl="/start" forceRedirectUrl="/start/finish" />
              : <SignInForm onDone={() => undefined} forgotPath="/admin/forgot-password" />}
        </div>
      </AuthShell>
    )
  }
  if (open.isPending || !business) {
    return (
      <AuthShell>
        <div className="flex flex-col items-center gap-3 text-center">
          <Spinner className="size-6" />
          <p className="font-medium">Opening your business…</p>
          <p className="text-sm text-muted-foreground">Setting up your store, order screens and plan.</p>
        </div>
      </AuthShell>
    )
  }

  const errors = businessErrors(business)
  return (
    <AuthShell wide>
      <h1 className="text-[28px] leading-tight font-semibold tracking-[-0.025em]">Open your business</h1>
      <p className="mt-2 text-sm text-muted-foreground">Signed in as {user?.email}. Check the details and choose a plan.</p>
      {open.error && <p className="mt-5 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">{toUserMessage(open.error)}</p>}
      {options.error ? <ErrorState error={options.error} onRetry={() => options.refetch()} /> : !options.data ? <div className="mt-8 flex justify-center"><Spinner /></div> : (
        <form noValidate className="mt-7 grid gap-8" onSubmit={(e) => { e.preventDefault(); setTouched(true); if (!Object.keys(errors).length && business.plan_code) open.mutate(business) }}>
          <BusinessFields value={business} onChange={setBusiness} errors={errors} showErrors={touched} />
          <div>
            <p className="mb-3 text-sm font-medium">Plan</p>
            <PlanPicker options={options.data} value={business.plan_code} onChange={(plan_code) => setBusiness({ ...business, plan_code })} />
          </div>
          <Button type="submit" size="lg" variant="brand" disabled={!options.data.enabled}>Open my business</Button>
          {!options.data.enabled && <p className="-mt-5 text-sm text-muted-foreground">New sign-ups are paused at the moment; e-mail help@fullfilio.com to open an account.</p>}
        </form>
      )}
    </AuthShell>
  )
}
