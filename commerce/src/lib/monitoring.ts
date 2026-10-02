import { AppError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'

// Errors are reported, never silently swallowed:
//  - to Sentry when VITE_SENTRY_DSN is set (storefront and admin);
//  - to the admin System log when the person is signed-in staff.
// Expected outcomes (validation, permissions, "not found", rate limits) are
// not errors and are not reported.

const dsn = import.meta.env.VITE_SENTRY_DSN as string | undefined
const EXPECTED = new Set([
  'VALIDATION', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'NOT_FOUND', 'RATE_LIMITED', 'COUPON_INVALID',
  'INSUFFICIENT_STOCK', 'DUPLICATE', 'INVALID_TRANSITION', 'NETWORK', 'ORDER_BLOCKED', 'NOT_CONNECTED',
])

let staff = false
type SentryModule = typeof import('@sentry/react')
let sentry: SentryModule | null = null
const pending: Array<(s: SentryModule) => void> = []
const withSentry = (fn: (s: SentryModule) => void) => { if (sentry) fn(sentry); else if (dsn) pending.push(fn) }

/** Loads Sentry only when a DSN is configured, so the storefront stays light otherwise. */
export async function initMonitoring() {
  if (!dsn) return
  const Sentry = await import('@sentry/react')
  Sentry.init({
    dsn,
    environment: (import.meta.env.VITE_SENTRY_ENVIRONMENT as string | undefined) ?? import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE as string | undefined,
    sendDefaultPii: false,
    tracesSampleRate: 0.1,
    integrations: [Sentry.browserTracingIntegration()],
    ignoreErrors: [/ResizeObserver loop/, /Failed to fetch dynamically imported module/],
  })
  sentry = Sentry
  for (const fn of pending.splice(0)) fn(Sentry)
}

export function setMonitoringUser(user: { id: string; role: string } | null) {
  staff = Boolean(user)
  withSentry((Sentry) => {
    Sentry.setUser(user ? { id: user.id } : null)
    Sentry.setTag('role', user?.role ?? 'customer')
  })
}

function isExpected(error: unknown): boolean {
  if (error instanceof AppError) return EXPECTED.has(error.code)
  const message = (error as { message?: string } | null)?.message ?? ''
  const code = /^([A-Z_]+): /.exec(message)?.[1]
  if (code && EXPECTED.has(code)) return true
  return /permission denied|JWT expired|Failed to fetch|NetworkError|Load failed/i.test(message)
}

export function reportError(error: unknown, context: Record<string, unknown> = {}) {
  if (!error || isExpected(error)) return
  if (import.meta.env.DEV) console.error(error, context)
  withSentry((Sentry) => Sentry.captureException(error, { extra: context }))
  if (staff) {
    const message = error instanceof Error ? error.message : String(error)
    void supabase.rpc('log_client_error', {
      p_message: message.slice(0, 2000),
      p_context: { ...context, path: window.location.pathname, stack: error instanceof Error ? error.stack?.split('\n').slice(0, 5).join('\n') : undefined },
    }).then(({ error: logError }) => { if (logError && import.meta.env.DEV) console.warn('Could not write to the system log', logError) })
  }
}
