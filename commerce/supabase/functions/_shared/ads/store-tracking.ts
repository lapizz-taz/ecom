// Ad tracking for the merchant's own Fullfilio store: the browser pixels
// (Meta, TikTok, Google) plus the server copies (Meta Conversions API, TikTok
// Events API, GA4 Measurement Protocol). The same event id goes to both sides,
// so each platform counts an event once (deduplication).
//
// The Purchase is sent when the order is placed, confirmed or delivered — the
// merchant picks — and can skip duplicate orders or a low delivery-success
// rate, the same rules as the Fullfilio Connect WooCommerce plugin.
//
// Pixel ids are public (they are in the page anyway); the API tokens and the
// GA4 API secret are kept in Vault and only used here, on the server.

type FetchFn = typeof fetch

export const GRAPH = 'https://graph.facebook.com/v22.0'
export const TIKTOK_EVENTS = 'https://business-api.tiktok.com/open_api/v1.3/event/track/'
export const GA4_MP = 'https://www.google-analytics.com/mp/collect'
export const GA4_DEBUG = 'https://www.google-analytics.com/debug/mp/collect'

export type PurchaseOn = 'placed' | 'confirmed' | 'delivered'
export type AdPlatform = 'meta' | 'tiktok' | 'google'

export interface AdTrackingConfig {
  enabled: boolean
  /** When the Purchase is sent: as soon as the order is placed, when it is confirmed, or when it is delivered. */
  purchase_on: PurchaseOn
  browser_events: boolean
  server_events: boolean
  advanced_matching: boolean
  skip_duplicates: boolean
  /** Do not count orders whose delivery-success check came out Low. */
  exclude_low_rr: boolean
  meta: { pixel_id: string; test_code: string }
  tiktok: { pixel_id: string; test_code: string }
  google: { ga4_id: string; ads_id: string; ads_label: string }
}

export interface AdTrackingSecrets { meta_token?: string; tiktok_token?: string; ga4_secret?: string }

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const match = (v: string, re: RegExp) => (re.test(v) ? v : '')

/** Fills defaults and drops anything that is not a valid id. */
export function normalizeAdConfig(raw: unknown): AdTrackingConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const on = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
  const purchase = r.purchase_on === 'confirmed' || r.purchase_on === 'delivered' ? r.purchase_on : 'placed'
  return {
    enabled: on(r.enabled, false),
    purchase_on: purchase,
    browser_events: on(r.browser_events, true),
    server_events: on(r.server_events, true),
    advanced_matching: on(r.advanced_matching, true),
    skip_duplicates: on(r.skip_duplicates, true),
    exclude_low_rr: on(r.exclude_low_rr, false),
    meta: { pixel_id: match(str(r.meta?.pixel_id, 30), /^\d{10,20}$/), test_code: match(str(r.meta?.test_code, 40), /^[A-Za-z0-9_-]{3,40}$/) },
    tiktok: { pixel_id: match(str(r.tiktok?.pixel_id, 40), /^[A-Z0-9]{10,40}$/), test_code: match(str(r.tiktok?.test_code, 40), /^[A-Za-z0-9_-]{3,40}$/) },
    google: {
      ga4_id: match(str(r.google?.ga4_id, 30).toUpperCase(), /^G-[A-Z0-9]{4,20}$/),
      ads_id: match(str(r.google?.ads_id, 30).toUpperCase(), /^AW-\d{6,15}$/),
      ads_label: match(str(r.google?.ads_label, 60), /^[A-Za-z0-9_-]{4,60}$/),
    },
  }
}

/** What the storefront needs to load the pixels (no tokens, no secrets). */
export function publicAdConfig(c: AdTrackingConfig) {
  return {
    enabled: c.enabled,
    browser_events: c.browser_events,
    server_events: c.server_events,
    advanced_matching: c.advanced_matching,
    purchase_on: c.purchase_on,
    meta_pixel: c.meta.pixel_id || null,
    tiktok_pixel: c.tiktok.pixel_id || null,
    ga4_id: c.google.ga4_id || null,
    ads_id: c.google.ads_id || null,
    ads_label: c.google.ads_label || null,
  }
}

// --- matching data -----------------------------------------------------------------------------

export async function sha256(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 8801XXXXXXXXX for a Bangladeshi mobile number (Meta's format: country code, no +), else ''. */
export function phoneDigits(phone: string | null | undefined): string {
  let d = String(phone ?? '').replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('880')) d = d.slice(3)
  if (d.startsWith('0')) d = d.slice(1)
  return /^1[3-9]\d{8}$/.test(d) ? `880${d}` : ''
}

/** Lowercase letters only (Meta's rule for names and cities). */
const nameKey = (v: string | null | undefined) => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}]/gu, '')

export interface Person {
  phone?: string | null
  email?: string | null
  name?: string | null
  city?: string | null
  district?: string | null
  /** The store's own visitor id, also sent by the browser pixel. */
  external_id?: string | null
}

export interface BrowserIds {
  ip?: string | null
  ua?: string | null
  fbp?: string | null
  fbc?: string | null
  fbclid?: string | null
  ttp?: string | null
  ttclid?: string | null
  ga_cid?: string | null
  gclid?: string | null
}

export interface Matching {
  em?: string; ph?: string; ph_e164?: string; fn?: string; ln?: string; ct?: string; st?: string; country: string; external_id?: string
}

/** Hashes the customer's details the way Meta, TikTok and Google ask for them. */
export async function hashPerson(p: Person, advanced = true): Promise<Matching> {
  const out: Matching = { country: await sha256('bd') }
  if (p.external_id) out.external_id = await sha256(String(p.external_id).trim().toLowerCase())
  if (!advanced) return out
  const email = String(p.email ?? '').trim().toLowerCase()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.em = await sha256(email)
  const ph = phoneDigits(p.phone)
  if (ph) { out.ph = await sha256(ph); out.ph_e164 = await sha256(`+${ph}`) }
  const parts = String(p.name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length) out.fn = await sha256(nameKey(parts[0]))
  if (parts.length > 1) out.ln = await sha256(nameKey(parts[parts.length - 1]))
  const city = nameKey(p.city || p.district)
  if (city) out.ct = await sha256(city)
  const st = nameKey(p.district)
  if (st) out.st = await sha256(st)
  return out
}

/** Meta's click id cookie value built from an fbclid, when the browser had none. */
export function fbcFrom(ids: BrowserIds, at = Date.now()): string | null {
  if (ids.fbc && /^fb\.\d\.\d+\./.test(ids.fbc)) return ids.fbc
  return ids.fbclid ? `fb.1.${at}.${ids.fbclid}` : null
}

// --- events ------------------------------------------------------------------------------------

export type StoreEventName = 'PageView' | 'ViewContent' | 'AddToCart' | 'InitiateCheckout' | 'Purchase'

export interface ContentLine { id: string; name?: string; quantity: number; price: number }

export interface StoreEvent {
  name: StoreEventName
  event_id: string
  /** Unix seconds. */
  time: number
  url?: string | null
  value?: number
  currency?: string
  contents?: ContentLine[]
  /** The store's order number (Purchase only). */
  order_id?: string
}

const TIKTOK_NAMES: Record<StoreEventName, string> = {
  PageView: 'Pageview', ViewContent: 'ViewContent', AddToCart: 'AddToCart', InitiateCheckout: 'InitiateCheckout', Purchase: 'CompletePayment',
}

export interface SendResult { ok: boolean; error?: string; skipped?: string }

const round2 = (n: number) => Math.round(n * 100) / 100

function metaCustom(ev: StoreEvent): Record<string, unknown> | null {
  if (ev.value === undefined && !ev.contents?.length) return null
  const contents = ev.contents ?? []
  return Object.fromEntries(Object.entries({
    currency: ev.currency,
    value: ev.value === undefined ? undefined : round2(ev.value),
    content_type: 'product',
    content_ids: contents.map((c) => c.id),
    contents: contents.map((c) => ({ id: c.id, quantity: c.quantity, item_price: round2(c.price) })),
    num_items: contents.reduce((n, c) => n + c.quantity, 0) || undefined,
    order_id: ev.order_id,
  }).filter(([, v]) => v !== undefined && v !== null))
}

export function metaPayload(ev: StoreEvent, m: Matching, ids: BrowserIds, testCode?: string) {
  const user = Object.fromEntries(Object.entries({
    em: m.em ? [m.em] : undefined, ph: m.ph ? [m.ph] : undefined, fn: m.fn ? [m.fn] : undefined, ln: m.ln ? [m.ln] : undefined,
    ct: m.ct ? [m.ct] : undefined, st: m.st ? [m.st] : undefined, country: [m.country], external_id: m.external_id ? [m.external_id] : undefined,
    client_ip_address: ids.ip || undefined, client_user_agent: ids.ua || undefined, fbc: fbcFrom(ids) || undefined, fbp: ids.fbp || undefined,
  }).filter(([, v]) => v !== undefined))
  const data: Record<string, unknown> = {
    event_name: ev.name, event_time: ev.time, event_id: ev.event_id, action_source: 'website', user_data: user,
  }
  if (ev.url) data.event_source_url = ev.url
  const custom = metaCustom(ev)
  if (custom) data.custom_data = custom
  return { data: [data], ...(testCode ? { test_event_code: testCode } : {}) }
}

export function tiktokPayload(pixel: string, ev: StoreEvent, m: Matching, ids: BrowserIds, testCode?: string) {
  const user = Object.fromEntries(Object.entries({
    email: m.em, phone: m.ph_e164, external_id: m.external_id, ttclid: ids.ttclid || undefined, ttp: ids.ttp || undefined,
    ip: ids.ip || undefined, user_agent: ids.ua || undefined,
  }).filter(([, v]) => v !== undefined))
  const props: Record<string, unknown> = {}
  if (ev.value !== undefined) { props.value = round2(ev.value); props.currency = ev.currency; props.content_type = 'product' }
  if (ev.contents?.length) {
    props.content_type = 'product'
    props.contents = ev.contents.map((c) => ({ content_id: c.id, content_name: c.name, quantity: c.quantity, price: round2(c.price) }))
  }
  if (ev.order_id) props.order_id = ev.order_id
  const row: Record<string, unknown> = { event: TIKTOK_NAMES[ev.name], event_time: ev.time, event_id: ev.event_id, user, page: { url: ev.url ?? '' } }
  if (Object.keys(props).length) row.properties = props
  return { event_source: 'web', event_source_id: pixel, data: [row], ...(testCode ? { test_event_code: testCode } : {}) }
}

/** GA4 Measurement Protocol purchase (the server copy of the browser's purchase, same transaction id). */
export function ga4Payload(ev: StoreEvent, m: Matching, ids: BrowserIds) {
  // The browser's GA client id joins the server purchase to the visit; else a stable one per order.
  let cid = ids.ga_cid && /^\d+\.\d+$/.test(ids.ga_cid) ? ids.ga_cid : ''
  if (!cid) {
    let h = 0
    for (const ch of ev.event_id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
    cid = `${1_000_000_000 + (h % 1_000_000_000)}.${ev.time}`
  }
  return {
    client_id: cid,
    ...(m.external_id ? { user_id: m.external_id } : {}),
    user_data: Object.fromEntries(Object.entries({
      sha256_email_address: m.em ? [m.em] : undefined, sha256_phone_number: m.ph_e164 ? [m.ph_e164] : undefined,
    }).filter(([, v]) => v !== undefined)),
    events: [{
      name: 'purchase',
      params: Object.fromEntries(Object.entries({
        transaction_id: ev.order_id ?? ev.event_id, value: ev.value === undefined ? undefined : round2(ev.value), currency: ev.currency,
        items: (ev.contents ?? []).map((c) => ({ item_id: c.id, item_name: c.name, quantity: c.quantity, price: round2(c.price) })),
        gclid: ids.gclid || undefined,
      }).filter(([, v]) => v !== undefined)),
    }],
  }
}

async function post(fetchFn: FetchFn, url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 10_000): Promise<{ ok: boolean; status: number; json: any }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchFn(url, {
      method: 'POST', redirect: 'manual', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    })
    const json = await res.json().catch(() => null)
    return { ok: res.ok, status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

/** A readable reason from a platform's answer (never echoes a token). */
function reason(r: { status: number; json: any }, secret?: string): string {
  const raw = r.json?.error?.error_user_msg ?? r.json?.error?.message ?? r.json?.message ?? `HTTP ${r.status}`
  const msg = String(raw).slice(0, 240)
  return secret ? msg.split(secret).join('[hidden]') : msg
}

export interface SendDeps { fetchFn?: FetchFn; timeoutMs?: number }

export async function sendMeta(c: AdTrackingConfig, s: AdTrackingSecrets, ev: StoreEvent, m: Matching, ids: BrowserIds, d: SendDeps = {}): Promise<SendResult> {
  if (!c.meta.pixel_id) return { ok: false, skipped: 'No Meta pixel id' }
  if (!s.meta_token) return { ok: false, skipped: 'No Conversions API token' }
  try {
    // The token goes in the body, not the URL, so it never lands in a request log.
    const r = await post(d.fetchFn ?? fetch, `${GRAPH}/${encodeURIComponent(c.meta.pixel_id)}/events`,
      { ...metaPayload(ev, m, ids, c.meta.test_code || undefined), access_token: s.meta_token }, {}, d.timeoutMs)
    if (r.ok && Number(r.json?.events_received ?? 0) >= 1) return { ok: true }
    return { ok: false, error: `Meta: ${reason(r, s.meta_token)}` }
  } catch (e) {
    return { ok: false, error: `Meta: ${(e as Error).name === 'AbortError' ? 'no answer in time' : 'could not reach Meta'}` }
  }
}

export async function sendTikTok(c: AdTrackingConfig, s: AdTrackingSecrets, ev: StoreEvent, m: Matching, ids: BrowserIds, d: SendDeps = {}): Promise<SendResult> {
  if (!c.tiktok.pixel_id) return { ok: false, skipped: 'No TikTok pixel id' }
  if (!s.tiktok_token) return { ok: false, skipped: 'No Events API token' }
  // The pixel's own page() call counts page views; it takes no event id, so a server copy would count twice.
  if (ev.name === 'PageView') return { ok: false, skipped: 'TikTok counts page views from the pixel' }
  try {
    const r = await post(d.fetchFn ?? fetch, TIKTOK_EVENTS, tiktokPayload(c.tiktok.pixel_id, ev, m, ids, c.tiktok.test_code || undefined),
      { 'Access-Token': s.tiktok_token }, d.timeoutMs)
    if (r.ok && Number(r.json?.code ?? -1) === 0) return { ok: true }
    return { ok: false, error: `TikTok: ${reason(r, s.tiktok_token)}` }
  } catch (e) {
    return { ok: false, error: `TikTok: ${(e as Error).name === 'AbortError' ? 'no answer in time' : 'could not reach TikTok'}` }
  }
}

export async function sendGa4(c: AdTrackingConfig, s: AdTrackingSecrets, ev: StoreEvent, m: Matching, ids: BrowserIds, d: SendDeps = {}): Promise<SendResult> {
  if (ev.name !== 'Purchase') return { ok: false, skipped: 'Google gets the purchase only' }
  if (!c.google.ga4_id) return { ok: false, skipped: 'No GA4 measurement id' }
  if (!s.ga4_secret) return { ok: false, skipped: 'No Measurement Protocol API secret' }
  try {
    const url = `${GA4_MP}?measurement_id=${encodeURIComponent(c.google.ga4_id)}&api_secret=${encodeURIComponent(s.ga4_secret)}`
    const r = await post(d.fetchFn ?? fetch, url, ga4Payload(ev, m, ids), {}, d.timeoutMs)
    // GA4 answers 204 with no body for anything it accepts; it does not report errors here.
    return r.ok ? { ok: true } : { ok: false, error: `Google: HTTP ${r.status}` }
  } catch (e) {
    return { ok: false, error: `Google: ${(e as Error).name === 'AbortError' ? 'no answer in time' : 'could not reach Google'}` }
  }
}

/** Sends one event to every platform that is set up. One platform failing does not stop the others. */
export async function sendServerEvent(c: AdTrackingConfig, s: AdTrackingSecrets, ev: StoreEvent, person: Person, ids: BrowserIds, d: SendDeps = {}) {
  const m = await hashPerson(person, c.advanced_matching)
  const [meta, tiktok, google] = await Promise.all([
    sendMeta(c, s, ev, m, ids, d), sendTikTok(c, s, ev, m, ids, d), sendGa4(c, s, ev, m, ids, d),
  ])
  return { meta, tiktok, google }
}

// --- Purchase rules ------------------------------------------------------------------------------

/** The event id shared by the browser Purchase and the server copy: one per order. */
export const purchaseEventId = (orderNumber: string) => `ffs_pu_${String(orderNumber).replace(/[^A-Za-z0-9_-]/g, '')}`

export interface PurchaseOrder {
  order_number: string
  status: string
  total: number
  currency: string
  merged_into: string | null
  duplicate_of: string | null
  receive_rate_tier: string | null
  created_at: string
}

/** Why a Purchase should not be sent (null = send it). */
export function purchaseSkipReason(c: AdTrackingConfig, o: PurchaseOrder): string | null {
  if (!(o.total > 0)) return 'The order total is 0'
  if (['CANCELLED', 'REJECTED_FRAUD'].includes(o.status)) return `The order is ${o.status.toLowerCase().replace('_', ' ')}`
  if (o.merged_into) return 'Merged into another order (that one is counted)'
  if (c.skip_duplicates && o.duplicate_of) return 'A duplicate of an earlier order'
  if (c.exclude_low_rr && o.receive_rate_tier === 'LOW') return 'Low delivery-success rate'
  return null
}

// --- connection checks -------------------------------------------------------------------------

/** Checks one platform with the saved ids and token, without counting a real event. */
export async function testPlatform(platform: AdPlatform, c: AdTrackingConfig, s: AdTrackingSecrets, d: SendDeps = {}): Promise<{ ok: boolean; message: string; hint?: boolean }> {
  const fetchFn = d.fetchFn ?? fetch
  const now = Math.floor(Date.now() / 1000)
  const testEv: StoreEvent = { name: 'PageView', event_id: `ffs_test_${crypto.randomUUID().slice(0, 10)}`, time: now, url: null }
  const m: Matching = { country: await sha256('bd'), external_id: await sha256('fullfilio-test') }
  if (platform === 'meta') {
    if (!c.meta.pixel_id || !s.meta_token) return { ok: false, hint: true, message: 'Enter the Pixel ID and the Conversions API token first.' }
    try {
      const res = await fetchFn(`${GRAPH}/${encodeURIComponent(c.meta.pixel_id)}?fields=id,name`, { headers: { Authorization: `Bearer ${s.meta_token}` }, redirect: 'manual' })
      const json = (await res.json().catch(() => null)) as { id?: string; name?: string } | null
      if (!res.ok || String(json?.id ?? '') !== c.meta.pixel_id) return { ok: false, message: `Meta refused: ${reason({ status: res.status, json }, s.meta_token)}` }
      let msg = `Connected to pixel “${json?.name ?? c.meta.pixel_id}”.`
      if (c.meta.test_code) {
        const t = await sendMeta(c, s, testEv, m, { ua: 'Fullfilio connection test' }, d)
        msg += t.ok ? ' A test PageView was sent — see Events Manager → Test events.' : ` The test event was refused: ${t.error}`
      }
      return { ok: true, message: msg }
    } catch {
      return { ok: false, message: 'Could not reach Meta.' }
    }
  }
  if (platform === 'tiktok') {
    if (!c.tiktok.pixel_id || !s.tiktok_token) return { ok: false, hint: true, message: 'Enter the Pixel ID and the Events API token first.' }
    if (!c.tiktok.test_code) return { ok: false, hint: true, message: 'Add a test event code (TikTok Events Manager → your pixel → Test events) so the check does not count a real event.' }
    const r = await sendTikTok(c, s, { ...testEv, name: 'ViewContent' }, m, { ua: 'Fullfilio connection test' }, d)
    return r.ok ? { ok: true, message: 'TikTok accepted a test event — see Events Manager → Test events.' } : { ok: false, message: r.error ?? r.skipped ?? 'TikTok refused' }
  }
  if (!c.google.ga4_id || !s.ga4_secret) return { ok: false, hint: true, message: 'Enter the GA4 Measurement ID and the Measurement Protocol API secret first.' }
  try {
    const url = `${GA4_DEBUG}?measurement_id=${encodeURIComponent(c.google.ga4_id)}&api_secret=${encodeURIComponent(s.ga4_secret)}`
    const r = await post(fetchFn, url, { client_id: '123456789.1700000000', events: [{ name: 'purchase', params: { transaction_id: 'ffs-test', value: 1, currency: 'BDT' } }] })
    const issues = Array.isArray(r.json?.validationMessages) ? r.json.validationMessages.map((v: { description?: string }) => v.description).filter(Boolean) : []
    if (!r.ok || issues.length) return { ok: false, message: `Google refused: ${issues.length ? issues.join(' ') : `HTTP ${r.status}`}` }
    return { ok: true, message: 'Google’s validation server accepted the purchase format. It does not check the API secret there — the first real purchase shows in GA4 → Reports → Realtime.' }
  } catch {
    return { ok: false, message: 'Could not reach Google.' }
  }
}
