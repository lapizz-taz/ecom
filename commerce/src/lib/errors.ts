// Turns Supabase / edge function / network errors into messages a person can
// act on. Database functions raise "CODE: message"; only the message is shown.
// Unknown errors never expose raw SQL details.

const FRIENDLY: Record<string, string> = {
  PGRST116: 'Not found',
  '23505': 'That already exists',
  '23503': 'This record is in use and cannot be removed',
  '42501': 'You do not have permission to do that',
}

export class AppError extends Error {
  constructor(message: string, public readonly code = 'ERROR', public readonly details?: unknown) {
    super(message)
  }
}

interface ErrorLike {
  message?: string
  code?: string
  details?: string
  hint?: string
  context?: unknown
}

export function toUserMessage(error: unknown): string {
  if (!error) return 'Something went wrong'
  if (error instanceof AppError) return error.message
  const e = error as ErrorLike
  const message = e.message ?? String(error)
  const coded = /^([A-Z_]+): (.+)$/s.exec(message)
  if (coded) return coded[2]
  if (e.code && FRIENDLY[e.code]) return FRIENDLY[e.code]
  if (/permission denied/i.test(message)) return FRIENDLY['42501']
  if (/Failed to fetch|NetworkError|Load failed/i.test(message)) return 'Network problem — check your connection and try again'
  if (/JWT expired|invalid jwt/i.test(message)) return 'Your session expired. Please sign in again.'
  if (/duplicate key/i.test(message)) return FRIENDLY['23505']
  if (/violates foreign key/i.test(message)) return FRIENDLY['23503']
  if (import.meta.env.DEV) return message
  return 'Something went wrong. Please try again.'
}

export function errorCode(error: unknown): string | undefined {
  if (error instanceof AppError) return error.code
  const message = (error as ErrorLike)?.message ?? ''
  return /^([A-Z_]+): /.exec(message)?.[1] ?? (error as ErrorLike)?.code
}

/** Unwraps `{ data, error }` from supabase-js, throwing on error. */
export function unwrap<T>(result: { data: T; error: unknown }): T {
  if (result.error) throw result.error
  return result.data
}
