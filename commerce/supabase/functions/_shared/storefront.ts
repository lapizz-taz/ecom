import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from './env.ts'
import { getSettings } from './supabase.ts'

/**
 * The public site's address, for links and payment returns: STOREFRONT_URL when
 * set, otherwise the Website in Settings → Store. Only a local dev setup falls
 * through to localhost.
 */
export async function storefrontBase(admin: SupabaseClient): Promise<string> {
  const configured = env('STOREFRONT_URL')
  if (configured) return configured.replace(/\/+$/, '')
  const store = await getSettings<{ website_url?: string }>(admin, 'store')
  const website = store.website_url?.trim()
  return (website && /^https?:\/\/[^/]+/.test(website) ? website : 'http://localhost:5173').replace(/\/+$/, '')
}
