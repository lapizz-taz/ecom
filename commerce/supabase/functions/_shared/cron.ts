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

/** Compares two secrets in time that does not depend on where they first differ. */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a)
  const y = new TextEncoder().encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}
