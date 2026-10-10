import { invokeFunction } from '@/lib/functions'
import { supabase } from '@/lib/supabase'

async function rpc<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name as never, args as never)
  if (error) throw error
  return data as T
}

// ------------------------------------------------------------ our store

export interface CartLine { variant_id: string; product_id: string; name: string; variant: string | null; sku: string | null; quantity: number; unit_price: number; image: string | null }
export interface StoreCart {
  id: string; visitor_id: string; status: 'ACTIVE' | 'CONVERTED' | 'EMPTIED' | 'DISMISSED'; reached_checkout: boolean; recovered: boolean
  items: CartLine[]; item_count: number; subtotal: number; customer_id: string | null; phone: string | null; customer_name: string | null
  lead_id: string | null; order_id: string | null; source: string | null; contacted: boolean; contact_count: number; last_contacted_at: string | null
  notes: string | null; created_at: string; last_activity_at: string; converted_at: string | null; is_abandoned: boolean
}
export interface StoreCartsPage {
  total: number; items: StoreCart[]; abandoned_after_minutes: number
  stats: { abandoned: number; abandoned_value: number; abandoned_with_phone: number; active: number; recovered: number; recovered_value: number; converted_30d: number; carts_30d: number }
  top_products: Array<{ product_id: string; name: string; image: string | null; carts: number; quantity: number; value: number }>
}
export type StoreCartView = 'abandoned' | 'active' | 'recovered' | 'converted' | 'dismissed' | 'all'

export const storeCarts = (view: StoreCartView, search: string, page: number, pageSize: number) =>
  rpc<StoreCartsPage>('admin_store_carts', { p_view: view, p_search: search || undefined, p_limit: pageSize, p_offset: page * pageSize })
export const updateStoreCart = (id: string, status: 'CONTACTED' | 'DISMISSED' | 'OPEN', note?: string) =>
  rpc('admin_update_store_cart', { p_id: id, p_status: status, p_note: note || undefined })
export const getStoreCart = (id: string) => rpc<StoreCart | null>('admin_get_store_cart', { p_id: id })
export const linkStoreCart = (cartId: string, orderId: string) => rpc('admin_link_store_cart', { p_cart_id: cartId, p_order_id: orderId })

/** The link that puts the cart back for the customer (our storefront's /cart page). */
export const cartRecoveryLink = (id: string, storeUrl?: string | null) =>
  `${(storeUrl || window.location.origin).replace(/\/+$/, '')}/cart?restore=${id}`

// ------------------------------------------------------------ Shopify

export interface ShopifyAbandoned {
  id: string; channel_id: string; external_id: string; legacy_id: string | null; name: string | null; recovery_url: string | null
  customer_name: string | null; email: string | null; phone: string | null; address: string | null; city: string | null; province: string | null; country: string | null
  items: Array<{ title: string; variant: string | null; sku: string | null; quantity: number; price: number | null; image: string | null }>
  item_count: number; subtotal: number | null; total: number; currency: string | null
  shop_created_at: string | null; completed_at: string | null; status: 'OPEN' | 'RECOVERED'; follow_up: 'NONE' | 'CONTACTED' | 'DISMISSED'
  contact_count: number; last_contacted_at: string | null; notes: string | null; store_name: string; shop_domain: string
}
export interface ShopifyAbandonedPage {
  total: number; items: ShopifyAbandoned[]
  stats: { open: number; open_value: number; recovered_30d: number; recovered_value_30d: number; with_contact: number; all_30d: number }
  channels: Array<{ id: string; name: string; shop_domain: string; status: string; synced_at: string | null; error: string | null }>
}
export type ShopifyView = 'open' | 'recovered' | 'dismissed' | 'all'

export const shopifyAbandoned = (view: ShopifyView, search: string, page: number, pageSize: number) =>
  rpc<ShopifyAbandonedPage>('admin_shopify_abandoned', { p_view: view, p_search: search || undefined, p_limit: pageSize, p_offset: page * pageSize })
export const updateShopifyAbandoned = (id: string, status: 'CONTACTED' | 'DISMISSED' | 'OPEN', note?: string) =>
  rpc('admin_update_shopify_abandoned', { p_id: id, p_status: status, p_note: note || undefined })
export interface AbandonedSyncResult { ok: boolean; channels: Array<{ id: string; name: string; ok: boolean; fetched: number; cursor: string | null; error?: string }> }
/** One batch: the last `days` days, or the whole history (days null). Pass the store and cursor to continue. */
export const fetchShopifyAbandoned = (days: number | null, channelId?: string, cursor?: string | null) =>
  invokeFunction<AbandonedSyncResult>('channels', { action: 'abandoned_sync', days, channel_id: channelId, cursor: cursor ?? undefined })
export const bulkShopifyAbandoned = (ids: string[], status: 'CONTACTED' | 'DISMISSED' | 'OPEN') => rpc<number>('admin_bulk_shopify_abandoned', { p_ids: ids, p_status: status })

/** CSV of abandoned checkouts (opens in Excel / Google Sheets). */
export function abandonedCsv(rows: ShopifyAbandoned[]): string {
  const esc = (v: unknown) => { const t = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }
  const head = ['Checkout', 'Created', 'Customer', 'Phone', 'Email', 'Region', 'City', 'Items', 'Total', 'Currency', 'Recovery status', 'Follow-up', 'Checkout link']
  const lines = rows.map((r) => [r.name ?? `#${r.legacy_id}`, r.shop_created_at, r.customer_name, r.phone, r.email, r.country, r.city,
    r.items.map((i) => `${i.title}${i.variant ? ` (${i.variant})` : ''} x${i.quantity}`).join('; '), r.total, r.currency,
    r.status === 'RECOVERED' ? 'Recovered' : 'Not recovered', r.follow_up, r.recovery_url].map(esc).join(','))
  return [head.join(','), ...lines].join('\n')
}

export const abandonedCounts = () => rpc<{ store: number; shopify: number }>('abandoned_counts')
