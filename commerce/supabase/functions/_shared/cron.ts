import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from './env.ts'

/**
 * A scheduled (pg_cron) call: its x-cron-secret matches the CRON_SECRET function
 * secret or the 'cron_secret' kept in Vault, or it carries the service role key.
 */
export async function isCronRequest(req: Request, admin: SupabaseClient): Promise<boolean> {
  const given = req.headers.get('x-cron-secret')
  const configured = env('CRON_SECRET')
  if (given && configured && given === configured) return true
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY')
  if (serviceKey && req.headers.get('authorization') === `Bearer ${serviceKey}`) return true
  if (!given) return false
  const { data, error } = await admin.rpc('cron_secret_matches', { p_secret: given })
  if (error) throw new Error(`Could not check the cron secret: ${error.message}`)
  return data === true
}
