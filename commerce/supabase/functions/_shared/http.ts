import { env } from './env.ts'
import { functionName, logEvent } from './monitoring.ts'

export class HttpError extends Error {
  /** The underlying failure, kept for the logs and never sent to the client. */
  internal?: unknown

  constructor(
    public readonly status: number,
    message: string,
    public readonly code = 'ERROR',
    public readonly details?: unknown,
  ) {
    super(message)
  }
}

function allowedOrigin(req: Request): string {
  const configured = (env('ALLOWED_ORIGINS') ?? '*').split(',').map((o) => o.trim()).filter(Boolean)
  const origin = req.headers.get('origin') ?? ''
  if (configured.includes('*')) return '*'
  return configured.includes(origin) ? origin : configured[0] ?? ''
}

export function corsHeaders(req: Request): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': allowedOrigin(req),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-idempotency-key',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    Vary: 'Origin',
  }
}

export function json(req: Request, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), 'Content-Type': 'application/json', ...extra },
  })
}

export async function readJson<T = unknown>(req: Request, maxBytes = 64 * 1024): Promise<T> {
  const text = await req.text()
  if (text.length > maxBytes) throw new HttpError(413, 'Request is too large', 'PAYLOAD_TOO_LARGE')
  if (!text) return {} as T
  try {
    return JSON.parse(text) as T
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON', 'INVALID_JSON')
  }
}

// Database functions raise errors as "CODE: human message". Known codes map
// to HTTP statuses and safe messages; anything else is logged and hidden.
const DB_CODES: Record<string, number> = {
  VALIDATION: 422,
  INSUFFICIENT_STOCK: 409,
  COUPON_INVALID: 422,
  ORDER_BLOCKED: 403,
  PERMISSION_DENIED: 403,
  NOT_FOUND: 404,
  DUPLICATE: 409,
  INVALID_TRANSITION: 409,
  IMMUTABLE_RECORD: 409,
}

export function fromDbError(error: { message?: string; code?: string; details?: string } | null | undefined): HttpError {
  const message = error?.message ?? 'Unknown database error'
  const match = /^([A-Z_]+): (.+)$/s.exec(message)
  if (match && DB_CODES[match[1]]) {
    return new HttpError(DB_CODES[match[1]], match[2], match[1])
  }
  if (error?.code === '42501' || /permission denied/i.test(message)) {
    return new HttpError(403, 'You do not have permission to do that', 'PERMISSION_DENIED')
  }
  const failure = new HttpError(500, 'Something went wrong. Please try again.', 'INTERNAL')
  failure.internal = error
  return failure
}

export function handle(handler: (req: Request) => Promise<Response>): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) })
    try {
      return await handler(req)
    } catch (error) {
      if (error instanceof HttpError) {
        if (error.status >= 500) {
          const cause = error.internal as { message?: string } | undefined
          void logEvent({
            level: 'ERROR', category: 'FUNCTION', source: functionName(req),
            message: cause?.message ?? `${error.code}: ${error.message}`, error: error.internal ?? error,
            context: { status: error.status, code: error.code, method: req.method },
          })
        }
        return json(req, { error: { code: error.code, message: error.message, details: error.details } }, error.status)
      }
      void logEvent({
        level: 'ERROR', category: 'FUNCTION', source: functionName(req),
        message: error instanceof Error ? error.message : 'Unhandled error', error, context: { method: req.method },
      })
      return json(req, { error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } }, 500)
    }
  }
}

export function clientIp(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-real-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  )
}

// Best-effort, per-instance rate limiting for public endpoints. Edge instances
// are short-lived, so this deters bursts; it is not a global quota.
const buckets = new Map<string, { count: number; resetAt: number }>()

export function rateLimit(key: string, limit: number, windowMs = 60_000): void {
  const now = Date.now()
  const bucket = buckets.get(key)
  if (!bucket || bucket.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    return
  }
  bucket.count += 1
  if (bucket.count > limit) {
    throw new HttpError(429, 'Too many requests. Please wait a moment and try again.', 'RATE_LIMITED')
  }
}
