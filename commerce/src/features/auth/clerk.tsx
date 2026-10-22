import { ClerkProvider, useAuth as useClerkAuth, useClerk } from '@clerk/clerk-react'
import { isClerkAPIResponseError, isClerkRuntimeError } from '@clerk/clerk-react/errors'
import { dark } from '@clerk/themes'
import type { Session } from '@supabase/supabase-js'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { env } from '@/lib/env'
import { setSessionRenewer } from '@/lib/functions'
import { currentSite } from '@/lib/merchant'
import { reportError } from '@/lib/monitoring'
import { supabase } from '@/lib/supabase'
import { currentClerkLink, endSupabaseSession, exchangeClerkSession } from '@/services/clerk-auth'

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
        variables: { colorPrimary: '#2563eb', borderRadius: '0.75rem', fontFamily: 'inherit' },
        // Clerk's Continue button is the app's blue glow button too (index.css, .btn-glow).
        elements: { formButtonPrimary: 'btn-glow' },
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

/** Opening the account by itself at most this many times per window; then the page asks. */
const AUTO_LIMIT = 3
const AUTO_WINDOW_MS = 60_000
/** How long Clerk must stay signed out before the account here is closed too. */
const SIGN_OUT_GRACE_MS = 2_000

/**
 * Whether someone is signed in to Clerk in this browser, from Clerk's own "__client_uat"
 * cookie (shared by every tab, "0" once signed out); null when the cookie is not there.
 */
export function clerkSignedInHere(cookies: string): boolean | null {
  const values = cookies.split(';').map((c) => c.trim()).filter((c) => /^__client_uat(_[^=]*)?=/.test(c)).map((c) => c.slice(c.indexOf('=') + 1))
  if (!values.length) return null
  return values.some((v) => v !== '' && v !== '0')
}

/** Runs `fn` while no other tab of this site runs it (Web Locks; directly where unsupported). */
async function oneTabAtATime(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined
  if (locks) await locks.request('fullfilio-clerk-session', fn)
  else await fn()
}

export interface ClerkLink {
  /** Clerk has loaded and the database session matches it (or nobody is signed in). */
  ready: boolean
  /** Clerk has a signed-in person in this browser (whether or not the Fullfilio session is open yet). */
  signedIn: boolean
  /** The Clerk sign-in could not be turned into a Fullfilio session. */
  error: Error | null
  /** Waits until the signed-in Clerk user has a Fullfilio session in this browser. */
  sync: () => Promise<void>
  /** Tries again after an error (once, when the person asks). */
  retry: () => void
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
  // When this tab opened the account by itself lately (see AUTO_LIMIT).
  const autoSyncs = useRef<number[]>([])
  const linkedTo = (session?.user.app_metadata?.clerk_user_id as string | undefined) ?? null

  const sync = useCallback(() => {
    if (!inflight.current) {
      inflight.current = (async () => {
        // One tab at a time: the others find the account already open (tabs share it) and skip.
        await oneTabAtATime(async () => {
          if (userId && (await currentClerkLink()) === userId) return
          const token = await getToken()
          if (!token) throw new Error('Sign in again')
          await exchangeClerkSession(token)
        })
        setError(null)
      })().finally(() => { inflight.current = null })
    }
    return inflight.current
  }, [getToken, userId])

  useEffect(() => {
    if (!isLoaded) return
    if (isSignedIn && userId && linkedTo !== userId) {
      // Something keeps closing the account right after it opens (e.g. an old Fullfilio tab):
      // stop instead of opening it again and again, and say so.
      const now = Date.now()
      autoSyncs.current = autoSyncs.current.filter((t) => now - t < AUTO_WINDOW_MS)
      if (autoSyncs.current.length >= AUTO_LIMIT) {
        setError((e) => e ?? new Error('Your account was signed out again right after it opened, most likely by another Fullfilio tab or window. Close or reload your other Fullfilio tabs, then press Try again.'))
        return
      }
      autoSyncs.current.push(now)
      sync().catch((e: Error) => { setError(e); reportError(e, { where: 'clerk-session-sync' }) })
    } else if (!isSignedIn && linkedTo && !inflight.current && !clerk.user) {
      // Signed out of Clerk: close the account in this browser too (only here: other devices
      // keep theirs). Clerk can show "signed out" for a moment (right after the account opens
      // it did, and the account was closed again and again), and a tab in the background keeps
      // Clerk's state from before a sign-in made in another tab. So only a sign-out that lasts,
      // and that Clerk's own cookie (shared by every tab) agrees with, closes the account.
      const t = window.setTimeout(() => {
        if (clerk.user || clerk.session) return
        const here = clerkSignedInHere(document.cookie)
        if (here || (here === null && document.visibilityState !== 'visible')) return
        void endSupabaseSession('local')
      }, SIGN_OUT_GRACE_MS)
      return () => window.clearTimeout(t)
    }
  }, [isLoaded, isSignedIn, userId, linkedTo, sync, clerk])

  // A function said "please sign in" while Clerk is signed in: the database session ended under
  // this page (closed elsewhere). Refresh it, or open a new one from the Clerk sign-in.
  useEffect(() => {
    if (!isLoaded || !isSignedIn) return
    setSessionRenewer(async () => {
      const refreshed = await supabase.auth.refreshSession().catch(() => null)
      if (refreshed?.data.session && !refreshed.error) {
        const { error } = await supabase.auth.getUser()
        if (!error) return true
      }
      const token = await getToken()
      if (!token) return false
      await exchangeClerkSession(token)
      return true
    })
    return () => setSessionRenewer(null)
  }, [isLoaded, isSignedIn, getToken])

  // Opened (here or by another tab): an error from an earlier try no longer applies.
  useEffect(() => {
    if (userId && linkedTo === userId) setError((e) => (e ? null : e))
  }, [userId, linkedTo])

  const ready = (isLoaded && (!isSignedIn || linkedTo === userId || error !== null)) || (!isLoaded && gaveUp)
  const signedIn = Boolean(isLoaded && isSignedIn)
  const shownError = error ?? (!isLoaded && gaveUp ? new Error('Could not reach the sign-in service. Check your connection and reload the page.') : null)
  // A failed link is not retried by itself: pages show the error with "Try again" instead.
  const retry = useCallback(() => {
    autoSyncs.current = []
    setError(null)
    sync().catch((e: Error) => { setError(e); reportError(e, { where: 'clerk-session-sync' }) })
  }, [sync])
  const signOut = useCallback(async () => {
    await clerk.signOut().catch((e) => reportError(e, { where: 'clerk-sign-out' }))
    await endSupabaseSession()
    setError(null)
  }, [clerk])
  useEffect(() => { onChange({ ready, signedIn, error: shownError, sync, retry, signOut }) }, [ready, signedIn, shownError?.message, sync, retry, signOut, onChange])
  return null
}

/** Clerk's error in words a person can act on. */
/**
 * A request that never reached the sign-in service (offline, a dropped connection, an ad
 * blocker or VPN in the way). ClerkJS words these "ClerkJS: Network error at … Failed to fetch".
 */
export function clerkNetworkError(error: unknown): boolean {
  if (isClerkRuntimeError(error) && error.code === 'network_error') return true
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /network error|failed to fetch|networkerror|load failed|network connection was lost|err_internet_disconnected/i.test(message)
}

export const CLERK_NETWORK_MESSAGE = 'We could not reach the sign-in service. Check your internet connection, turn off any ad blocker or VPN for this site, and try again.'

export function clerkErrorMessage(error: unknown): string {
  if (isClerkAPIResponseError(error)) {
    const first = error.errors[0]
    switch (first?.code) {
      case 'form_password_incorrect':
      case 'form_identifier_not_found': return 'Email or password is incorrect'
      case 'form_code_incorrect': return 'That code is not right. Check the latest e-mail and try again.'
      case 'verification_expired': return 'That code has expired. Send a new one.'
      case 'verification_failed': return 'Too many wrong codes. Send a new one.'
      case 'form_identifier_exists': return 'This e-mail already has an account. Sign in instead.'
      case 'form_password_pwned': return 'This password has appeared in a data leak elsewhere. Choose a different one.'
      case 'form_password_length_too_short': return 'The password is too short.'
      case 'form_password_not_strong_enough':
      case 'form_password_validation_failed': return 'Choose a stronger password: longer, with letters and numbers.'
      case 'form_param_format_invalid': return first.meta?.paramName === 'email_address' ? 'Enter a valid e-mail address.' : (first.longMessage ?? first.message)
      case 'captcha_invalid':
      case 'captcha_missing_token':
      case 'captcha_not_enabled': return 'The security check did not finish. Reload the page and try again.'
      case 'session_exists': return 'You are already signed in. Reload the page.'
      case 'too_many_requests': return 'Too many tries. Wait a minute, then try again.'
      default: return first?.longMessage ?? first?.message ?? 'Something went wrong. Please try again.'
    }
  }
  if (clerkNetworkError(error)) return CLERK_NETWORK_MESSAGE
  const message = error instanceof Error ? error.message : ''
  // ClerkJS's own wording is for developers, not for the person signing up.
  return !message || /^clerk/i.test(message) ? 'Something went wrong. Please try again.' : message
}

/** The Clerk error code, when there is one. */
export const clerkErrorCode = (error: unknown): string | null =>
  isClerkAPIResponseError(error) ? (error.errors[0]?.code ?? null) : null
