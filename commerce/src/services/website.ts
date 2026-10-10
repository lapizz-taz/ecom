import { env } from '@/lib/env'
import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'

// --- custom domains ---------------------------------------------------------------------
export interface DnsRecord { type: 'A' | 'CNAME' | 'TXT'; name: string; value: string; why: string }
export interface StoreDomain {
  id: string; domain: string; status: 'PENDING' | 'VERIFYING' | 'ACTIVE' | 'ERROR' | 'MANUAL' | 'REMOVED'
  records: DnsRecord[]; detail: string | null; created_at: string; checked_at: string | null
}
export const listDomains = () => invokeFunction<{ domains: StoreDomain[]; automatic: boolean }>('domains', { action: 'list' })
export const addDomain = (domain: string) => invokeFunction<{ domain: StoreDomain; automatic: boolean }>('domains', { action: 'add', domain })
export const checkDomain = (domain: string) => invokeFunction<{ domain: StoreDomain; automatic: boolean }>('domains', { action: 'check', domain })
export const removeDomain = (domain: string) => invokeFunction<{ ok: boolean }>('domains', { action: 'remove', domain })

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
export const siteApiBase = () => `${env.supabaseUrl.replace(/\/+$/, '')}/functions/v1/site-api/v1`
