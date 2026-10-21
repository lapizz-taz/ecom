import { AppError } from '@/lib/errors'
import { env, functionsUrl } from '@/lib/env'
import { merchantFetch } from '@/lib/merchant'
import { supabase } from '@/lib/supabase'

/** The headers Supabase's gateway and our functions expect: the signed-in session (or the anon key) and the key. */
export async function functionHeaders(): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession()
  return { apikey: env.supabaseAnonKey, Authorization: `Bearer ${data.session?.access_token ?? env.supabaseAnonKey}` }
}

type ErrorBody = { error?: { code?: string; message?: string; details?: unknown } } | null

/** A function's answer: JSON (or text) when it worked, its `{ error: { code, message } }` as an AppError when not. */
export async function functionResult<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const payload = (await res.json().catch(() => null)) as ErrorBody
    throw new AppError(payload?.error?.message ?? 'Request failed', payload?.error?.code ?? 'ERROR', payload?.error?.details)
  }
  const type = res.headers.get('Content-Type') ?? ''
  return (type.includes('application/json') ? await res.json() : await res.text()) as T
}

// Renews the sign-in when a function says it has ended (e.g. it was closed in another tab while this
// page kept its old pass): set by the Clerk session sync; true when there is a fresh session to retry with.
let renewSession: (() => Promise<boolean>) | null = null
let renewing: Promise<boolean> | null = null
export function setSessionRenewer(fn: (() => Promise<boolean>) | null) { renewSession = fn }

/** One renewal at a time, shared by every call that hit the same ended session. */
function renew(): Promise<boolean> {
  if (!renewSession) return Promise.resolve(false)
  renewing ??= renewSession().catch(() => false).finally(() => { renewing = null })
  return renewing
}

/**
 * Calls a backend function (on Supabase, or on the site's own Cloudflare
 * Worker) and surfaces its `{ error: { code, message } }` body. A "please sign
 * in" answer while signed in renews the session once and tries again.
 */
export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const send = async () => merchantFetch(functionsUrl(name), {
    method: 'POST',
    headers: { ...(await functionHeaders()), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  let res: Response
  try {
    res = await send()
    if (res.status === 401 && (await renew())) res = await send()
  } catch {
    throw new AppError('Network problem — please try again', 'NETWORK')
  }
  return functionResult<T>(res)
}
