// Shared pieces for the sales-channel integrations (Shopify, WooCommerce).

/** One line of a connection test, shown to staff as a checklist. */
export interface Check {
  key: string
  label: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
}

export interface Touch { at: string | null; landing: string | null; referrer: string | null; params: Record<string, string> }

/** The order in one shape, whichever store it came from (see channel_ingest_order). */
export interface NormalizedOrder {
  external_id: string
  number: string | null
  created_at: string | null
  cancelled: boolean
  test: boolean
  customer: { name: string | null; phone: string | null; email: string | null }
  shipping: { address: string | null; area: string | null; city: string | null; state: string | null; postal_code: string | null; district_hint: string | null }
  lines: Array<{
    external_variant_id: string | null; external_product_id: string | null; sku: string | null; title: string
    variant_title: string | null; quantity: number; unit_price: number; image_url: string | null
  }>
  shipping_price: number
  discount_total: number
  total: number
  paid_amount: number
  currency: string | null
  gateway: string | null
  note: string | null
  attribution: { first_touch: Touch | null; last_touch: Touch | null } | null
  /** Fulfilments the store already made (Shopify), to record ones made by hand. */
  fulfillments?: SeenFulfillment[]
}

/** A fulfilment as the store reports it (webhook or API). */
export interface SeenFulfillment {
  id: string
  status: string | null
  display_status: string | null
  tracking_company: string | null
  tracking_number: string | null
  tracking_url: string | null
  created_at: string | null
  /** Nothing left to fulfil on the order. */
  all_fulfilled: boolean
}

export class ChannelError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message)
  }
  /** The store rejected our credentials: connect again. */
  get unauthorized(): boolean {
    return this.status === 401 || this.status === 403
  }
}

const enc = new TextEncoder()

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)))
}

export async function hmacBase64(secret: string, message: string): Promise<string> {
  return btoa(String.fromCharCode(...await hmac(secret, message)))
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  return Array.from(await hmac(secret, message), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Constant-time comparison, so a signature can't be guessed byte by byte. */
export function safeEqual(a: string, b: string): boolean {
  const x = enc.encode(a)
  const y = enc.encode(b)
  let diff = x.length ^ y.length
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export const money = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number.parseFloat(String(v ?? ''))
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

export const clean = (v: unknown): string | null => {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v === null || v === undefined ? '' : String(v).trim()
  return s === '' ? null : s
}

/** Landing page → a touch for record_order_attribution (only what the store passed on). */
export function touchFrom(landing: string | null | undefined, referrer: string | null | undefined, at: string | null | undefined, extra: Record<string, string> = {}): Touch | null {
  const params: Record<string, string> = {}
  let path: string | null = null
  if (landing) {
    try {
      const url = new URL(landing, 'https://store.invalid')
      path = url.pathname + (url.search || '')
      url.searchParams.forEach((v, k) => { if (v && k.length <= 40) params[k.toLowerCase()] = v.slice(0, 200) })
    } catch { path = landing.slice(0, 300) }
  }
  for (const [k, v] of Object.entries(extra)) if (v) params[k] = v.slice(0, 200)
  if (!path && !referrer && Object.keys(params).length === 0) return null
  return { at: at ?? null, landing: path, referrer: clean(referrer), params }
}
