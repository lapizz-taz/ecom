// Browser configuration. Only public values belong here.
const url = import.meta.env.VITE_SUPABASE_URL as string | undefined
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

export const env = {
  supabaseUrl: url ?? '',
  supabaseAnonKey: anonKey ?? '',
  isConfigured: Boolean(url && anonKey),
}

/**
 * Hosts where "/" shows the Fullfilio product site instead of a store
 * (comma-separated, e.g. "fullfilio.com,www.fullfilio.com"). Empty by default,
 * so every host keeps its storefront; the product site is always at /fullfilio.
 */
export function isMarketingHost(host = typeof window === 'undefined' ? '' : window.location.hostname): boolean {
  const list = String(import.meta.env.VITE_MARKETING_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
  return list.includes(host.toLowerCase())
}
