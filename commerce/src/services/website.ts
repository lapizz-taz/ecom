import { functionsUrl } from '@/lib/env'
import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'

// --- custom domains ---------------------------------------------------------------------
export interface DnsRecord { type: 'A' | 'AAAA' | 'CNAME' | 'TXT'; name: string; value: string; why: string }
/** One region's view of the domain (Google DNS asked with a client address from that region). */
export interface RegionCheck { code: string; name: string; ok: boolean; answers: string[] }
/** What the last check found (see supabase/functions/_shared/domain-check.ts). */
export interface DomainDiagnosis {
  checked_at: string
  kind: 'apex' | 'subdomain'
  pointed: boolean
  live_everywhere: boolean
  records: Array<{ type: string; name: string; value: string; ok: boolean; note?: string }>
  regions: RegionCheck[]
  resolvers: Array<{ name: string; ok: boolean; answers: string[] }>
  tls: { ok: boolean; detail: string; served_by_store: boolean | null; status: number | null }
  issues: Array<{ code: string; severity: 'error' | 'warning' | 'info'; title: string; detail: string }>
  /**
   * Who answers DNS for the domain (its nameservers at the registry); mixed = two companies at once;
   * moving_from = the nameservers DNS servers still remember right after a switch.
   */
  dns_host?: { provider: string | null; nameservers: string[]; mixed: boolean; moving_from?: { provider: string | null; nameservers: string[] } }
  hosting?: { status: string; ssl_status: string | null; error: string | null }
}
export interface StoreDomain {
  id: string; domain: string; status: 'PENDING' | 'VERIFYING' | 'ACTIVE' | 'ERROR' | 'MANUAL' | 'REMOVED'
  records: DnsRecord[]; detail: string | null; created_at: string; checked_at: string | null
  is_primary: boolean; diagnostics: DomainDiagnosis | null
  /** Set once the ownership TXT record was found (domains live before codes existed count as proven). */
  verified_at?: string | null
  /** When the status last changed: the re-check runs every 10 minutes for 3 days after it. */
  status_changed_at?: string | null
}
/** root_ip: set when main domains connect with an A record to Fullfilio's own server (any DNS company). */
export const listDomains = () => invokeFunction<{ domains: StoreDomain[]; automatic: boolean; hosting?: 'cloudflare' | 'vercel' | 'manual'; root_ip?: string | null }>('domains', { action: 'list' })
export const addDomain = (domain: string) => invokeFunction<{ domain: StoreDomain; automatic: boolean }>('domains', { action: 'add', domain })
export const checkDomain = (domain: string) => invokeFunction<{ domain: StoreDomain; automatic: boolean }>('domains', { action: 'check', domain })
export const removeDomain = (domain: string) => invokeFunction<{ ok: boolean }>('domains', { action: 'remove', domain })
export const makePrimaryDomain = (domain: string) => invokeFunction<{ domain: StoreDomain }>('domains', { action: 'primary', domain })

// --- website API keys -------------------------------------------------------------------
export interface SiteKey {
  id: string; name: string; kind: 'PUBLISHABLE' | 'SECRET'; prefix: string; allowed_origins: string[]
  created_at: string; last_used_at: string | null; request_count: number; revoked_at: string | null; orders: number
}
export async function listSiteKeys(): Promise<SiteKey[]> {
  const { data, error } = await supabase.rpc('admin_site_keys')
  if (error) throw error
  return data as unknown as SiteKey[]
}
/** The full key is returned only here, once. */
export async function createSiteKey(name: string, kind: SiteKey['kind'], origins: string[]): Promise<{ id: string; key: string; prefix: string }> {
  const { data, error } = await supabase.rpc('admin_site_key_create', { p_name: name, p_kind: kind, p_origins: origins })
  if (error) throw error
  return data as unknown as { id: string; key: string; prefix: string }
}
export async function revokeSiteKey(id: string) {
  const { error } = await supabase.rpc('admin_site_key_revoke', { p_id: id })
  if (error) throw error
}
export const siteApiBase = () => functionsUrl('site-api/v1')

/** Where the business's online store is published (see merchant_store_address). */
export interface StoreAddress {
  mode: 'OWN' | 'SHOPIFY' | 'WOOCOMMERCE' | 'OFF'
  slug: string | null
  root_domain: string | null
  subdomain: string | null
  custom_domain: string | null
  /** The owner answered "Do you want a Fullfilio online store?" (or already sells somewhere). */
  asked: boolean
}

export async function getStoreAddress(): Promise<StoreAddress> {
  const { data, error } = await supabase.rpc('merchant_store_address')
  if (error) throw error
  return data as unknown as StoreAddress
}

export async function setStoreSlug(slug: string): Promise<StoreAddress> {
  const { data, error } = await supabase.rpc('admin_set_store_slug', { p_slug: slug })
  if (error) throw error
  return data as unknown as StoreAddress
}

/** The dashboard question: open the online store under `slug`, or not. */
export async function answerOnlineStore(open: boolean, slug?: string): Promise<StoreAddress> {
  const { data, error } = await supabase.rpc('admin_online_store_answer', { p_open: open, p_slug: slug })
  if (error) throw error
  return data as unknown as StoreAddress
}

/** The store's public address: its domain, its subdomain, or /s/<name> on this site. Null when the store is off. */
export function storePublicUrl(a: StoreAddress | undefined | null, origin = window.location.origin): string | null {
  if (!a || a.mode !== 'OWN' || !a.slug) return null
  if (a.custom_domain) return `https://${a.custom_domain}`
  if (a.subdomain) return `https://${a.subdomain}`
  return `${origin}/s/${a.slug}`
}

/** Where the store stands, for a badge: online, off, or selling through another platform. */
export function storeState(a: StoreAddress | undefined | null): { label: string; online: boolean } | null {
  if (!a) return null
  if (a.mode === 'OWN') return { label: 'Online', online: true }
  if (a.mode === 'SHOPIFY') return { label: 'Selling on Shopify', online: false }
  if (a.mode === 'WOOCOMMERCE') return { label: 'Selling on WooCommerce', online: false }
  return { label: 'Off', online: false }
}
