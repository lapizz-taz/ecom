// Store ad tracking, the database side: settings and tokens, the admin's
// status screen, the per-minute Purchase queue and the storefront beacon.
// Payloads and senders live in store-tracking.ts.
import type { SupabaseClient } from '@supabase/supabase-js'
import { HttpError } from '../http.ts'
import { merchantOf, rpc } from '../supabase.ts'
import {
  type AdPlatform, type AdTrackingConfig, type AdTrackingSecrets, type BrowserIds, type ContentLine, hashPerson, normalizeAdConfig,
  type HashedMatching, type Person, purchaseEventId, purchaseSkipReason, type SendResult, sendServerEvent, type StoreEvent, type StoreEventName, testPlatform,
} from './store-tracking.ts'

const SECRET_KEY = 'ad_tracking'
type FetchFn = typeof fetch

export interface AdTrackingState { config: AdTrackingConfig; secrets: AdTrackingSecrets }

// The storefront beacon reads the settings on every page view: keep them for a
// minute in this isolate's memory (never in a shared cache — they include tokens).
const cache = new Map<string, { at: number; state: AdTrackingState }>()
const CACHE_MS = 60_000

export async function loadAdTracking(admin: SupabaseClient, useCache = false): Promise<AdTrackingState> {
  const merchant = merchantOf(admin)!
  const hit = useCache ? cache.get(merchant) : undefined
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.state
  const [{ data: row, error }, secret] = await Promise.all([
    admin.from('store_ad_tracking').select('config').eq('merchant_id', merchant).maybeSingle(),
    admin.rpc('integration_secret_get', { p_key: SECRET_KEY }),
  ])
  if (error) throw new HttpError(500, 'Could not read the ad tracking settings', 'READ_FAILED')
  const state = { config: normalizeAdConfig(row?.config), secrets: ((secret.data as AdTrackingSecrets | null) ?? {}) }
  cache.set(merchant, { at: Date.now(), state })
  return state
}

const tail = (v?: string) => (v ? `••••${v.slice(-4)}` : null)

/** For the admin screen: settings, which tokens are saved (masked) and the latest events. */
export async function adTrackingStatus(admin: SupabaseClient) {
  const { config, secrets } = await loadAdTracking(admin)
  const { data: recent } = await admin.from('ad_event_queue')
    .select('id, event, event_id, status, attempts, results, last_error, created_at, done_at, orders(order_number, total_amount)')
    .eq('merchant_id', merchantOf(admin)!).order('created_at', { ascending: false }).limit(20)
  return {
    config,
    tokens: { meta: tail(secrets.meta_token), tiktok: tail(secrets.tiktok_token), ga4: tail(secrets.ga4_secret) },
    recent: recent ?? [],
  }
}

export interface SaveInput {
  config: unknown
  /** New tokens; an empty or missing one keeps the saved token. */
  tokens?: { meta_token?: string; tiktok_token?: string; ga4_secret?: string }
  /** Tokens to remove. */
  clear?: Array<'meta_token' | 'tiktok_token' | 'ga4_secret'>
}

export async function saveAdTracking(admin: SupabaseClient, input: SaveInput, actor: string) {
  const config = normalizeAdConfig(input.config)
  const { secrets } = await loadAdTracking(admin)
  const next: AdTrackingSecrets = { ...secrets }
  for (const [k, v] of Object.entries(input.tokens ?? {})) {
    if (typeof v === 'string' && v.trim()) next[k as keyof AdTrackingSecrets] = v.trim()
  }
  for (const k of input.clear ?? []) delete next[k]
  if (config.enabled && !config.meta.pixel_id && !config.tiktok.pixel_id && !config.google.ga4_id && !config.google.ads_id) {
    throw new HttpError(422, 'Add at least one pixel or tag id to turn tracking on', 'VALIDATION')
  }
  const kept = Object.fromEntries(Object.entries(next).filter(([, v]) => !!v))
  if (Object.keys(kept).length) {
    const hint = [kept.meta_token && 'Meta', kept.tiktok_token && 'TikTok', kept.ga4_secret && 'GA4'].filter(Boolean).join(' + ')
    await rpc(admin, 'integration_secret_store', { p_key: SECRET_KEY, p_value: kept, p_hint: hint, p_actor: actor })
  } else if (Object.keys(secrets).length) {
    await rpc(admin, 'integration_secret_clear', { p_key: SECRET_KEY, p_actor: actor })
  }
  await rpc(admin, 'store_ad_tracking_set', { p_config: config, p_actor: actor })
  cache.delete(merchantOf(admin)!)
  return adTrackingStatus(admin)
}

export async function testAdTracking(admin: SupabaseClient, platform: AdPlatform, fetchFn?: FetchFn) {
  const { config, secrets } = await loadAdTracking(admin)
  return testPlatform(platform, config, secrets, { fetchFn })
}

// --- the Purchase queue ------------------------------------------------------------------------

interface OrderFacts {
  order_number: string; web_number?: string | null; status: string; total: number; currency: string
  customer_name: string | null; customer_phone: string | null; customer_email: string | null
  city: string | null; district: string | null; client_ip: string | null; user_agent: string | null; created_at: string
  merged_into: string | null; duplicate_of: string | null; receive_rate_tier: string | null
  visitor_id: string | null; click_id: string | null; click_id_type: string | null; landing_page: string | null
  browser_ids: { fbp?: string; fbc?: string; ttp?: string; ga?: string } | null
  items: Array<{ id: string; name: string; quantity: number; price: number }>
}

function idsOf(o: OrderFacts): BrowserIds {
  const click = (type: string) => (o.click_id_type?.toLowerCase() === type ? o.click_id : null)
  return {
    ip: o.client_ip, ua: o.user_agent,
    fbp: o.browser_ids?.fbp ?? null, fbc: o.browser_ids?.fbc ?? null, ttp: o.browser_ids?.ttp ?? null, ga_cid: o.browser_ids?.ga ?? null,
    fbclid: click('fbclid'), ttclid: click('ttclid'), gclid: click('gclid'),
  }
}

/** What happened on each platform, for the queue row. */
function outcome(results: Record<string, SendResult>) {
  const tried = Object.values(results).filter((r) => !r.skipped)
  const ok = tried.filter((r) => r.ok).length
  if (!tried.length) return { status: 'SKIPPED' as const, error: 'No platform is set up yet (pixel id and token)' }
  const errors = tried.filter((r) => !r.ok).map((r) => r.error).filter(Boolean).join('; ')
  if (ok === tried.length) return { status: 'DONE' as const, error: null }
  if (ok > 0) return { status: 'PARTIAL' as const, error: errors }
  return { status: 'FAILED' as const, error: errors }
}

/** Sends the due Purchases for this merchant (the per-minute job run). */
export async function processAdEvents(admin: SupabaseClient, limit = 20, fetchFn?: FetchFn) {
  const due = await rpc<Array<{ id: string; order_id: string; event: 'Purchase'; event_id: string; attempts: number }>>(admin, 'ad_event_due', { p_limit: limit })
  const out = { sent: 0, partial: 0, skipped: 0, waiting: 0, failed: 0 }
  if (!due.length) return out
  const { config, secrets } = await loadAdTracking(admin)
  for (const job of due) {
    const order = await rpc<OrderFacts | null>(admin, 'ad_event_order', { p_order_id: job.order_id })
    const skip = !order ? 'The order is gone'
      : !config.enabled || !config.server_events ? 'Tracking was turned off'
      : purchaseSkipReason(config, { ...order, total: Number(order.total) })
    if (skip || !order) {
      await rpc(admin, 'ad_event_result', { p_id: job.id, p_status: 'SKIPPED', p_results: {}, p_error: skip })
      out.skipped++
      continue
    }
    const placed = config.purchase_on === 'placed'
    const ev: StoreEvent = {
      name: 'Purchase', event_id: job.event_id,
      // Placed: the moment of the order (it matches the browser's Purchase). Later: now.
      time: Math.floor((placed ? new Date(order.created_at).getTime() : Date.now()) / 1000),
      url: order.landing_page, value: Number(order.total), currency: order.currency || 'BDT', order_id: order.order_number,
      contents: order.items.map((i) => ({ id: i.id, name: i.name, quantity: Number(i.quantity), price: Number(i.price) })),
    }
    const person: Person = {
      phone: order.customer_phone, email: order.customer_email, name: order.customer_name,
      city: order.city, district: order.district, external_id: order.visitor_id,
    }
    const results = await sendServerEvent(config, secrets, ev, person, idsOf(order), { fetchFn })
    const o = outcome(results)
    await rpc(admin, 'ad_event_result', { p_id: job.id, p_status: o.status, p_results: results, p_error: o.error, p_retry: o.status === 'FAILED' })
    if (o.status === 'DONE') out.sent++
    else if (o.status === 'PARTIAL') out.partial++
    else if (o.status === 'SKIPPED') out.skipped++
    else if (job.attempts + 1 < 6) out.waiting++
    else out.failed++
  }
  return out
}

/**
 * The Purchase for the order-success page: only when it counts at once (placed
 * mode) and the order passes the same rules as the server copy. Same event id
 * as the queued server event, so the platforms count it once.
 */
export async function browserPurchase(admin: SupabaseClient, orderId: string, merged: boolean) {
  const { config } = await loadAdTracking(admin, true)
  if (!config.enabled || !config.browser_events || config.purchase_on !== 'placed' || merged) return null
  const order = await rpc<OrderFacts | null>(admin, 'ad_event_order', { p_order_id: orderId })
  if (!order || purchaseSkipReason(config, { ...order, total: Number(order.total) })) return null
  // Hashed email / phone for TikTok's identify and Google's enhanced conversions (the buyer's own details, to their own browser).
  const m = config.advanced_matching ? await hashPerson({ phone: order.customer_phone, email: order.customer_email }) : null
  return {
    // The number the order was placed under: an order approved since then has a new one, the queued server copy does not.
    event_id: purchaseEventId(order.web_number ?? order.order_number), order_id: order.order_number, value: Number(order.total), currency: order.currency || 'BDT',
    contents: order.items.map((i) => ({ id: i.id, name: i.name, quantity: Number(i.quantity), price: Number(i.price) })),
    matching: m && (m.em || m.ph_e164) ? { em: m.em, ph_e164: m.ph_e164 } : null,
  }
}

// --- the storefront beacon (server copies of browser events) ---------------------------------------

// Each browser event id is sent to the platforms once: a retried or replayed beacon is dropped here
// (the platforms also merge the browser and server copies by this id). Per server instance, 30 minutes.
const SENT_TTL_MS = 30 * 60_000
const SENT_MAX = 20_000
const sentIds = new Map<string, number>()

/** True the first time a store's event id is seen (within 30 minutes); later copies are duplicates. */
export function firstSend(merchantId: string, eventId: string, now = Date.now()): boolean {
  const key = `${merchantId}:${eventId}`
  const at = sentIds.get(key)
  if (at !== undefined && now - at < SENT_TTL_MS) return false
  if (sentIds.size >= SENT_MAX) {
    for (const [k, t] of sentIds) {
      if (now - t >= SENT_TTL_MS || sentIds.size >= SENT_MAX) sentIds.delete(k)
      if (sentIds.size < SENT_MAX * 0.9) break
    }
  }
  sentIds.set(key, now)
  return true
}

export interface BeaconInput {
  event: Exclude<StoreEventName, 'Purchase'>
  event_id: string
  url: string
  visitor_id?: string
  value?: number
  currency?: string
  contents?: ContentLine[]
  browser?: { fbp?: string; fbc?: string; ttp?: string }
  click?: { fbclid?: string; ttclid?: string }
  /** Search only. */
  search?: string
  /** A returning buyer's details, hashed in their own browser. */
  user?: HashedMatching
}

interface TrackScope { hosts: string[]; prices: Record<string, number> }

const hostOf = (raw: string | null | undefined): string | null => {
  try { return raw ? new URL(raw).hostname.toLowerCase() : null } catch { return null }
}

/**
 * One browser event's server copy (Meta + TikTok), with the browser's own event id.
 * The beacon is public, so what it reports is checked against the store before it is
 * sent with the store's tokens: the page must be one of the store's own addresses (and
 * so must the calling page, when the browser names it), products must be the store's
 * active ones, prices at most their catalog price, and the value is their sum.
 */
export async function beaconEvent(admin: SupabaseClient, input: BeaconInput, ip: string | null, ua: string | null, fetchFn?: FetchFn, origin?: string | null) {
  const { config, secrets } = await loadAdTracking(admin, true)
  if (!config.enabled || !config.server_events) return { ok: false, skipped: 'Tracking is off' }
  const productIds = [...new Set((input.contents ?? []).map((c) => c.id))].filter((id) => /^[0-9a-f-]{36}$/i.test(id))
  const scope = await rpc<TrackScope>(admin, 'ad_track_scope', { p_ids: productIds })
  const page = hostOf(input.url)
  if (!page || !scope.hosts.includes(page)) return { ok: false, skipped: 'Not a page of this store' }
  if (origin && origin !== 'null' && !scope.hosts.includes(hostOf(origin) ?? '')) return { ok: false, skipped: 'Not a page of this store' }
  const contents = input.contents
    ?.filter((c) => scope.prices[c.id] !== undefined)
    .map((c) => ({ ...c, price: Math.min(c.price, scope.prices[c.id]) }))
  const value = contents ? Math.round(contents.reduce((sum, c) => sum + c.price * c.quantity, 0) * 100) / 100 : undefined
  const ev: StoreEvent = {
    name: input.event, event_id: input.event_id, time: Math.floor(Date.now() / 1000), url: input.url,
    value, currency: value === undefined ? undefined : input.currency, contents,
    search: input.event === 'Search' ? input.search?.trim().slice(0, 100) || undefined : undefined,
  }
  const ids: BrowserIds = {
    ip, ua, fbp: input.browser?.fbp, fbc: input.browser?.fbc, ttp: input.browser?.ttp,
    fbclid: input.click?.fbclid, ttclid: input.click?.ttclid,
  }
  const results = await sendServerEvent(config, secrets, ev, { external_id: input.visitor_id }, ids, { fetchFn, timeoutMs: 6_000 }, input.user)
  return { ok: Object.values(results).some((r) => r.ok), results }
}
