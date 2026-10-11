// Fullfilio Connect (the WooCommerce plugin): what it sends us and how it is checked.
//
// Every request is signed with the store's plugin secret (kept in Vault with
// the store's API keys): X-FFC-Signature = base64(HMAC-SHA256(secret, "<ts>.<body>")).
// Requests more than five minutes old are refused, and each event carries an
// id that is the same on every retry, so a repeat is recognised and skipped.
import { z } from 'zod'
import { clean, hmacBase64, money, safeEqual, type Touch, touchFrom } from './common.ts'

export const PLUGIN_SKEW_SECONDS = 300
export const PLUGIN_SLUG = 'fullfilio-connect'

export type PluginCheck = { ok: true } | { ok: false; reason: 'MISSING' | 'STALE' | 'SIGNATURE' }

export async function verifyPluginRequest(raw: string, headers: Headers, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<PluginCheck> {
  const ts = headers.get('x-ffc-timestamp') ?? ''
  const sig = headers.get('x-ffc-signature') ?? ''
  if (!/^\d{9,12}$/.test(ts) || !sig) return { ok: false, reason: 'MISSING' }
  if (Math.abs(nowSeconds - Number(ts)) > PLUGIN_SKEW_SECONDS) return { ok: false, reason: 'STALE' }
  return safeEqual(await hmacBase64(secret, `${ts}.${raw}`), sig) ? { ok: true } : { ok: false, reason: 'SIGNATURE' }
}

/** For tests and tools: the headers the plugin sends. */
export async function signPluginRequest(raw: string, secret: string, type: string, eventId: string, nowSeconds = Math.floor(Date.now() / 1000)) {
  const ts = String(nowSeconds)
  return {
    'Content-Type': 'application/json', 'X-FFC-Event': type, 'X-FFC-Event-Id': eventId, 'X-FFC-Timestamp': ts,
    'X-FFC-Signature': await hmacBase64(secret, `${ts}.${raw}`), 'X-FFC-Version': 'test',
  }
}

/**
 * The connection code shown to staff when we cannot reach the store to connect
 * the plugin ourselves: "ffc1." + base64url({e: endpoint, c: channel id, s: secret, n: app name}).
 */
export function connectionCode(endpoint: string, channelId: string, secret: string, appName: string): string {
  const json = JSON.stringify({ e: endpoint, c: channelId, s: secret, n: appName })
  return `ffc1.${btoa(json).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`
}

// --- events -----------------------------------------------------------------------------------

const touchSchema = z.object({
  at: z.string().max(40).nullable().optional(),
  landing: z.string().max(400).nullable().optional(),
  referrer: z.string().max(400).nullable().optional(),
  // PHP sends an empty map as [] (plugin 1.0.0 did); read that as no parameters.
  params: z.preprocess((v) => (Array.isArray(v) && v.length === 0 ? {} : v), z.record(z.string().max(40), z.string().max(300))).optional(),
}).nullable().optional()

export const pluginAttributionSchema = z.object({
  first_touch: touchSchema,
  last_touch: touchSchema,
  fbp: z.string().max(200).nullable().optional(),
  fbc: z.string().max(200).nullable().optional(),
  ip: z.string().max(64).nullable().optional(),
  user_agent: z.string().max(400).nullable().optional(),
}).partial()

export const leadSchema = z.object({
  id: z.string().regex(/^ffc-[0-9a-f-]{36}$/),
  phone: z.string().max(30),
  name: z.string().max(130).optional().default(''),
  email: z.string().max(160).optional().default(''),
  address: z.string().max(310).optional().default(''),
  city: z.string().max(80).optional().default(''),
  state: z.string().max(40).optional().default(''),
  postcode: z.string().max(20).optional().default(''),
  country: z.string().max(2).optional().default(''),
  note: z.string().max(300).optional().default(''),
  items: z.array(z.object({
    product_id: z.number().int().nonnegative(), variation_id: z.number().int().nonnegative().optional().default(0),
    title: z.string().max(300), sku: z.string().max(100).nullable().optional(), quantity: z.number().int().min(1).max(10000),
    price: z.number().nonnegative().max(1e9).optional().default(0), line_total: z.number().nonnegative().max(1e10).optional().default(0),
  })).max(50),
  subtotal: z.number().nonnegative().max(1e10).optional().default(0),
  shipping: z.number().nonnegative().max(1e9).optional().default(0),
  total: z.number().nonnegative().max(1e10),
  currency: z.string().max(3).optional().default(''),
  created_at: z.string().max(40).nullable().optional(),
  updated_at: z.string().max(40).nullable().optional(),
  checkout_url: z.string().max(500).optional().default(''),
  attribution: pluginAttributionSchema.nullable().optional(),
})
export type PluginLead = z.infer<typeof leadSchema>

export const pluginEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('heartbeat'), data: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal('lead'), data: leadSchema }),
  z.object({ type: z.literal('lead_completed'), data: z.object({ id: z.string().regex(/^ffc-[0-9a-f-]{36}$/), order_id: z.number().int().positive(), completed_at: z.string().max(40).optional() }) }),
  z.object({ type: z.literal('order'), data: z.object({ order_id: z.number().int().positive(), event: z.enum(['created', 'status']), status: z.string().max(40), from: z.string().max(40).optional(), number: z.string().max(40).optional() }) }),
  z.object({ type: z.literal('checkout_check'), data: z.object({
    phone: z.string().max(30), total: z.number().nonnegative().max(1e10), payment_method: z.string().max(60).optional().default(''),
    address: z.string().max(400).optional().default(''), ip: z.string().max(64).optional().default(''),
  }) }),
])
export type PluginEvent = z.infer<typeof pluginEventSchema>

/** A plugin touch in our shape (landing reduced to its path; click ids and UTM tags kept). */
function touch(t: z.infer<typeof touchSchema>): Touch | null {
  if (!t) return null
  const params: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.params ?? {})) if (/^[a-z_]{2,30}$/.test(k) && v) params[k] = v.slice(0, 200)
  return touchFrom(t.landing ?? null, t.referrer ?? null, t.at ?? null, params)
}

/** Order meta "_ffc_attribution" (JSON written by the plugin at checkout) → our attribution. */
export function pluginAttribution(meta: unknown): { first_touch: Touch | null; last_touch: Touch | null } | null {
  let value: unknown = meta
  if (typeof meta === 'string') {
    try { value = JSON.parse(meta) } catch { return null }
  }
  const parsed = pluginAttributionSchema.safeParse(value)
  if (!parsed.success) return null
  const first = touch(parsed.data.first_touch)
  const last = touch(parsed.data.last_touch) ?? first
  // Meta's click cookie carries the click id when the URL tag was lost on the way.
  if (last && parsed.data.fbc && !last.params.fbclid) {
    const m = /^fb\.\d\.\d+\.(.+)$/.exec(parsed.data.fbc)
    if (m) last.params.fbclid = m[1].slice(0, 200)
  }
  return first || last ? { first_touch: first ?? last, last_touch: last } : null
}

/** An unfinished checkout → a row for channel_abandoned_upsert (same table as Shopify's). */
export function leadToAbandoned(l: PluginLead) {
  const name = clean(l.name)
  return {
    id: l.id,
    legacy_id: null,
    name: `Checkout ${l.id.slice(4, 12)}`,
    recovery_url: clean(l.checkout_url),
    customer_name: name,
    email: clean(l.email),
    phone: clean(l.phone),
    address: clean(l.address),
    city: clean(l.city),
    province: clean(l.state),
    country: clean(l.country),
    items: l.items.map((i) => ({
      title: i.title, variant: null, sku: clean(i.sku), quantity: i.quantity, price: money(i.price), image: null,
      external_variant_id: String(i.variation_id || i.product_id),
    })),
    item_count: l.items.reduce((n, i) => n + i.quantity, 0),
    subtotal: money(l.subtotal),
    total: money(l.total),
    currency: clean(l.currency)?.toUpperCase() ?? null,
    created_at: l.created_at ?? l.updated_at ?? new Date().toISOString(),
    updated_at: l.updated_at ?? new Date().toISOString(),
    completed_at: null,
  }
}
