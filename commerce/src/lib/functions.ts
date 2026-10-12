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

/**
 * Calls a backend function (on Supabase, or on the site's own Cloudflare
 * Worker) and surfaces its `{ error: { code, message } }` body.
 */
export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  let res: Response
  try {
    res = await merchantFetch(functionsUrl(name), {
      method: 'POST',
      headers: { ...(await functionHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    throw new AppError('Network problem — please try again', 'NETWORK')
  }
  return functionResult<T>(res)
}
