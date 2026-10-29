// The Meta pixel on the Fullfilio website (fullfilio.com): its pages and the sign-up. Never the
// admin, the Super Admin or a store (a store has its own: features/storefront/ad-pixels.ts).
//
// Every event goes out twice with one event id: from the browser (fbq) and from our own server
// (POST /__site/event, worker/site-events.ts, Conversions API). Meta counts it once, and still
// gets it when an ad blocker or the browser stops the pixel. Nothing loads before SITE_META_PIXEL
// is set, or anywhere but the live address (not staging, a preview or a laptop).
//
// A new account's e-mail, phone and name leave the browser only as SHA-256 hashes (advanced
// matching), to the pixel and to our server alike. Nothing about the visitor is kept here.
import { lastClickIds } from '@/lib/attribution'
import { SITE_EVENT_CODES, SITE_EVENT_PATH, SITE_META_PIXEL, SITE_ORIGIN, type SiteEvent } from './site-meta'
import { bdMobileIntl } from '../../../supabase/functions/_shared/phone.ts'

export type { SiteEvent }
export interface SiteEventData { content_name?: string; value?: number; currency?: 'BDT' }
export interface SitePerson { email?: string | null; phone?: string | null; name?: string | null }
/** What goes to Meta about a person: SHA-256 hex only. */
export interface SiteMatching { em?: string; ph?: string; fn?: string; ln?: string }

const ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const FBP = /^fb\.\d\.\d{10,13}\.\d{1,25}$/

export function siteEventId(event: SiteEvent): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20))
  return `ffw_${SITE_EVENT_CODES[event]}_${Array.from(bytes, (b) => ABC[b % ABC.length]).join('')}`
}

async function sha256(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 8801XXXXXXXXX for a Bangladeshi mobile number (how Meta wants it before hashing), else ''. */
export const phoneDigits = (phone: string): string => bdMobileIntl(phone)

const nameKey = (v: string) => v.toLowerCase().normalize('NFKD').replace(/[^\p{L}]/gu, '')

/** The person's details, normalised the way Meta asks and hashed; empty values are left out. */
export async function hashSitePerson(p: SitePerson): Promise<SiteMatching> {
  const out: SiteMatching = {}
  const email = String(p.email ?? '').trim().toLowerCase()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) out.em = await sha256(email)
  const ph = phoneDigits(String(p.phone ?? ''))
  if (ph) out.ph = await sha256(ph)
  const parts = String(p.name ?? '').trim().split(/\s+/).map(nameKey).filter(Boolean)
  if (parts.length) out.fn = await sha256(parts[0])
  if (parts.length > 1) out.ln = await sha256(parts[parts.length - 1])
  return out
}

function cookie(name: string): string {
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  try { return m ? decodeURIComponent(m[1]) : '' } catch { return '' }
}

// The website's own anonymous id (security audit run 6). Stores opened by /s/<name> share this
// host's storage and cookies, so the website never uses theirs (attribution.ts visitorId, the
// ff_vid cookie): a name of its own that no store key uses.
const SITE_VID = 'ffw_vid'
const VID = /^[A-Za-z0-9_-]{8,64}$/

function siteVisitorId(): string {
  const fresh = () => crypto.randomUUID().replace(/-/g, '')
  try {
    const v = localStorage.getItem(SITE_VID)
    if (v && VID.test(v)) return v
    const id = fresh()
    localStorage.setItem(SITE_VID, id)
    return id
  } catch {
    return fresh()
  }
}

const live = () => !!SITE_META_PIXEL && typeof window !== 'undefined' && window.location.origin === SITE_ORIGIN

let loading: Promise<string> | null = null

/** Loads the pixel once (Meta's own loader stub) and resolves to the visitor's hashed id. */
function loadPixel(): Promise<string> {
  loading ??= (async () => {
    const ext = await sha256(siteVisitorId())
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
      const s = document.createElement('script')
      s.async = true
      s.src = 'https://connect.facebook.net/en_US/fbevents.js'
      document.head.appendChild(s)
    }
    // The pages change without a reload: only the page views sent here count (none of Meta's own
    // on history changes, which would also follow the visitor into the admin), and Meta does not
    // read the page's buttons and text by itself.
    ;(window.fbq as unknown as { disablePushState?: boolean }).disablePushState = true
    window.fbq('set', 'autoConfig', false, SITE_META_PIXEL)
    window.fbq('init', SITE_META_PIXEL, { external_id: ext })
    return ext
  })()
  return loading
}

function post(body: unknown) {
  const json = JSON.stringify(body)
  try {
    if (navigator.sendBeacon?.(SITE_EVENT_PATH, new Blob([json], { type: 'application/json' }))) return
  } catch { /* fall back to fetch */ }
  void fetch(SITE_EVENT_PATH, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: json, keepalive: true }).catch(() => undefined)
}

/**
 * A new account whose store is open: CompleteRegistration, and StartTrial (every plan starts with
 * a trial), with the plan's name and monthly price.
 */
export function trackSignup(plan: { name: string; price: number } | undefined, person: SitePerson) {
  const data: SiteEventData = plan ? { content_name: plan.name, value: Number(plan.price) || 0, currency: 'BDT' } : {}
  trackSite('CompleteRegistration', data, person)
  trackSite('StartTrial', data, person)
}

/** Sends one event from the browser and from our server. Never throws, never waits. */
export function trackSite(event: SiteEvent, data: SiteEventData = {}, person?: SitePerson) {
  if (!live()) return
  void (async () => {
    try {
      const ext = await loadPixel()
      const id = siteEventId(event)
      const user = person ? await hashSitePerson(person) : {}
      // Advanced matching from here on: the pixel takes SHA-256 values as they are.
      if (Object.keys(user).length) window.fbq?.('init', SITE_META_PIXEL, { external_id: ext, ...user })
      window.fbq?.('track', event, data, { eventID: id })
      // _fbp is the browser id Meta's own pixel sends from this page anyway. The _fbc click cookie is
      // not sent: on this host a store opened by path may have written it for its own ad. The
      // server builds the click from the website's own fbclid instead.
      const fbp = cookie('_fbp')
      post({
        event, id, url: window.location.href, data, user, external_id: ext,
        fbp: FBP.test(fbp) ? fbp : undefined, fbclid: lastClickIds().fbclid,
      })
    } catch {
      /* a blocked pixel never breaks the website */
    }
  })()
}
