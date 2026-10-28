// Ad tracking on the merchant's own store: the browser pixels (Meta, TikTok,
// Google) and, for every funnel event, a server copy (Conversions API, Events
// API) with the same event id, so each platform counts it once.
//
// The Purchase: in "placed" mode the checkout answer carries it (same id as the
// server event queued for the order); for "confirmed" / "delivered" only the
// server sends it, later, when the order gets there.
//
// Ids and switches come from storefront_ad_tracking (no tokens). Nothing loads
// until the store has turned tracking on, and never inside the theme editor.
//
// Server copies go to our own server on the store's address (first-party, so ad
// blockers leave them alone), which also keeps the _fbp / _fbc cookies alive
// (worker/storefront.ts). A returning buyer's details are kept in their browser
// only as SHA-256 hashes, per store, and sent with that store's events for better
// matching when the store has Advanced matching on.
import { functionHeaders } from '@/lib/functions'
import { functionsUrl } from '@/lib/env'
import { lastClickIds, visitorId } from '@/lib/attribution'
import { currentSite, merchantFetch, storeBasename, storeKey } from '@/lib/merchant'
import type { AdLine, AdPurchase, StoreAdConfig } from '@/services/storefront'

export type { AdLine, AdPurchase, StoreAdConfig }

export interface AdEventData { value?: number; currency?: string; contents?: AdLine[]; search?: string }
export type FunnelEvent = 'PageView' | 'ViewContent' | 'AddToCart' | 'InitiateCheckout' | 'Search' | 'Contact' | 'CompleteRegistration'

type Fn = (...args: unknown[]) => void
declare global {
  interface Window {
    fbq?: Fn & { callMethod?: Fn; queue?: unknown[]; push?: Fn; loaded?: boolean; version?: string }
    _fbq?: unknown
    ttq?: unknown[] & Record<string, unknown> & { page: Fn; track: Fn; identify: Fn; load: Fn }
    TiktokAnalyticsObject?: string
    dataLayer?: unknown[]
    gtag?: Fn
  }
}

const CODES: Record<FunnelEvent, string> = {
  PageView: 'pv', ViewContent: 'vc', AddToCart: 'ac', InitiateCheckout: 'ic', Search: 'se', Contact: 'ct', CompleteRegistration: 'cr',
}
const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

let cfg: StoreAdConfig | null = null
let ready = false
const waiting: Array<() => void> = []

function randomId(n = 20): string {
  const bytes = crypto.getRandomValues(new Uint8Array(n))
  return Array.from(bytes, (b) => ABC[b % ABC.length]).join('')
}

/** One event id per event, shared by the pixel and the server copy. */
export function eventId(event: FunnelEvent): string {
  return `ffs_${CODES[event]}_${randomId()}`
}

function cookie(name: string): string {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  try {
    return m ? decodeURIComponent(m[1]) : ''
  } catch {
    return ''
  }
}

function setCookie(name: string, value: string, days: number) {
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${new Date(Date.now() + days * 864e5).toUTCString()}; path=/; SameSite=Lax${location.protocol === 'https:' ? '; Secure' : ''}`
}

// The same formats the server accepts (schemas.ts browserIdsSchema): anything else is left out.
const FBP = /^fb\.\d\.\d{10,13}\.\d{1,25}$/
const FBC = /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_.-]{4,550}$/
const TTP = /^[A-Za-z0-9_.-]{8,80}$/
const GA = /^\d{5,12}\.\d{9,12}$/
const CLICK = /^[A-Za-z0-9_.-]{1,500}$/

// Stores opened by path (/s/<name>) share the platform host's cookies with every other store and
// the website (security audit run 6). There the Meta ids sent with our server copies are kept per
// store (storeKey), and the host-wide TikTok and Google cookies are not sent at all.
const pathStore = () => storeBasename() !== ''
const AD_KEYS = { _fbp: storeKey('ff_fbp'), _fbc: storeKey('ff_fbc') } as const

function adId(name: keyof typeof AD_KEYS): string {
  if (!pathStore()) return cookie(name)
  try {
    return localStorage.getItem(AD_KEYS[name]) ?? ''
  } catch {
    return ''
  }
}

function keepAdId(name: keyof typeof AD_KEYS, value: string) {
  if (!pathStore()) return setCookie(name, value, 90)
  try {
    localStorage.setItem(AD_KEYS[name], value)
  } catch {
    /* private mode */
  }
}

/** The browser's own ad ids (Meta _fbp/_fbc, TikTok _ttp, GA client id), for the server-side events. */
export function browserIds(): { fbp?: string; fbc?: string; ttp?: string; ga?: string } {
  if (typeof document === 'undefined') return {}
  const shared = pathStore()
  const ga = shared ? '' : cookie('_ga').split('.').slice(2).join('.')
  const out = { fbp: adId('_fbp'), fbc: adId('_fbc'), ttp: shared ? '' : cookie('_ttp'), ga }
  return Object.fromEntries(Object.entries(out).filter(([k, v]) => v && { fbp: FBP, fbc: FBC, ttp: TTP, ga: GA }[k]!.test(v)))
}

/** Meta's first-party ids, as its pixel writes them, so the server copy can match the visit. */
function metaCookies() {
  if (!FBP.test(adId('_fbp'))) keepAdId('_fbp', `fb.1.${Date.now()}.${1_000_000_000 + Math.floor(Math.random() * 9_000_000_000)}`)
  const fbclid = lastClickIds().fbclid
  if (fbclid && CLICK.test(fbclid) && adId('_fbc').split('.').slice(3).join('.') !== fbclid) keepAdId('_fbc', `fb.1.${Date.now()}.${fbclid}`)
}

async function sha256(value: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return ''
  }
}

// --- a returning buyer, hashed ----------------------------------------------------------------

/** SHA-256 of the buyer's details, normalised the way the server does it (store-tracking.ts hashPerson). */
export interface ShopperHashes { em?: string; ph?: string; ph_e164?: string; fn?: string; ln?: string; ct?: string; st?: string }
// Stores opened by path (/s/<name>) share the platform's origin, so the key names the store:
// one store's buyers never reach another store's pixels.
const shopperKey = () => { const s = currentSite(); return s.kind === 'store' && s.merchant_id ? `ff_am:${s.merchant_id}` : null }
try { localStorage.removeItem('ff_am') } catch { /* the old, store-less key */ }
const HEX64 = /^[0-9a-f]{64}$/

/** 8801XXXXXXXXX for a Bangladeshi mobile number, else ''. */
function phoneDigits(phone: string): string {
  let d = phone.replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (d.startsWith('880')) d = d.slice(3)
  if (d.startsWith('0')) d = d.slice(1)
  return /^1[3-9]\d{8}$/.test(d) ? `880${d}` : ''
}
const nameKey = (v?: string | null) => String(v ?? '').toLowerCase().normalize('NFKD').replace(/[^\p{L}]/gu, '')

/** The hashes kept from this browser's last order or sign-up (never the details themselves). */
export function shopperHashes(): ShopperHashes {
  try {
    const key = shopperKey()
    if (!key) return {}
    const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as Record<string, unknown> | null
    if (!raw || typeof raw !== 'object') return {}
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => ['em', 'ph', 'ph_e164', 'fn', 'ln', 'ct', 'st'].includes(k) && typeof v === 'string' && HEX64.test(v)))
  } catch {
    return {}
  }
}

/** Advanced matching off (the server honours it too): no buyer details with any event. */
const matching = () => cfg?.advanced_matching !== false

/** After an order or sign-up: keep the buyer's details as hashes, for the next visits' events. */
export async function rememberShopper(p: { phone?: string | null; email?: string | null; name?: string | null; city?: string | null; district?: string | null }) {
  const key = shopperKey()
  if (!key || !cfg || !matching()) return
  try {
    const out: ShopperHashes = { ...shopperHashes() }
    const email = String(p.email ?? '').trim().toLowerCase()
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.em = await sha256(email)
    const ph = phoneDigits(String(p.phone ?? ''))
    if (ph) { out.ph = await sha256(ph); out.ph_e164 = await sha256(`+${ph}`) }
    const parts = String(p.name ?? '').trim().split(/\s+/).filter(Boolean)
    if (parts.length) out.fn = await sha256(nameKey(parts[0]))
    if (parts.length > 1) out.ln = await sha256(nameKey(parts[parts.length - 1]))
    const city = nameKey(p.city || p.district)
    if (city) out.ct = await sha256(city)
    const st = nameKey(p.district)
    if (st) out.st = await sha256(st)
    const clean = Object.fromEntries(Object.entries(out).filter(([, v]) => v && HEX64.test(v)))
    if (Object.keys(clean).length) localStorage.setItem(key, JSON.stringify(clean))
  } catch {
    /* private mode: no memory, no harm */
  }
}

function addScript(src: string) {
  const s = document.createElement('script')
  s.async = true
  s.src = src
  document.head.appendChild(s)
}

// The platforms' standard loader stubs: calls made before the script arrives are queued.
function loadMeta(pixel: string, externalId: string, am: ShopperHashes, country: string) {
  if (!window.fbq) {
    const n = function (...args: unknown[]) {
      if (n.callMethod) n.callMethod(...args)
      else n.queue!.push(args)
    } as NonNullable<Window['fbq']>
    n.push = n
    n.loaded = true
    n.version = '2.0'
    n.queue = []
    window.fbq = n
    if (!window._fbq) window._fbq = n
    addScript('https://connect.facebook.net/en_US/fbevents.js')
  }
  // Advanced matching with hashed values only (Meta takes SHA-256 as is).
  const match = Object.fromEntries(Object.entries({
    external_id: externalId, em: am.em, ph: am.ph, fn: am.fn, ln: am.ln, ct: am.ct, st: am.st, country: am.ph || am.em ? country : undefined,
  }).filter(([, v]) => v))
  window.fbq('init', pixel, match)
}

function loadTikTok(pixel: string, externalId: string, am: ShopperHashes) {
  if (!window.ttq) {
    // TikTok's own snippet, typed loosely: it builds the queue the real script picks up.
    const w = window as any
    w.TiktokAnalyticsObject = 'ttq'
    const ttq: any = (w.ttq = w.ttq || [])
    ttq.methods = ['page', 'track', 'identify', 'instances', 'debug', 'on', 'off', 'once', 'ready', 'alias', 'group', 'enableCookie', 'disableCookie']
    ttq.setAndDefer = (t: any, e: string) => { t[e] = (...args: unknown[]) => { t.push([e, ...args]) } }
    for (const m of ttq.methods) ttq.setAndDefer(ttq, m)
    ttq.instance = (t: string) => { const e = ttq._i[t] || []; for (const m of ttq.methods) ttq.setAndDefer(e, m); return e }
    ttq.load = (e: string, n?: unknown) => {
      const r = 'https://analytics.tiktok.com/i18n/pixel/events.js'
      ttq._i = ttq._i || {}; ttq._i[e] = []; ttq._i[e]._u = r
      ttq._t = ttq._t || {}; ttq._t[e] = +new Date()
      ttq._o = ttq._o || {}; ttq._o[e] = n || {}
      addScript(`${r}?sdkid=${encodeURIComponent(e)}&lib=ttq`)
    }
    ttq.load(pixel)
  }
  const who = Object.fromEntries(Object.entries({ external_id: externalId, email: am.em, phone_number: am.ph_e164 }).filter(([, v]) => v))
  if (Object.keys(who).length) window.ttq!.identify(who)
}

function loadGoogle(c: StoreAdConfig, am: ShopperHashes) {
  if (window.gtag) return
  addScript(`https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(c.ga4_id || c.ads_id || '')}`)
  window.dataLayer = window.dataLayer || []
  window.gtag = function gtag() {
    // gtag reads the arguments object itself, as Google's snippet does.
    window.dataLayer!.push(arguments)
  }
  window.gtag('js', new Date())
  if (c.ga4_id) window.gtag('config', c.ga4_id, { send_page_view: false })
  if (c.ads_id) window.gtag('config', c.ads_id, { allow_enhanced_conversions: true })
  const user = Object.fromEntries(Object.entries({ sha256_email_address: am.em, sha256_phone_number: am.ph_e164 }).filter(([, v]) => v))
  if (Object.keys(user).length) window.gtag('set', 'user_data', user)
}

/** Loads the pixels the store turned on. Called once the settings arrive. */
export async function startAdPixels(c: StoreAdConfig | null | undefined) {
  if (ready || !c) return
  cfg = c.enabled ? c : null
  if (cfg && cfg.browser_events !== false) {
    try {
      if (cfg.meta_pixel) metaCookies()
      const ext = await sha256(visitorId())
      const am = matching() ? shopperHashes() : {}
      if (cfg.meta_pixel) loadMeta(cfg.meta_pixel, ext, am, await sha256('bd'))
      if (cfg.tiktok_pixel) loadTikTok(cfg.tiktok_pixel, ext, am)
      if (cfg.ga4_id || cfg.ads_id) loadGoogle(cfg, am)
    } catch {
      /* a blocked pixel never breaks the store */
    }
  }
  ready = true
  for (const run of waiting.splice(0)) run()
}

/** The settings once loaded; events wait for them (a few hundred milliseconds at most). */
function whenReady(run: () => void) {
  if (ready) run()
  else if (waiting.length < 20) waiting.push(run)
}

const round2 = (n: number) => Math.round(n * 100) / 100

const META_PLAIN: Partial<Record<FunnelEvent, true>> = { PageView: true, Contact: true, CompleteRegistration: true }
const GA_NAMES: Record<FunnelEvent, string> = {
  PageView: 'page_view', ViewContent: 'view_item', AddToCart: 'add_to_cart', InitiateCheckout: 'begin_checkout',
  Search: 'search', Contact: 'generate_lead', CompleteRegistration: 'sign_up',
}

function browserFire(event: FunnelEvent, id: string, d: AdEventData) {
  if (!cfg || cfg.browser_events === false) return
  if (event === 'Search') {
    try { window.fbq?.('track', 'Search', { search_string: d.search }, { eventID: id }) } catch { /* ignore */ }
    try { window.ttq?.track('Search', { query: d.search }, { event_id: id }) } catch { /* ignore */ }
    try { if (cfg.ga4_id) window.gtag?.('event', 'search', { send_to: cfg.ga4_id, search_term: d.search }) } catch { /* ignore */ }
    return
  }
  const contents = d.contents ?? []
  const value = d.value === undefined ? undefined : round2(d.value)
  try {
    window.fbq?.('track', event, META_PLAIN[event] ? {} : {
      content_type: 'product', content_ids: contents.map((c) => c.id), value, currency: d.currency,
      ...(contents.length > 1 || event === 'InitiateCheckout' ? { num_items: contents.reduce((n, c) => n + c.quantity, 0) } : { content_name: contents[0]?.name }),
    }, { eventID: id })
  } catch { /* ignore */ }
  try {
    // TikTok's page() counts the page view itself (the server skips TikTok page views).
    if (event === 'PageView') window.ttq?.page()
    else if (event === 'Contact' || event === 'CompleteRegistration') window.ttq?.track(event, {}, { event_id: id })
    else window.ttq?.track(event, {
      content_type: 'product', value, currency: d.currency,
      contents: contents.map((c) => ({ content_id: c.id, content_name: c.name, quantity: c.quantity, price: round2(c.price) })),
    }, { event_id: id })
  } catch { /* ignore */ }
  try {
    const items = contents.map((c) => ({ item_id: c.id, item_name: c.name, quantity: c.quantity, price: round2(c.price) }))
    const ga = GA_NAMES[event]
    if (cfg.ga4_id) window.gtag?.('event', ga, META_PLAIN[event] ? { send_to: cfg.ga4_id } : { send_to: cfg.ga4_id, currency: d.currency, value, items })
  } catch { /* ignore */ }
}

async function serverCopy(event: FunnelEvent, id: string, d: AdEventData) {
  if (!cfg || cfg.server_events === false || (!cfg.meta_pixel && !cfg.tiktok_pixel)) return
  const click = lastClickIds()
  // GA's client id only goes with the order (Google gets the purchase only).
  const browser = browserIds()
  delete browser.ga
  const body = {
    action: 'track', event, event_id: id, url: location.href.split('#')[0].slice(0, 500), visitor_id: visitorId(),
    value: d.value === undefined ? undefined : round2(d.value), currency: d.currency,
    contents: d.contents?.slice(0, 50).map((c) => ({ id: c.id.slice(0, 64), name: c.name?.slice(0, 120), quantity: c.quantity, price: round2(c.price) })),
    browser,
    click: Object.fromEntries(Object.entries({ fbclid: click.fbclid, ttclid: click.ttclid }).filter(([, v]) => v && CLICK.test(v))),
    search: event === 'Search' ? d.search?.slice(0, 100) : undefined,
    user: matching() && Object.keys(shopperHashes()).length ? shopperHashes() : undefined,
  }
  try {
    await merchantFetch(functionsUrl('checkout'), {
      method: 'POST', keepalive: true,
      headers: { ...(await functionHeaders()), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch {
    /* tracking never gets in the shopper's way */
  }
}

// --- one event per real action -------------------------------------------------------------------
// The pixel and the server copy share one event id, so the platforms count them once. What must not
// happen is the same action fired twice with two ids (a page drawn twice, a reload of the checkout,
// a double tap): each event has a key and a window, kept for the visit (sessionStorage).

const ONCE_KEY = storeKey('ff_ev_once')
const MIN = 60_000
function onceRule(event: FunnelEvent, d: AdEventData): [string, number] | null {
  const ids = (d.contents ?? []).map((c) => `${c.id}x${c.quantity}`).sort().join(',')
  switch (event) {
    case 'PageView': return [`pv:${location.pathname}`, 3_000]
    case 'ViewContent': return [`vc:${d.contents?.[0]?.id ?? location.pathname}`, MIN]
    case 'AddToCart': return [`ac:${ids}`, 2_000]
    case 'InitiateCheckout': return [`ic:${ids}`, 30 * MIN]
    case 'Search': return [`se:${(d.search ?? '').trim().toLowerCase()}`, MIN]
    case 'Contact': return ['ct', MIN]
    case 'CompleteRegistration': return ['cr', 30 * MIN]
  }
}

/** False when this same action was already sent within its window. */
export function firstTime(key: string, windowMs: number, now = Date.now()): boolean {
  let seen: Record<string, number> = {}
  try { seen = JSON.parse(sessionStorage.getItem(ONCE_KEY) ?? '{}') ?? {} } catch { seen = {} }
  for (const [k, t] of Object.entries(seen)) if (typeof t !== 'number' || now - t > 60 * MIN) delete seen[k]
  if (typeof seen[key] === 'number' && now - seen[key] < windowMs) return false
  seen[key] = now
  try { sessionStorage.setItem(ONCE_KEY, JSON.stringify(seen)) } catch { /* private mode: no memory */ }
  return true
}

/** A funnel event: the pixel and the server copy, one event id. */
export function adEvent(event: FunnelEvent, data: AdEventData = {}) {
  if (typeof window === 'undefined') return
  const rule = onceRule(event, data)
  if (rule && !firstTime(rule[0], rule[1])) return
  whenReady(() => {
    if (!cfg) return
    const id = eventId(event)
    browserFire(event, id, data)
    void serverCopy(event, id, data)
  })
}

/** The Purchase on the pixels, with the order's own event id (the server sends its copy from the order). */
export function adPurchase(p: AdPurchase | null | undefined) {
  if (!p || typeof window === 'undefined') return
  // One order, one browser Purchase (the server sends its copy once per order, by the same id).
  try {
    const sent = JSON.parse(localStorage.getItem(storeKey('ff_pu_sent')) ?? '[]') as string[]
    if (Array.isArray(sent) && sent.includes(p.event_id)) return
    localStorage.setItem(storeKey('ff_pu_sent'), JSON.stringify([...(Array.isArray(sent) ? sent : []), p.event_id].slice(-30)))
  } catch { /* no storage: still once per page */ }
  whenReady(() => {
    if (!cfg || cfg.browser_events === false) return
    const contents = p.contents ?? []
    const value = round2(p.value)
    try {
      window.fbq?.('track', 'Purchase', {
        value, currency: p.currency, content_type: 'product', content_ids: contents.map((c) => c.id),
        contents: contents.map((c) => ({ id: c.id, quantity: c.quantity, item_price: round2(c.price) })), order_id: p.order_id,
        num_items: contents.reduce((n, c) => n + c.quantity, 0),
      }, { eventID: p.event_id })
    } catch { /* ignore */ }
    try {
      if (window.ttq && p.matching && (p.matching.em || p.matching.ph_e164)) {
        window.ttq.identify(Object.fromEntries(Object.entries({ email: p.matching.em, phone_number: p.matching.ph_e164 }).filter(([, v]) => v)))
      }
      window.ttq?.track('CompletePayment', {
        value, currency: p.currency, content_type: 'product', order_id: p.order_id,
        contents: contents.map((c) => ({ content_id: c.id, content_name: c.name, quantity: c.quantity, price: round2(c.price) })),
      }, { event_id: p.event_id })
    } catch { /* ignore */ }
    try {
      if (window.gtag && p.matching && (p.matching.em || p.matching.ph_e164)) {
        window.gtag('set', 'user_data', Object.fromEntries(Object.entries({ sha256_email_address: p.matching.em, sha256_phone_number: p.matching.ph_e164 }).filter(([, v]) => v)))
      }
      const items = contents.map((c) => ({ item_id: c.id, item_name: c.name, quantity: c.quantity, price: round2(c.price) }))
      if (cfg.ga4_id) window.gtag?.('event', 'purchase', { send_to: cfg.ga4_id, transaction_id: p.order_id, value, currency: p.currency, items })
      if (cfg.ads_id && cfg.ads_label) {
        window.gtag?.('event', 'conversion', { send_to: `${cfg.ads_id}/${cfg.ads_label}`, value, currency: p.currency, transaction_id: p.order_id })
      }
    } catch { /* ignore */ }
  })
}

/** For tests: forget the loaded settings. */
export function resetAdPixelsForTest() {
  cfg = null
  ready = false
  waiting.length = 0
}
