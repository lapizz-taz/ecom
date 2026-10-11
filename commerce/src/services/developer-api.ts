import { env } from '@/lib/env'
import { supabase } from '@/lib/supabase'

export const API_SCOPES = [
  { code: 'orders:read', label: 'Read orders', group: 'Orders' },
  { code: 'orders:write', label: 'Change order status', group: 'Orders' },
  { code: 'products:read', label: 'Read products', group: 'Products' },
  { code: 'inventory:read', label: 'Read stock', group: 'Inventory' },
  { code: 'inventory:write', label: 'Change stock', group: 'Inventory' },
  { code: 'customers:read', label: 'Read customers', group: 'Customers' },
] as const
export type ApiScope = (typeof API_SCOPES)[number]['code']

export interface ApiKey {
  id: string; name: string; prefix: string; scopes: ApiScope[]; expires_at: string | null; created_at: string
  last_used_at: string | null; request_count: number; revoked_at: string | null; created_by: string | null
}
export interface ApiLog {
  id: number; key_id: string | null; key_name: string | null; method: string; path: string; status: number
  duration_ms: number | null; error_code: string | null; created_at: string
}

export async function listApiKeys(): Promise<ApiKey[]> {
  const { data, error } = await supabase.rpc('admin_api_keys')
  if (error) throw error
  return data as unknown as ApiKey[]
}
/** The full key is returned only here, once. */
export async function createApiKey(name: string, scopes: ApiScope[], expiresAt: string | null): Promise<{ id: string; key: string; prefix: string }> {
  const { data, error } = await supabase.rpc('admin_api_key_create', { p_name: name, p_scopes: scopes, p_expires_at: expiresAt ?? undefined })
  if (error) throw error
  return data as unknown as { id: string; key: string; prefix: string }
}
export async function revokeApiKey(id: string) {
  const { error } = await supabase.rpc('admin_api_key_revoke', { p_id: id })
  if (error) throw error
}
export async function listApiLogs(limit = 200): Promise<ApiLog[]> {
  const { data, error } = await supabase.rpc('admin_api_logs', { p_limit: limit })
  if (error) throw error
  return data as unknown as ApiLog[]
}
export const externalApiBase = () => `${env.supabaseUrl.replace(/\/+$/, '')}/functions/v1/api/v1`
