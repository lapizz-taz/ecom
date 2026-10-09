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

// --- Shopify sync (fulfilment + stock) ---------------------------------------------------
export type SyncStatus = 'NEW' | 'OK' | 'PENDING' | 'MISMATCH' | 'FAILED' | 'UNTRACKED'
export interface SyncItem {
  variant_id: string; external_variant_id: string; inventory_item_id: string | null; sku: string | null; product: string; variant: string
  shopify_title: string | null; on_hand: number; reserved: number; available: number; shopify: number | null; last_pushed: number | null
  status: SyncStatus; error: string | null; synced_at: string | null; track_inventory: boolean; difference: number | null
}
export interface SyncOverview {
  channel: { id: string; name: string; status: string; locations: Array<{ id: string; name: string; active: boolean }>; catalog_imported_at: string | null
    scopes: string[]; settings: { inventory_sync: boolean; location_id: string | null; external_changes: 'FLAG' | 'SAAS_WINS'; fulfill_on_ship: boolean; notify_customer: boolean; fulfill_without_tracking: boolean } }
  items: SyncItem[]
  unmapped: Array<{ external_variant_id: string; sku: string | null; title: string; status: string | null; available: number | null
    reason: 'NO_SKU' | 'DUPLICATE_SKU_SHOPIFY' | 'DUPLICATE_SKU_HERE' | 'NO_MATCH' }>
  jobs: { pending: number; failed: number }
  recent_jobs: Array<{ id: string; kind: 'FULFILL' | 'INVENTORY'; status: string; attempts: number; last_error: string | null; updated_at: string; ref_id: string; label: string | null }>
  fulfillments: Array<{ order_id: string; order_number: string; status: string; source: string; courier: string | null; tracking_number: string | null
    tracking_url: string | null; notification_status: string | null; last_error: string | null; created_at: string; fulfilled_at: string | null }>
}

export async function syncOverview(channelId: string): Promise<SyncOverview> {
  const { data, error } = await supabase.rpc('channel_inventory_overview', { p_channel_id: channelId })
  if (error) throw error
  return fromJson(data)
}
export async function saveSyncSettings(channelId: string, p: Partial<SyncOverview['channel']['settings']>) {
  const { error } = await supabase.rpc('channel_sync_settings_save', { p_channel_id: channelId, p: asJson(p) })
  if (error) throw error
}
export async function linkVariant(channelId: string, externalVariantId: string, variantId: string | null) {
  const { error } = await supabase.rpc('channel_variant_link', { p_channel_id: channelId, p_external_variant_id: externalVariantId, p_variant_id: variantId as unknown as string })
  if (error) throw error
}
export interface ReconcilePlan { applied: boolean; plan: Array<{ variant_id: string; sku: string | null; action: 'PUSH' | 'ADOPT'; from: number | null; to: number; on_hand_change?: number }> }
export async function reconcileStock(channelId: string, items: Array<{ variant_id: string; action: 'PUSH' | 'ADOPT' }>, apply: boolean): Promise<ReconcilePlan> {
  const { data, error } = await supabase.rpc('channel_inventory_reconcile', { p_channel_id: channelId, p_items: asJson(items), p_apply: apply })
  if (error) throw error
  return fromJson(data)
}
export async function retrySyncJob(jobId: string) {
  const { error } = await supabase.rpc('channel_job_retry', { p_job_id: jobId })
  if (error) throw error
}
export const importCatalog = (id: string) => call<{ items: number; linked: number; mapped: number }>({ action: 'import_catalog', channel_id: id })
/** Runs due sync jobs now (they also run every minute on their own). */
export const runSyncJobs = () => call<{ processed: number; results: Array<{ kind: string; outcome: string; error?: string }> }>({ action: 'process_jobs' })

export interface OrderChannelInfo {
  channel: { id: string; name: string; platform: ChannelPlatform; shop_domain: string; fulfill_on_ship: boolean; notify_customer: boolean }
  external_order_id: string; external_order_number: string | null
  fulfillments: Array<{ id: string; source: 'APP' | 'SHOPIFY'; status: string; fulfillment_id: string | null; courier: string | null; tracking_number: string | null
    tracking_url: string | null; shopify_status: string | null; notification_status: 'REQUESTED' | 'NO_EMAIL' | 'DISABLED' | null; notification_note: string | null
    attempts: number; last_error: string | null; fulfilled_at: string | null; synced_at: string | null; created_at: string }>
  job: { status: string; attempts: number; next_attempt_at: string; last_error: string | null } | null
}
export async function orderChannelInfo(orderId: string): Promise<OrderChannelInfo | null> {
  const { data, error } = await supabase.rpc('order_channel_info', { p_order_id: orderId })
  if (error) throw error
  return (data ?? null) as unknown as OrderChannelInfo | null
}
export async function retryChannelFulfillment(orderId: string) {
  const { error } = await supabase.rpc('channel_fulfillment_retry', { p_order_id: orderId })
  if (error) throw error
  await runSyncJobs().catch(() => undefined)
}
