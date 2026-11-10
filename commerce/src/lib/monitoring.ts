import { crumb, lastFailedCall, trail, watchSteps } from '@/lib/breadcrumbs'
import { AppError } from '@/lib/errors'
import { supabase } from '@/lib/supabase'
import { APP_RELEASE, env } from '@/lib/env'
import type { Json } from '@/types/database'

// Errors are reported, never silently swallowed:
//  - to Sentry when VITE_SENTRY_DSN is set (storefront and admin);
//  - to the Super Admin error tracker when the person is signed-in staff (admin) or Super Admin
//    staff (panel), with the steps they took just before (lib/breadcrumbs.ts), the page and the
//    app version.
// Covered: failed queries and actions (lib/query-client.ts), crashed pages (route-error.tsx),
// errors nobody caught (window), error messages shown with toast.error, and "Something went
// wrong" messages, which are tied to the call that failed just before.
// Expected outcomes (validation, permissions, "not found", rate limits) are not errors and are
// not reported.

const dsn = env.sentry.dsn
const EXPECTED = new Set([
  'VALIDATION', 'PERMISSION_DENIED', 'UNAUTHENTICATED', 'NOT_FOUND', 'RATE_LIMITED', 'COUPON_INVALID',
  'INSUFFICIENT_STOCK', 'DUPLICATE', 'INVALID_TRANSITION', 'NETWORK', 'ORDER_BLOCKED', 'NOT_CONNECTED',
  'FEATURE_OFF', 'LIMIT_REACHED', 'ACCOUNT_RESTRICTED', 'SUPPORT_READ_ONLY', 'SESSION_EXPIRED',
  'CONFLICT', 'CHECK_IN_REQUIRED', 'ON_BREAK', 'REAUTH_REQUIRED', 'INSUFFICIENT_CREDITS', 'DISTRICT_UNKNOWN',
])
/** Browser noise that is not ours to fix: extensions, cross-origin scripts, a known harmless warning. */
const NOISE = /ResizeObserver loop|^Script error\.?$|chrome-extension:\/\/|moz-extension:\/\/|safari-(web-)?extension:\/\//i
/** A new deployment replaced the code files of an open tab: the app reloads itself (route-error.tsx). */
const STALE_APP = /dynamically imported module|Loading chunk|Importing a module script failed|error loading dynamically imported/i

let staff = false
let platform = false
type SentryModule = typeof import('@sentry/react')
let sentry: SentryModule | null = null
const pending: Array<(s: SentryModule) => void> = []
const withSentry = (fn: (s: SentryModule) => void) => { if (sentry) fn(sentry); else if (dsn) pending.push(fn) }

/** Starts the trail of steps and catches errors nobody handled; loads Sentry only when a DSN is configured. */
export async function initMonitoring() {
  if (typeof window !== 'undefined') {
    watchSteps()
    window.addEventListener('error', (e) => {
      const error = e.error ?? e.message
      if (STALE_APP.test(errorText(error))) return
      reportError(error, { where: 'uncaught' })
    })
    window.addEventListener('unhandledrejection', (e) => {
      if (STALE_APP.test(errorText(e.reason))) return
      reportError(e.reason, { where: 'unhandled-promise' })
    })
  }
  if (!dsn) return
  const Sentry = await import('@sentry/react')
  Sentry.init({
    dsn,
    environment: env.sentry.environment,
    release: env.sentry.release,
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

/** Super Admin staff: errors in the panel are reported too (without a business). */
export function setMonitoringPlatform(on: boolean) {
  platform = on
}

function isExpected(error: unknown): boolean {
  if (error instanceof AppError) return EXPECTED.has(error.code)
  const message = (error as { message?: string } | null)?.message ?? ''
  const code = /^([A-Z_]+): /.exec(message)?.[1]
  if (code && EXPECTED.has(code)) return true
  return /permission denied|JWT expired|Failed to fetch|NetworkError|Load failed/i.test(message)
}

/** The text of an error, also for the plain objects Supabase returns ({ message, code, details }). */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  const e = error as { message?: unknown; code?: unknown; details?: unknown } | null
  if (e && typeof e.message === 'string' && e.message) {
    const extra = [e.code, e.details].filter((x) => typeof x === 'string' && x).join(' · ')
    return extra ? `${e.message} (${extra})` : e.message
  }
  try { return JSON.stringify(error) ?? String(error) } catch { return String(error) }
}

// The same error from one tab is sent at most every 30 seconds, and at most 20 errors a minute.
const recent = new Map<string, number>()
let minute = { start: 0, n: 0 }
let lastSentAt = 0

function allowed(message: string, now = Date.now()): boolean {
  if (now - minute.start > 60_000) minute = { start: now, n: 0 }
  if (minute.n >= 20) return false
  const at = recent.get(message)
  if (at && now - at < 30_000) return false
  recent.set(message, now)
  if (recent.size > 200) recent.delete(recent.keys().next().value as string)
  minute.n++
  return true
}

/** What goes with every report: where, which version, what the person did, and on what screen. */
function details(extra: Record<string, unknown>): Record<string, unknown> {
  const path = window.location.pathname
  return {
    ...extra,
    app: path.startsWith('/super-admin') ? 'super-admin' : 'admin',
    release: APP_RELEASE,
    path,
    trail: trail(),
    online: navigator.onLine,
    screen: `${window.innerWidth}x${window.innerHeight}`,
    browser: navigator.userAgent.slice(0, 160),
  }
}

function send(message: string, context: Record<string, unknown>) {
  if (!(staff || platform) || !allowed(message)) return
  lastSentAt = Date.now()
  // Through JSON: drops undefined values and anything that is not plain data.
  const p_context = JSON.parse(JSON.stringify(details(context))) as Json
  void supabase.rpc('log_client_error', { p_message: message.slice(0, 2000), p_context })
    .then(({ error: logError }) => { if (logError && env.isDev) console.warn('Could not write to the error log', logError) })
}

export function reportError(error: unknown, context: Record<string, unknown> = {}) {
  if (!error || isExpected(error)) return
  const text = errorText(error)
  if (NOISE.test(text) || (error instanceof Error && NOISE.test(error.stack ?? ''))) return
  if (env.isDev) console.error(error, context)
  withSentry((Sentry) => Sentry.captureException(error, { extra: context }))
  // A server function's failure names the function, and carries the id its own error log has.
  const message = error instanceof AppError && error.source ? `${error.source}: ${text}` : text
  send(message, {
    ...context,
    ...(error instanceof AppError ? { code: error.code, request_id: error.requestId, function: error.source } : {}),
    stack: error instanceof Error ? error.stack?.split('\n').slice(0, 15).join('\n') : undefined,
  })
  // On the trail of whatever is reported next.
  crumb({ t: 'error', text: text.slice(0, 160) })
}

/**
 * An error message was shown (toast.error). An error object is reported as it is; a generic
 * "Something went wrong" is reported with the call that failed just before it, unless that
 * error was reported a moment ago.
 */
export function noteErrorShown(shown: unknown, text: string) {
  crumb({ t: 'toast', text: text.slice(0, 140) })
  if (typeof shown !== 'string') {
    if (shown && typeof shown === 'object') reportError(shown, { shown: text })
    return
  }
  if (!/^Something went wrong/i.test(text) || Date.now() - lastSentAt < 2000) return
  const failed = lastFailedCall()
  const where = window.location.pathname
  send(failed ? `"${text}" shown after ${failed.name} answered ${failed.status}` : `"${text}" shown on ${where}`,
    { generic: true, request_id: failed?.request_id })
}
