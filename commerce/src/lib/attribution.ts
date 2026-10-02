// Marketing attribution, captured in the browser and kept with the order.
//
// A "touch" is how a visitor arrived: ad / UTM parameters, click IDs (fbclid,
// gclid, ttclid, srsltid…), the referring site and the landing page. We keep:
//   - the FIRST touch (never overwritten, kept for 90 days), and
//   - the LAST non-direct touch (a later direct visit doesn't erase an ad click
//     from within the last 30 days).
// Both travel with the order; the server classifies them (Facebook Ads,
// Organic, Direct, …) — the browser never decides the source on its own.

export interface Touch {
  at: string
  landing: string
  referrer?: string | null
  params: Record<string, string>
}

export interface Attribution {
  visitor_id: string
  session_id: string
  first_touch: Touch | null
  last_touch: Touch | null
}

const TOUCH_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
  'fbclid', 'gclid', 'gbraid', 'wbraid', 'ttclid', 'msclkid', 'srsltid', 'li_fat_id', 'twclid',
  'campaign_id', 'adset_id', 'ad_id', 'campaign_name', 'adset_name', 'ad_name', 'placement', 'site_source_name', 'ref',
] as const

const KEY = 'sf_attr'
const VISITOR_KEY = 'sf_vid'
const SESSION_KEY = 'sf_sess'
const FIRST_TOUCH_DAYS = 90
const LAST_TOUCH_DAYS = 30
const SESSION_MINUTES = 30

interface Stored { first?: Touch; last?: Touch }

function read<T>(key: string): T | null {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null') as T | null
  } catch {
    return null
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full or disabled: attribution degrades to "Unknown", checkout still works */
  }
}

const daysAgo = (iso: string | undefined, days: number) => !iso || Date.now() - new Date(iso).getTime() > days * 86_400_000

function randomId(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

/** A long-lived anonymous id for this browser (no personal data). */
export function visitorId(): string {
  let id = read<string>(VISITOR_KEY)
  if (!id || typeof id !== 'string' || id.length < 8) {
    id = randomId()
    write(VISITOR_KEY, id)
  }
  return id
}

/** A visit: ends after 30 minutes without activity, shared across tabs. */
export function sessionId(now = Date.now()): string {
  const s = read<{ id: string; seen: number }>(SESSION_KEY)
  const id = s && now - s.seen < SESSION_MINUTES * 60_000 ? s.id : randomId()
  write(SESSION_KEY, { id, seen: now })
  return id
}

/** The external site that sent the visitor (same-site referrers don't count). */
export function externalReferrer(referrer: string, host: string): string | null {
  if (!referrer) return null
  try {
    const url = new URL(referrer)
    return url.host === host ? null : `${url.protocol}//${url.host}${url.pathname === '/' ? '' : url.pathname}`
  } catch {
    return null
  }
}

/** Marketing parameters on a URL, trimmed and size-limited. */
export function touchParams(search: string): Record<string, string> {
  const params = new URLSearchParams(search)
  const out: Record<string, string> = {}
  for (const key of TOUCH_PARAMS) {
    const value = params.get(key)?.trim()
    if (value) out[key] = value.slice(0, 200)
  }
  return out
}

/**
 * Records a page visit. Returns true when it counted as a new touch (arrived
 * from an ad, a tagged link or another site) rather than internal navigation.
 */
export function captureTouch(loc: { pathname: string; search: string }, referrer: string, host: string, now = new Date()): boolean {
  const params = touchParams(loc.search)
  const ref = externalReferrer(referrer, host)
  const isCampaign = Object.keys(params).length > 0
  const stored = read<Stored>(KEY) ?? {}
  const landing = `${loc.pathname}${loc.search}`.slice(0, 300)
  const touch: Touch = { at: now.toISOString(), landing, referrer: ref, params }

  if (!isCampaign && !ref) {
    // Direct visit: becomes the first touch only if there is none yet.
    if (!stored.first || daysAgo(stored.first.at, FIRST_TOUCH_DAYS)) {
      write(KEY, { first: touch, last: stored.last && !daysAgo(stored.last.at, LAST_TOUCH_DAYS) ? stored.last : undefined })
      return true
    }
    return false
  }
  // Same tagged URL reloaded within the visit: not a new touch.
  if (stored.last && stored.last.landing === landing && !daysAgo(stored.last.at, 1 / 48)) return false
  write(KEY, {
    first: stored.first && !daysAgo(stored.first.at, FIRST_TOUCH_DAYS) ? stored.first : touch,
    last: touch,
  })
  return true
}

let firstNavigation = true

/**
 * For the storefront router: the browser's referrer only describes how the
 * visitor arrived on the first page; later in-app navigation has none.
 */
export function captureNavigation(loc: { pathname: string; search: string }): boolean {
  const referrer = firstNavigation ? document.referrer : ''
  firstNavigation = false
  return captureTouch(loc, referrer, window.location.host)
}

/** What goes to the server with an order (or an incomplete checkout). */
export function currentAttribution(): Attribution {
  const stored = read<Stored>(KEY) ?? {}
  const last = stored.last && !daysAgo(stored.last.at, LAST_TOUCH_DAYS) ? stored.last : null
  return {
    visitor_id: visitorId(),
    session_id: sessionId(),
    first_touch: stored.first ?? null,
    // No ad, tagged link or referral in the last 30 days: the order counts as direct.
    last_touch: last,
  }
}
