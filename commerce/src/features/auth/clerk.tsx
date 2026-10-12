import { ClerkProvider, useAuth as useClerkAuth, useClerk } from '@clerk/clerk-react'
import { isClerkAPIResponseError } from '@clerk/clerk-react/errors'
import { dark } from '@clerk/themes'
import type { Session } from '@supabase/supabase-js'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { env } from '@/lib/env'
import { currentSite } from '@/lib/merchant'
import { reportError } from '@/lib/monitoring'
import { endSupabaseSession, exchangeClerkSession } from '@/services/clerk-auth'

// Clerk handles sign-up, e-mail codes, sign-in (password, e-mail code, Google)
// and password resets on the Fullfilio site and the staff pages, with Clerk's
// own sign-in and sign-up boxes and account menu. Shoppers on a merchant's own
// store keep the store's own customer sign-in: those pages run on many domains.

/** Clerk is used on this page: a key is set and this is the Fullfilio site or a staff page. */
export const clerkEnabled = (): boolean =>
  Boolean(env.clerkPublishableKey) && (currentSite().kind === 'platform' || location.pathname.startsWith('/admin'))

/** Follows the page's dark class (the admin theme can change while the page is open). */
function useDarkPage(): boolean {
  const [isDark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const root = document.documentElement
    const watch = new MutationObserver(() => setDark(root.classList.contains('dark')))
    watch.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => watch.disconnect()
  }, [])
  return isDark
}

/**
 * Where the browser reaches Clerk. On fullfilio.com Clerk has its own DNS
 * (clerk.fullfilio.com), set with an empty VITE_CLERK_PROXY_URL. Without the
 * setting, a production instance is reached through this site's own /__clerk
 * address (the Worker, or vercel.json, sends it to the clerk-proxy function),
 * for addresses where we have no DNS records (vercel.app). Development keys
 * talk to Clerk directly.
 */
export const clerkProxyUrl = (key: string | null | undefined, configured: string | undefined = env.clerkProxyUrl): string | undefined => {
  if (configured !== undefined) return configured || undefined
  return key?.startsWith('pk_live_') ? '/__clerk' : undefined
}

function ClerkProviderWithTheme({ children }: { children: ReactNode }) {
  const isDark = useDarkPage()
  return (
    <ClerkProvider
      publishableKey={env.clerkPublishableKey!}
      proxyUrl={clerkProxyUrl(env.clerkPublishableKey)}
      signInUrl="/admin/login"
      signUpUrl="/start"
      signInFallbackRedirectUrl="/admin"
      signUpFallbackRedirectUrl="/start/finish"
      afterSignOutUrl="/admin/login"
      appearance={{
        baseTheme: isDark ? dark : undefined,
        layout: { logoImageUrl: '/favicon.svg', socialButtonsPlacement: 'top', socialButtonsVariant: 'blockButton' },
        variables: { colorPrimary: '#2142e7', borderRadius: '0.75rem', fontFamily: 'inherit' },
      }}
    >
      {children}
    </ClerkProvider>
  )
}

export function ClerkRoot({ children }: { children: ReactNode }) {
  if (!clerkEnabled()) return <>{children}</>
  return <ClerkProviderWithTheme>{children}</ClerkProviderWithTheme>
}

export interface ClerkLink {
  /** Clerk has loaded and the database session matches it (or nobody is signed in). */
  ready: boolean
  /** The Clerk sign-in could not be turned into a Fullfilio session. */
  error: Error | null
  /** Waits until the signed-in Clerk user has a Fullfilio session in this browser. */
  sync: () => Promise<void>
  signOut: () => Promise<void>
}

/**
 * Keeps the database session in step with Clerk: a Clerk sign-in opens the
 * matching account, a Clerk sign-out closes it. A session that did not come
 * from Clerk (e.g. a shopper's store account) is left alone.
 */
export function ClerkSessionSync({ session, onChange }: { session: Session | null; onChange: (link: ClerkLink) => void }) {
  // A Clerk session waiting on a Clerk-side step (e.g. "choose an organization") still
  // belongs to a signed-in person; Fullfilio has its own businesses, so it counts as signed in.
  const { isLoaded, isSignedIn, userId, getToken } = useClerkAuth({ treatPendingAsSignedOut: false })
  const clerk = useClerk()
  const [error, setError] = useState<Error | null>(null)
  // If Clerk cannot load (network, blocker), stop waiting: pages open and say so.
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    if (isLoaded) return
    const t = window.setTimeout(() => setGaveUp(true), 10_000)
    return () => window.clearTimeout(t)
  }, [isLoaded])
  const inflight = useRef<Promise<void> | null>(null)
  const linkedTo = (session?.user.app_metadata?.clerk_user_id as string | undefined) ?? null

  const sync = useCallback(() => {
    if (!inflight.current) {
      inflight.current = (async () => {
        const token = await getToken()
        if (!token) throw new Error('Sign in again')
        await exchangeClerkSession(token)
        setError(null)
      })().finally(() => { inflight.current = null })
    }
    return inflight.current
  }, [getToken])

  useEffect(() => {
    if (!isLoaded) return
    if (isSignedIn && userId && linkedTo !== userId) {
      sync().catch((e: Error) => { setError(e); reportError(e, { where: 'clerk-session-sync' }) })
    } else if (!isSignedIn && linkedTo && !inflight.current && !clerk.user) {
      // Signed out of Clerk (here or in another tab): close the account here too. The live
      // check on clerk.user avoids reacting to a render that has not caught up with a sign-in.
      void endSupabaseSession()
    }
  }, [isLoaded, isSignedIn, userId, linkedTo, sync, clerk])

  const ready = (isLoaded && (!isSignedIn || linkedTo === userId || error !== null)) || (!isLoaded && gaveUp)
  const shownError = error ?? (!isLoaded && gaveUp ? new Error('Could not reach the sign-in service. Check your connection and reload the page.') : null)
  const signOut = useCallback(async () => {
    await clerk.signOut().catch((e) => reportError(e, { where: 'clerk-sign-out' }))
    await endSupabaseSession()
  }, [clerk])
  useEffect(() => { onChange({ ready, error: shownError, sync, signOut }) }, [ready, shownError?.message, sync, signOut, onChange])
  return null
}

/** Clerk's error in words a person can act on. */
export function clerkErrorMessage(error: unknown): string {
  if (isClerkAPIResponseError(error)) {
    const first = error.errors[0]
    switch (first?.code) {
      case 'form_password_incorrect':
      case 'form_identifier_not_found': return 'Email or password is incorrect'
      case 'form_code_incorrect': return 'That code is not right. Check the latest e-mail and try again.'
      case 'verification_expired': return 'That code has expired. Send a new one.'
      case 'form_identifier_exists': return 'This e-mail already has an account. Sign in instead.'
      case 'too_many_requests': return 'Too many tries. Wait a minute, then try again.'
      default: return first?.longMessage ?? first?.message ?? 'Something went wrong. Please try again.'
    }
  }
  return error instanceof Error ? error.message : 'Something went wrong. Please try again.'
}

/** The Clerk error code, when there is one. */
export const clerkErrorCode = (error: unknown): string | null =>
  isClerkAPIResponseError(error) ? (error.errors[0]?.code ?? null) : null
