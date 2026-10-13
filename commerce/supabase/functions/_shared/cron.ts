import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from './env.ts'

/**
 * A scheduled (pg_cron) call: its x-cron-secret matches the CRON_SECRET function
 * secret or the 'cron_secret' kept in Vault, or it carries the service role key.
 */
export async function isCronRequest(req: Request, admin: SupabaseClient): Promise<boolean> {
  const given = req.headers.get('x-cron-secret')
  const configured = env('CRON_SECRET')
  if (given && configured && sameSecret(given, configured)) return true
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
  if (serviceKey && sameSecret(req.headers.get('authorization') ?? '', `Bearer ${serviceKey}`)) return true
  if (!given) return false
  const { data, error } = await admin.rpc('cron_secret_matches', { p_secret: given })
  if (error) throw new Error(`Could not check the cron secret: ${error.message}`)
  return data === true
}

const acceptedKeys = new Map<string, number>()

/**
 * The request's bearer key is one Supabase itself accepts as the service role
 * (the older JWT key or a newer sb_secret_ key). Supabase is asked rather than
 * a copy compared, so a caller holding the key in another format (or after a
 * rotation) still gets in. cron_secret_matches runs for service_role only, so
 * any other key is refused there. A key that passed is remembered for 10 minutes.
 */
export async function carriesServiceKey(req: Request, fetchFn: typeof fetch = fetch): Promise<boolean> {
  const key = /^Bearer\s+(\S{20,2048})$/i.exec(req.headers.get('authorization') ?? '')?.[1]
  const url = env('SUPABASE_URL')
  if (!key || !url) return false
  const id = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))), (b) => b.toString(16).padStart(2, '0')).join('')
  if ((acceptedKeys.get(id) ?? 0) > Date.now()) return true
  const res = await fetchFn(`${url.replace(/\/$/, '')}/rest/v1/rpc/cron_secret_matches`, {
    method: 'POST',
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: '{"p_secret":""}',
  }).catch(() => null)
  await res?.body?.cancel().catch(() => undefined)
  if (!res?.ok) return false
  acceptedKeys.set(id, Date.now() + 10 * 60_000)
  return true
}

/** Compares two secrets in time that does not depend on where they first differ. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
