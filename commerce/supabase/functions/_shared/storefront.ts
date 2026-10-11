import type { SupabaseClient } from '@supabase/supabase-js'
import { env } from './env.ts'
import { HttpError } from './http.ts'
import { getSettings, merchantOf } from './supabase.ts'

const clean = (url: string) => url.trim().replace(/\/+$/, '')
const isUrl = (v: unknown): v is string => typeof v === 'string' && /^https?:\/\/[^/\s]+/.test(v.trim())

/** True when the backend itself runs locally (supabase start), the only place a localhost link is right. */
export function isLocalBackend(): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|kong|host\.docker\.internal)(:\d+)?/i.test(env('SUPABASE_URL') ?? '')
}

const LOCAL_APP = 'http://localhost:5173'

function missing(what: string): never {
  throw new HttpError(503, `${what} is not set up: add PLATFORM_URL (the live site, e.g. https://app.example.com) to the edge function secrets.`, 'SITE_URL_MISSING')
}

/** The business's store name and whether its online store is on, plus the platform's subdomain root. */
async function storeIdentity(admin: SupabaseClient): Promise<{ slug: string | null; root: string | null }> {
  const id = merchantOf(admin)
  if (!id) return { slug: null, root: null }
  const [{ data: m }, store, { data: domains }] = await Promise.all([
    admin.from('merchants').select('slug').eq('id', id).maybeSingle(),
    getSettings<{ mode?: string }>(admin, 'storefront'),
    admin.from('platform_settings').select('value').eq('key', 'store_domains').maybeSingle(),
  ])
  const on = (store.mode ?? 'OWN') === 'OWN'
  const root = String((domains?.value as { root_domain?: string } | null)?.root_domain ?? '').toLowerCase()
  return {
    slug: on && m?.slug ? String(m.slug) : null,
    root: /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(root) ? root : null,
  }
}

/**
 * The store's public address, for customer links and payment returns: the
 * business's live primary custom domain, else its store subdomain
 * (<name>.<platform domain>), else STOREFRONT_URL, else the Website in
 * Settings → Store, else <PLATFORM_URL>/s/<name>, else PLATFORM_URL.
 * Localhost only when the backend itself is local.
 */
export async function storefrontBase(admin: SupabaseClient): Promise<string> {
  const { data: primary } = await admin.from('store_domains').select('domain').eq('is_primary', true).eq('status', 'ACTIVE').maybeSingle()
  if (primary?.domain) return `https://${primary.domain}`
  const { slug, root } = await storeIdentity(admin).catch(() => ({ slug: null, root: null }))
  if (slug && root) return `https://${slug}.${root}`
  const configured = env('STOREFRONT_URL')
  if (isUrl(configured)) return clean(configured)
  const store = await getSettings<{ website_url?: string }>(admin, 'store')
  if (isUrl(store.website_url)) return clean(store.website_url)
  const platform = env('PLATFORM_URL')
  if (isUrl(platform)) return slug ? `${clean(platform)}/s/${slug}` : clean(platform)
  return isLocalBackend() ? (slug ? `${LOCAL_APP}/s/${slug}` : LOCAL_APP) : missing('The store address')
}

/**
 * Where the admin app lives (staff invites, "open in Fullfilio" links): APP_URL
 * or PLATFORM_URL, else the address the staff member is using right now.
 */
export function appBase(req?: Request): string {
  for (const v of [env('APP_URL'), env('PLATFORM_URL')]) if (isUrl(v)) return clean(v)
  const origin = req?.headers.get('origin')
  if (isUrl(origin) && (origin.startsWith('https://') || isLocalBackend())) return clean(origin)
  const store = env('STOREFRONT_URL')
  if (isUrl(store)) return clean(store)
  return isLocalBackend() ? LOCAL_APP : missing('The app address')
}
