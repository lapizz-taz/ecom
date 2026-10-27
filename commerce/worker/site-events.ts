// POST /__site/event on fullfilio.com: the server copy of a Fullfilio website event
// (src/features/site/site-pixel.ts) for Meta's Conversions API. Same event id as the browser
// pixel, so Meta counts it once; it still arrives when an ad blocker stops the pixel.
//
// Needs the pixel id (SITE_META_PIXEL) and the Worker secret SITE_META_CAPI_TOKEN (Events Manager →
// the dataset → Settings → Conversions API → Generate access token). Without either it does
// nothing. SITE_META_TEST_CODE (optional) sends the events to the Test events tab instead.
//
// Anyone can call this address, as anyone can call the pixel itself: it takes one event from a
// fixed list, from our own pages (Origin), and only hashes for the person (the browser hashed the
// e-mail, phone and name). The visitor's IP and browser come from the request. It always answers
// 204 and never says why an event was dropped.
import { GRAPH, sha256 } from '../supabase/functions/_shared/ads/store-tracking.ts'
import { SITE_EVENT_CODES, SITE_META_PIXEL, type SiteEvent } from '../src/features/site/site-meta.ts'
import { isCanonicalHost, siteOrigin } from './site.ts'

export interface SiteEventsEnv {
  PLATFORM_URL?: string
  SITE_META_CAPI_TOKEN?: string
  SITE_META_TEST_CODE?: string
}

const HEX64 = /^[0-9a-f]{64}$/
const FBP = /^fb\.\d\.\d{10,13}\.\d{1,25}$/
const FBC = /^fb\.\d\.\d{10,13}\.[A-Za-z0-9_.-]{4,550}$/
const CLICK = /^[A-Za-z0-9_.-]{1,500}$/
const MAX_BODY = 4096

const done = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } })

/** The event as Meta's Conversions API takes it, or null when the request is not one of ours. */
export async function siteEventPayload(raw: unknown, req: Request, origin: string, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const event = b.event as SiteEvent
  if (typeof event !== 'string' || !Object.hasOwn(SITE_EVENT_CODES, event)) return null
  if (typeof b.id !== 'string' || !new RegExp(`^ffw_${SITE_EVENT_CODES[event]}_[A-Za-z0-9]{20}$`).test(b.id)) return null
  let page: URL
  try { page = new URL(String(b.url)) } catch { return null }
  if (page.origin !== origin || String(b.url).length > 2000) return null

  const hex = (v: unknown) => (typeof v === 'string' && HEX64.test(v) ? [v] : undefined)
  const u = (b.user && typeof b.user === 'object' ? b.user : {}) as Record<string, unknown>
  const fbp = typeof b.fbp === 'string' && FBP.test(b.fbp) ? b.fbp : undefined
  const fbclid = typeof b.fbclid === 'string' && CLICK.test(b.fbclid) ? b.fbclid : undefined
  const fbc = typeof b.fbc === 'string' && FBC.test(b.fbc) ? b.fbc : fbclid ? `fb.1.${now}.${fbclid}` : undefined
  const ip = req.headers.get('cf-connecting-ip') ?? undefined
  const ua = req.headers.get('user-agent')?.slice(0, 500) || undefined
  const user = Object.fromEntries(Object.entries({
    em: hex(u.em), ph: hex(u.ph), fn: hex(u.fn), ln: hex(u.ln), external_id: hex(b.external_id),
    country: [await sha256('bd')], client_ip_address: ip, client_user_agent: ua, fbp, fbc,
  }).filter(([, v]) => v !== undefined))

  const d = (b.data && typeof b.data === 'object' ? b.data : {}) as Record<string, unknown>
  const value = typeof d.value === 'number' && Number.isFinite(d.value) && d.value >= 0 && d.value < 10_000_000 ? Math.round(d.value * 100) / 100 : undefined
  const custom = Object.fromEntries(Object.entries({
    content_name: typeof d.content_name === 'string' ? d.content_name.slice(0, 100) : undefined,
    value, currency: value !== undefined && d.currency === 'BDT' ? 'BDT' : undefined,
  }).filter(([, v]) => v !== undefined))

  return {
    event_name: event, event_time: Math.floor(now / 1000), event_id: b.id, action_source: 'website',
    event_source_url: page.toString(), user_data: user, ...(Object.keys(custom).length ? { custom_data: custom } : {}),
  }
}

/** The body as text, or null when it is longer than MAX_BODY: reading stops there, the rest is never taken in. */
async function smallBody(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > MAX_BODY) return null
  if (!req.body) return null
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const bytes = new Uint8Array(size)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export async function siteEvent(req: Request, url: URL, env: SiteEventsEnv, fetchFn: typeof fetch = fetch, pixel = SITE_META_PIXEL): Promise<Response> {
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } })
  const origin = siteOrigin(env, url)
  // Only the website itself, from its own pages.
  if (!isCanonicalHost(url, env) || req.headers.get('origin') !== origin) return done()
  if (!pixel || !env.SITE_META_CAPI_TOKEN) return done()
  const text = await smallBody(req)
  if (!text) return done()
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return done() }
  const event = await siteEventPayload(raw, req, origin)
  if (!event) return done()
  try {
    // The token goes in the body, not the address, so it never lands in a request log.
    const res = await fetchFn(`${GRAPH}/${encodeURIComponent(pixel)}/events`, {
      method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: [event], access_token: env.SITE_META_CAPI_TOKEN, ...(env.SITE_META_TEST_CODE ? { test_event_code: env.SITE_META_TEST_CODE } : {}) }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { message?: string } } | null
      console.error('site event: Meta refused it', res.status, String(body?.error?.message ?? '').split(env.SITE_META_CAPI_TOKEN).join('[hidden]').slice(0, 200))
    }
  } catch {
    console.error('site event: could not reach Meta')
  }
  return done()
}
