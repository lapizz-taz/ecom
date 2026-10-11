import { SignIn } from '@clerk/clerk-react'
import { dark } from '@clerk/themes'
import { Lock, ShieldCheck } from 'lucide-react'
import { Navigate, useNavigate, useSearchParams } from 'react-router'
import { LogoMark, Wordmark } from '@/components/brand/logo'
import { Spinner } from '@/components/common/states'
import { useAuth } from '@/features/auth/auth-context'
import { superAdminUnlocked } from '@/lib/super-admin-gate'
import MarketingNotFound from '@/pages/marketing/not-found'
import { SignInForm } from '@/pages/storefront/login'

/** Only internal paths, so a crafted link cannot send the sign-in elsewhere. */
const safeNext = (next: string | null) => (next && next.startsWith('/super-admin') && !next.startsWith('//') ? next : '/super-admin')

/**
 * The Super Admin's own sign-in: a dark console screen, no sign-up. Like the
 * panel itself it only opens on a device that came in through the secret
 * address; who may use the panel is still decided by the database.
 */
export default function SuperAdminLoginPage() {
  const { session, loading, clerkError, signOut, usesClerk } = useAuth()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const next = safeNext(params.get('next'))
  if (!superAdminUnlocked()) return <MarketingNotFound />
  if (session) return <Navigate to={next} replace />

  return (
    // Always dark, whatever the admin theme is: the "dark" class gives this page the dark colours.
    <div className="dark relative flex min-h-dvh flex-col overflow-hidden bg-[#060608] px-4 text-zinc-100">
      {/* Fine grid with a dim amber glow; no images to download. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgb(255_255_255/0.04)_1px,transparent_1px),linear-gradient(90deg,rgb(255_255_255/0.04)_1px,transparent_1px)] bg-[size:32px_32px] [mask-image:radial-gradient(ellipse_at_center,black_30%,transparent_75%)]" />
      <div aria-hidden className="pointer-events-none absolute top-[-18rem] left-1/2 size-[40rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,rgb(245_158_11/0.16),transparent)] blur-2xl" />

      <header className="relative mx-auto flex w-full max-w-5xl items-center justify-between py-5">
        <span className="flex items-center gap-2.5">
          <LogoMark className="size-7" />
          <Wordmark className="h-[18px] text-white" />
          <span className="ml-1 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] tracking-[0.18em] text-zinc-400 uppercase">Ops</span>
        </span>
        <span className="hidden items-center gap-1.5 font-mono text-[11px] tracking-wide text-zinc-500 sm:flex">
          <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400/70" /> Platform console
        </span>
      </header>

      <main className="relative mx-auto flex w-full max-w-[400px] flex-1 flex-col justify-center py-10">
        <div className="mb-6 text-center">
          <span className="mx-auto mb-4 flex size-11 items-center justify-center rounded-2xl border border-amber-400/25 bg-amber-400/10 text-amber-300">
            <Lock className="size-5" />
          </span>
          <h1 className="text-2xl font-semibold tracking-[-0.02em] text-white">Super Admin</h1>
          <p className="mt-1.5 text-sm text-zinc-400">Restricted area. Sign in with your platform staff account.</p>
        </div>

        {clerkError && (
          <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm" role="alert">
            <p className="text-red-300">{clerkError.message}</p>
            <button type="button" className="mt-1 text-xs font-medium text-zinc-300 underline underline-offset-4" onClick={() => void signOut()}>Sign out and try another account</button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-10"><Spinner className="size-5" /></div>
        ) : usesClerk ? (
          <div className="flex justify-center">
            <SignIn routing="hash" fallbackRedirectUrl={next} forceRedirectUrl={next}
              appearance={{
                baseTheme: dark,
                layout: { logoPlacement: 'none', socialButtonsPlacement: 'top', socialButtonsVariant: 'blockButton' },
                variables: {
                  colorPrimary: '#f4f4f5', colorTextOnPrimaryBackground: '#09090b', colorBackground: '#0d0d10',
                  colorInputBackground: '#141418', colorInputText: '#f4f4f5', borderRadius: '0.7rem', fontFamily: 'inherit',
                },
                elements: {
                  rootBox: 'w-full',
                  cardBox: 'w-full shadow-none border border-white/10',
                  card: 'bg-[#0d0d10]',
                  header: 'hidden',
                  footerAction: 'hidden',
                },
              }} />
          </div>
        ) : (
          <div className="rounded-2xl border border-white/10 bg-[#0d0d10] p-6 text-zinc-100 [&_label]:text-zinc-300">
            <SignInForm onDone={() => navigate(next)} forgotPath="/admin/forgot-password" />
          </div>
        )}

        <p className="mt-6 flex items-start justify-center gap-1.5 text-center text-xs text-zinc-500">
          <ShieldCheck className="mt-px size-3.5 shrink-0" /> Every sign-in and action here is recorded in the platform audit log.
        </p>
      </main>

      <footer className="relative py-5 text-center font-mono text-[11px] text-zinc-600">Fullfilio Ops · authorised staff only</footer>
    </div>
  )
}
