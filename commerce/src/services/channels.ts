import { invokeFunction } from '@/lib/functions'
import type { StoreMode } from '@/types/domain'
import { asJson, fromJson } from '@/lib/json'
import { supabase } from '@/lib/supabase'

export type ChannelPlatform = 'SHOPIFY' | 'WOOCOMMERCE'
export type ChannelStatus = 'PENDING' | 'CONNECTED' | 'ERROR' | 'DISCONNECTED'
export interface ChannelCheck { key: string; label: string; status: 'ok' | 'warn' | 'fail'; detail: string }

export interface SalesChannel {
  id: string; platform: ChannelPlatform; name: string; shop_domain: string; status: ChannelStatus
  auth_mode: 'OAUTH' | 'TOKEN' | 'KEYS' | null; scopes: string[]; currency: string | null
  settings: { import_orders?: boolean }; webhooks: Array<{ id: string | number; topic: string }>
  last_test: { checks: ChannelCheck[]; at: string } | null; last_tested_at: string | null; last_sync_at: string | null
  last_order_at: string | null; last_error: string | null; orders_imported: number; failed: number; today: number
  connected_at: string | null; created_at: string
}

export interface ChannelImport {
  id: string; channel_id: string; channel: string; platform: ChannelPlatform; external_id: string; external_number: string | null
  status: 'IMPORTED' | 'FAILED' | 'SKIPPED'; error: string | null; warnings: string[]; attempts: number; received_via: string
  order_id: string | null; order_number: string | null
  customer: { name: string | null; phone: string | null }
  shipping: { address: string | null; city: string | null; state: string | null; district: string | null }
  total: string | null; currency: string | null; items: number; created_at: string; updated_at: string
}

export interface SetupResult { channel: SalesChannel; checks: ChannelCheck[]; ok: boolean }

export async function listChannels(): Promise<SalesChannel[]> {
  const { data, error } = await supabase.rpc('sales_channels_list')
  if (error) throw error
  return fromJson<SalesChannel[]>(data)
}

export async function listChannelImports(p: { channel_id?: string; status?: string; limit?: number; offset?: number }) {
  const { data, error } = await supabase.rpc('channel_imports_list', { p: asJson(p) })
  if (error) throw error
  return fromJson<{ total: number; items: ChannelImport[] }>(data)
}

export async function saveChannelSettings(id: string, p: { name?: string; import_orders?: boolean }) {
  const { error } = await supabase.rpc('sales_channel_settings_save', { p_id: id, p: asJson(p) })
  if (error) throw error
}

const call = <T>(body: Record<string, unknown>) => invokeFunction<T>('channels', body)

export const shopifyConnect = (input: { shop: string; client_id: string; client_secret?: string; return_to: string }) =>
  call<{ url: string; redirect_uri: string; channel_id: string }>({ action: 'shopify_connect', ...input })
export const shopifyToken = (input: { shop: string; access_token: string; api_secret: string }) =>
  call<SetupResult>({ action: 'shopify_token', ...input })
export const wooConnect = (input: { url: string; return_to: string }) =>
  call<{ url: string; channel_id: string }>({ action: 'woo_connect', ...input })
export const wooKeys = (input: { url: string; consumer_key: string; consumer_secret: string }) =>
  call<SetupResult>({ action: 'woo_keys', ...input })
export const testChannel = (id: string) => call<SetupResult>({ action: 'test', channel_id: id })
export const fixWebhooks = (id: string) => call<SetupResult>({ action: 'webhooks', channel_id: id })
export const disconnectChannel = (id: string) => call<{ ok: boolean }>({ action: 'disconnect', channel_id: id })
export const syncChannel = (id: string, days = 7) =>
  call<{ ok: boolean; channels: Array<{ found: number; imported: number; duplicate: number; failed: number; skipped: number }> }>({ action: 'sync', channel_id: id, days })
export const retryImport = (importId: string, overrides: { phone?: string; name?: string; address?: string; district?: string }) =>
  call<{ status: string; order_id?: string; order_number?: string; error?: string }>({ action: 'retry_import', import_id: importId, overrides })

/** Where Shopify sends staff back after approving the app (goes in the app's allowed redirect URLs). */
export const shopifyRedirectUri = () => `${import.meta.env.VITE_SUPABASE_URL?.replace(/\/+$/, '')}/functions/v1/channels/callback/shopify`

export async function setStoreMode(mode: StoreMode, redirectUrl: string | null): Promise<{ mode: StoreMode; redirect_url: string | null }> {
  const { data, error } = await supabase.rpc('admin_set_store_mode', { p_mode: mode, p_redirect_url: redirectUrl ?? undefined })
  if (error) throw error
  return fromJson(data)
}
