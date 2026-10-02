import { env } from './env.ts'

// Failures are never swallowed: each one goes to the admin System log (via the
// service role) and, when SENTRY_DSN is set, to Sentry. Reporting runs in the
// background and can never break the request it describes.

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void } | undefined

export type LogLevel = 'INFO' | 'WARN' | 'ERROR'
export type LogCategory = 'FUNCTION' | 'WEBHOOK' | 'PAYMENT' | 'COURIER' | 'SMS' | 'META' | 'AUTH' | 'FRAUD' | 'JOB' | 'OTHER'

export interface LogEvent {
  level: LogLevel
  category: LogCategory
  source: string
  message: string
  context?: Record<string, unknown>
  error?: unknown
}

const SECRET_KEYS = /(key|secret|token|password|authorization|signature|cookie)/i
const SECRET_IN_TEXT = /((?:api_?key|access_?token|token|secret|password|signature|app_secret|client_secret)=)[^&\s"')]+/gi

/** Masks credentials that appear inside text, e.g. in a URL's query string. */
export function scrubText(text: string): string {
  return text.replace(SECRET_IN_TEXT, '$1[redacted]').replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, '$1[redacted]')
}

/** Removes anything that looks like a credential before it is stored or sent. */
export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 4 || value === null || value === undefined) return value
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.test(k) ? '[redacted]' : scrub(v, depth + 1)]))
  }
  if (typeof value === 'string') return scrubText(value.length > 500 ? `${value.slice(0, 500)}…` : value)
  return value
}

function errorDetails(error: unknown): { message: string; stack?: string; name?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack, name: error.name }
  return { message: typeof error === 'string' ? error : JSON.stringify(error) }
}

interface ParsedDsn { host: string; projectId: string; key: string; protocol: string }

export function parseDsn(dsn: string | undefined): ParsedDsn | null {
  if (!dsn) return null
  try {
    const url = new URL(dsn)
    const projectId = url.pathname.replace(/^\/+/, '').split('/').pop()
    if (!url.username || !projectId) return null
    return { host: url.host, projectId, key: url.username, protocol: url.protocol }
  } catch {
    return null
  }
}

/** Sentry envelope for one error event (the HTTP protocol the SDKs use). */
export function sentryEnvelope(event: LogEvent, now = new Date()): string {
  const eventId = crypto.randomUUID().replace(/-/g, '')
  const err = event.error ? errorDetails(event.error) : null
  const payload = {
    event_id: eventId,
    timestamp: now.toISOString(),
    platform: 'javascript',
    level: event.level === 'WARN' ? 'warning' : event.level.toLowerCase(),
    logger: event.source,
    environment: env('SENTRY_ENVIRONMENT') ?? 'production',
    release: env('SENTRY_RELEASE'),
    server_name: 'supabase-edge',
    tags: { category: event.category, function: event.source },
    message: { formatted: scrubText(event.message) },
    exception: err ? { values: [{ type: err.name ?? 'Error', value: scrubText(err.message) }] } : undefined,
    extra: scrub({ ...(event.context ?? {}), stack: err?.stack }),
  }
  return [
    JSON.stringify({ event_id: eventId, sent_at: now.toISOString() }),
    JSON.stringify({ type: 'event' }),
    JSON.stringify(payload),
  ].join('\n')
}

async function sendToSentry(event: LogEvent, fetchFn: typeof fetch): Promise<void> {
  const dsn = parseDsn(env('SENTRY_DSN'))
  if (!dsn || event.level === 'INFO') return
  const auth = `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=commerce-edge/1.0`
  await fetchFn(`${dsn.protocol}//${dsn.host}/api/${dsn.projectId}/envelope/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-sentry-envelope', 'X-Sentry-Auth': auth },
    body: sentryEnvelope(event),
  })
}

async function writeSystemLog(event: LogEvent, fetchFn: typeof fetch): Promise<void> {
  const url = env('SUPABASE_URL')
  const key = env('SUPABASE_SERVICE_ROLE_KEY') ?? env('SUPABASE_SECRET_KEY')
  if (!url || !key) return
  const err = event.error ? errorDetails(event.error) : null
  await fetchFn(`${url}/rest/v1/rpc/log_system_event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: key, Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      p_level: event.level,
      p_category: event.category,
      p_source: event.source,
      p_message: scrubText(event.message).slice(0, 2000),
      p_context: scrub({ ...(event.context ?? {}), ...(err ? { error: err.message, stack: err.stack?.split('\n').slice(0, 6).join('\n') } : {}) }),
    }),
  })
}

/** Records an event without blocking the caller; failures to report are printed, never thrown. */
export function logEvent(event: LogEvent, fetchFn: typeof fetch = fetch): Promise<void> {
  const line = `[${event.level}] ${event.category}/${event.source}: ${scrubText(event.message)}`
  const detail = event.error ? scrubText(errorDetails(event.error).stack ?? errorDetails(event.error).message) : ''
  if (event.level === 'ERROR') console.error(line, detail)
  else console.warn(line)
  const task = Promise.allSettled([writeSystemLog(event, fetchFn), sendToSentry(event, fetchFn)])
    .then((results) => {
      for (const r of results) if (r.status === 'rejected') console.error('Could not report event', r.reason)
    })
  if (typeof EdgeRuntime !== 'undefined') EdgeRuntime.waitUntil(task)
  return task
}

/** Name of the edge function serving this request (for log sources). */
export function functionName(req: Request): string {
  try {
    const parts = new URL(req.url).pathname.split('/').filter(Boolean)
    const i = parts.indexOf('v1')
    return (i >= 0 ? parts[i + 1] : parts[0]) ?? 'function'
  } catch {
    return 'function'
  }
}
