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
import { functionHeaders } from '@/lib/functions'
import { functionsUrl } from '@/lib/env'
import { lastClickIds, visitorId } from '@/lib/attribution'
import { merchantFetch } from '@/lib/merchant'
import type { AdLine, AdPurchase, StoreAdConfig } from '@/services/storefront'

export type { AdLine, AdPurchase, StoreAdConfig }

export interface AdEventData { value?: number; currency?: string; contents?: AdLine[] }
export type FunnelEvent = 'PageView' | 'ViewContent' | 'AddToCart' | 'InitiateCheckout'

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

const CODES: Record<FunnelEvent, string> = { PageView: 'pv', ViewContent: 'vc', AddToCart: 'ac', InitiateCheckout: 'ic' }
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

/** The browser's own ad ids (Meta _fbp/_fbc, TikTok _ttp, GA client id), for the server-side events. */
export function browserIds(): { fbp?: string; fbc?: string; ttp?: string; ga?: string } {
  if (typeof document === 'undefined') return {}
  const ga = cookie('_ga').split('.').slice(2).join('.')
  const out = { fbp: cookie('_fbp'), fbc: cookie('_fbc'), ttp: cookie('_ttp'), ga }
  return Object.fromEntries(Object.entries(out).filter(([k, v]) => v && { fbp: FBP, fbc: FBC, ttp: TTP, ga: GA }[k]!.test(v)))
}

/** Meta's first-party cookies, as its pixel writes them, so the server copy can match the visit. */
function metaCookies() {
  if (!FBP.test(cookie('_fbp'))) setCookie('_fbp', `fb.1.${Date.now()}.${1_000_000_000 + Math.floor(Math.random() * 9_000_000_000)}`, 90)
  const fbclid = lastClickIds().fbclid
  if (fbclid && CLICK.test(fbclid) && cookie('_fbc').split('.').slice(3).join('.') !== fbclid) setCookie('_fbc', `fb.1.${Date.now()}.${fbclid}`, 90)
}

async function sha256(value: string): Promise<string> {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return ''
  }
}

function addScript(src: string) {
  const s = document.createElement('script')
  s.async = true
  s.src = src
  document.head.appendChild(s)
}

// The platforms' standard loader stubs: calls made before the script arrives are queued.
function loadMeta(pixel: string, externalId: string) {
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
  window.fbq('init', pixel, externalId ? { external_id: externalId } : {})
}

function loadTikTok(pixel: string, externalId: string) {
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
  if (externalId) window.ttq!.identify({ external_id: externalId })
}

function loadGoogle(c: StoreAdConfig) {
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
}

/** Loads the pixels the store turned on. Called once the settings arrive. */
export async function startAdPixels(c: StoreAdConfig | null | undefined) {
  if (ready || !c) return
  cfg = c.enabled ? c : null
  if (cfg && cfg.browser_events !== false) {
    try {
      if (cfg.meta_pixel) metaCookies()
      const ext = await sha256(visitorId())
      if (cfg.meta_pixel) loadMeta(cfg.meta_pixel, ext)
      if (cfg.tiktok_pixel) loadTikTok(cfg.tiktok_pixel, ext)
      if (cfg.ga4_id || cfg.ads_id) loadGoogle(cfg)
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

function browserFire(event: FunnelEvent, id: string, d: AdEventData) {
  if (!cfg || cfg.browser_events === false) return
  const contents = d.contents ?? []
  const value = d.value === undefined ? undefined : round2(d.value)
  try {
    window.fbq?.('track', event, event === 'PageView' ? {} : {
      content_type: 'product', content_ids: contents.map((c) => c.id), value, currency: d.currency,
      ...(contents.length > 1 || event === 'InitiateCheckout' ? { num_items: contents.reduce((n, c) => n + c.quantity, 0) } : { content_name: contents[0]?.name }),
    }, { eventID: id })
  } catch { /* ignore */ }
  try {
    // TikTok's page() counts the page view itself (the server skips TikTok page views).
    if (event === 'PageView') window.ttq?.page()
    else window.ttq?.track(event, {
      content_type: 'product', value, currency: d.currency,
      contents: contents.map((c) => ({ content_id: c.id, content_name: c.name, quantity: c.quantity, price: round2(c.price) })),
    }, { event_id: id })
  } catch { /* ignore */ }
  try {
    const items = contents.map((c) => ({ item_id: c.id, item_name: c.name, quantity: c.quantity, price: round2(c.price) }))
    const ga = { PageView: 'page_view', ViewContent: 'view_item', AddToCart: 'add_to_cart', InitiateCheckout: 'begin_checkout' }[event]
    if (cfg.ga4_id) window.gtag?.('event', ga, event === 'PageView' ? { send_to: cfg.ga4_id } : { send_to: cfg.ga4_id, currency: d.currency, value, items })
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

/** A funnel event: the pixel and the server copy, one event id. */
export function adEvent(event: FunnelEvent, data: AdEventData = {}) {
  if (typeof window === 'undefined') return
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
