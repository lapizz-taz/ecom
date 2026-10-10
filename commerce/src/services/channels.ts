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

/** Dev Dashboard app installed on the store: client credentials, no redirect. */
export const shopifyClientConnect = (input: { shop: string; client_id: string; client_secret?: string }) =>
  call<SetupResult>({ action: 'shopify_client', ...input })
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

/**
 * Where Shopify sends staff back after approving the app (the app's allowed
 * redirect URL). It is on this admin's own domain because Shopify requires the
 * same host as the App URL; the domain forwards it to the channels function.
 */
export const shopifyRedirectUri = () => `${window.location.origin}/oauth/shopify/callback`
/** The App URL to enter in Shopify's Dev Dashboard. */
export const shopifyAppUrl = () => `${window.location.origin}/admin/channels`
/** The exact scope list for the app version. */
export const SHOPIFY_APP_SCOPES = 'read_orders,write_orders,read_draft_orders,write_draft_orders,read_products,write_products,read_inventory,write_inventory,read_locations,write_locations,read_merchant_managed_fulfillment_orders,write_merchant_managed_fulfillment_orders,read_fulfillments,write_fulfillments,read_returns,write_returns'

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
  channel: { id: string; name: string; status: string; platform: ChannelPlatform; locations: Array<{ id: string; name: string; active: boolean }>; catalog_imported_at: string | null
    first_sync_at: string | null; catalog_items: number
    scopes: string[]; settings: { inventory_sync: boolean; location_id: string | null; external_changes: 'FLAG' | 'SAAS_WINS'; fulfill_on_ship: boolean; notify_customer: boolean
      fulfill_without_tracking: boolean; auto_import_products: boolean; mark_delivered: boolean } }
  items: SyncItem[]
  unmapped: Array<{ external_variant_id: string; sku: string | null; title: string; status: string | null; available: number | null
    reason: 'NO_SKU' | 'DUPLICATE_SKU_SHOPIFY' | 'DUPLICATE_SKU_HERE' | 'NO_MATCH' }>
  jobs: { pending: number; failed: number }
  recent_jobs: Array<{ id: string; kind: 'FULFILL' | 'INVENTORY'; status: string; attempts: number; last_error: string | null; updated_at: string; ref_id: string; label: string | null }>
  fulfillments: Array<{ order_id: string; order_number: string; status: string; source: string; courier: string | null; tracking_number: string | null
    tracking_url: string | null; notification_status: string | null; last_error: string | null; created_at: string; fulfilled_at: string | null
    delivered_status: DeliveredStatus | null; delivered_at: string | null; delivered_error: string | null }>
}
export type DeliveredStatus = 'PENDING' | 'MARKED' | 'FAILED' | 'SKIPPED'

/** First sync plan (apply = false) or result: products to create, SKUs linked, stock taken from the store once. */
export interface FirstSyncPlan {
  applied: boolean; store: string; location_id: string; products: number; create: number; link: number; already_linked: number; untracked: number
  stock_changes: Array<{ variant_id: string; sku: string; title: string; ours: number; store: number; change: number }>
  items: Array<{ product_id: string; external_variant_id: string; action: 'CREATE' | 'LINK'; title: string; sku: string; price: number | null; cost: number | null; stock: number | null }>
}
export async function firstSync(channelId: string, locationId: string, autoImport: boolean, apply: boolean): Promise<FirstSyncPlan> {
  const { data, error } = await supabase.rpc('channel_first_sync', { p_channel_id: channelId, p_location_id: locationId, p_auto_import: autoImport, p_apply: apply })
  if (error) throw error
  return fromJson(data)
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
export const importCatalog = (id: string) => call<{ items: number; linked: number; mapped: number; imported?: number }>({ action: 'import_catalog', channel_id: id })
/** Connect again with the saved app keys (e.g. after the app was reinstalled in Shopify). */
export const reconnectChannel = (id: string) => call<SetupResult>({ action: 'reconnect', channel_id: id })
/** Runs due sync jobs now (they also run every minute on their own). */
export const runSyncJobs = () => call<{ processed: number; results: Array<{ kind: string; outcome: string; error?: string }> }>({ action: 'process_jobs' })

export interface OrderChannelInfo {
  channel: { id: string; name: string; platform: ChannelPlatform; shop_domain: string; fulfill_on_ship: boolean; notify_customer: boolean; mark_delivered?: boolean }
  external_order_id: string; external_order_number: string | null
  fulfillments: Array<{ id: string; source: 'APP' | 'SHOPIFY'; status: string; fulfillment_id: string | null; courier: string | null; tracking_number: string | null
    tracking_url: string | null; shopify_status: string | null; notification_status: 'REQUESTED' | 'NO_EMAIL' | 'DISABLED' | null; notification_note: string | null
    attempts: number; last_error: string | null; fulfilled_at: string | null; synced_at: string | null; created_at: string
    delivered_status?: DeliveredStatus | null; delivered_at?: string | null; delivered_error?: string | null }>
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

// --- importing a store's products into this catalog ----------------------------------------

export interface StoreProduct {
  product_id: string; title: string; status: string | null; image_url: string | null; variants: number; linked: number
  price: number | null; cost: number | null; vendor: string | null; stock: number | null; skus: string[] | null
}
export async function storeProducts(channelId: string, search?: string): Promise<StoreProduct[]> {
  const { data, error } = await supabase.rpc('channel_catalog_products', { p_channel_id: channelId, p_search: (search?.trim() || null) as unknown as string })
  if (error) throw error
  return fromJson(data)
}
export interface AdoptPlan {
  applied: boolean; created: number; linked: number
  plan: Array<{ product_id: string; external_variant_id: string; action: 'CREATE' | 'LINK' | 'ALREADY_LINKED'; title: string; sku: string | null; price?: number | null; stock?: number | null }>
}
/** Preview (apply = false) or import store products here; with stock records the store's quantity as opening stock. */
export async function adoptStoreProducts(channelId: string, productIds: string[], withStock: boolean, apply: boolean): Promise<AdoptPlan> {
  const { data, error } = await supabase.rpc('channel_catalog_adopt', { p_channel_id: channelId, p_product_ids: productIds, p_with_stock: withStock, p_apply: apply })
  if (error) throw error
  return fromJson(data)
}

/** Staff click only: mark the order paid, or cancel it, on Shopify (never automatic). */
export const shopifyOrderAction = (orderId: string, op: 'mark_paid' | 'cancel', note?: string) =>
  call<{ ok: boolean; financial_status?: string; job_id?: string }>({ action: 'order_action', order_id: orderId, op, ...(note ? { note } : {}) })
