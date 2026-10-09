// WooCommerce REST API v3. Two ways in:
//   * one click: the store owner approves on their own WordPress
//     (/wc-auth/v1/authorize) and WooCommerce posts Read/Write API keys to us;
//   * API keys created by hand (WooCommerce → Settings → Advanced → REST API).
// Only HTTPS sites are accepted, so keys never travel in clear text. Webhooks
// carry X-WC-Webhook-Signature (HMAC of the body with a secret we choose).
import { type Check, ChannelError, clean, hmacBase64, money, type NormalizedOrder, safeEqual, touchFrom } from './common.ts'

type FetchFn = typeof fetch

export const WOO_TOPICS = ['order.created', 'order.updated'] as const
/** Order statuses that mean "a real order to ship". */
export const WOO_IMPORT_STATUSES = ['processing', 'on-hold', 'completed']
export const WOO_CANCEL_STATUSES = ['cancelled', 'refunded', 'failed', 'trash']

/** WooCommerce's Bangladesh state codes (ISO 3166-2:BD) → district. */
const BD_STATES: Record<string, string> = {
  'BD-01': 'Bandarban', 'BD-02': 'Barguna', 'BD-03': 'Bogura', 'BD-04': 'Brahmanbaria', 'BD-05': 'Bagerhat', 'BD-06': 'Barishal',
  'BD-07': 'Bhola', 'BD-08': 'Cumilla', 'BD-09': 'Chandpur', 'BD-10': 'Chattogram', 'BD-11': "Cox's Bazar", 'BD-12': 'Chuadanga',
  'BD-13': 'Dhaka', 'BD-14': 'Dinajpur', 'BD-15': 'Faridpur', 'BD-16': 'Feni', 'BD-17': 'Gopalganj', 'BD-18': 'Gazipur',
  'BD-19': 'Gaibandha', 'BD-20': 'Habiganj', 'BD-21': 'Jamalpur', 'BD-22': 'Jashore', 'BD-23': 'Jhenaidah', 'BD-24': 'Joypurhat',
  'BD-25': 'Jhalokathi', 'BD-26': 'Kishoreganj', 'BD-27': 'Khulna', 'BD-28': 'Kurigram', 'BD-29': 'Khagrachhari', 'BD-30': 'Kushtia',
  'BD-31': 'Lakshmipur', 'BD-32': 'Lalmonirhat', 'BD-33': 'Manikganj', 'BD-34': 'Mymensingh', 'BD-35': 'Munshiganj', 'BD-36': 'Madaripur',
  'BD-37': 'Magura', 'BD-38': 'Moulvibazar', 'BD-39': 'Meherpur', 'BD-40': 'Narayanganj', 'BD-41': 'Netrokona', 'BD-42': 'Narsingdi',
  'BD-43': 'Narail', 'BD-44': 'Natore', 'BD-45': 'Chapainawabganj', 'BD-46': 'Nilphamari', 'BD-47': 'Noakhali', 'BD-48': 'Naogaon',
  'BD-49': 'Pabna', 'BD-50': 'Pirojpur', 'BD-51': 'Patuakhali', 'BD-52': 'Panchagarh', 'BD-53': 'Rajbari', 'BD-54': 'Rajshahi',
  'BD-55': 'Rangpur', 'BD-56': 'Rangamati', 'BD-57': 'Sherpur', 'BD-58': 'Satkhira', 'BD-59': 'Sirajganj', 'BD-60': 'Sylhet',
  'BD-61': 'Sunamganj', 'BD-62': 'Shariatpur', 'BD-63': 'Tangail', 'BD-64': 'Thakurgaon',
}

/** "shop.com", "https://shop.com/" → "https://shop.com" (null when not a usable HTTPS address). */
export function siteUrl(input: string): string | null {
  let v = input.trim()
  if (!/^[a-z]+:\/\//i.test(v)) v = `https://${v}`
  try {
    const u = new URL(v)
    if (u.protocol !== 'https:' || !u.hostname.includes('.') || u.username || u.password) return null
    return `${u.origin}${u.pathname.replace(/\/+$/, '').replace(/\/wp-admin.*$/, '')}`
  } catch {
    return null
  }
}

export function wooAuthUrl(site: string, appName: string, state: string, returnUrl: string, callbackUrl: string): string {
  const q = new URLSearchParams({ app_name: appName, scope: 'read_write', user_id: state, return_url: returnUrl, callback_url: callbackUrl })
  return `${site}/wc-auth/v1/authorize?${q.toString()}`
}

export async function verifyWooWebhook(rawBody: string, header: string | null, secret: string): Promise<boolean> {
  return !!header && safeEqual(await hmacBase64(secret, rawBody), header)
}

export class WooClient {
  private useQueryAuth = false
  constructor(readonly site: string, private readonly key: string, private readonly secret: string, private readonly fetchFn: FetchFn = fetch) {}

  private async call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, query: Record<string, string> = {}): Promise<T> {
    const send = async (queryAuth: boolean) => {
      const url = new URL(`${this.site}/wp-json/wc/v3/${path.replace(/^\/+/, '')}`)
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
      const headers: Record<string, string> = { Accept: 'application/json' }
      if (queryAuth) {
        // Some hosts drop the Authorization header; WooCommerce accepts the keys as parameters over HTTPS.
        url.searchParams.set('consumer_key', this.key)
        url.searchParams.set('consumer_secret', this.secret)
      } else {
        headers.Authorization = `Basic ${btoa(`${this.key}:${this.secret}`)}`
      }
      if (body !== undefined) headers['Content-Type'] = 'application/json'
      try {
        return await this.fetchFn(url.toString(), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30_000), redirect: 'follow' })
      } catch (error) {
        throw new ChannelError((error as Error).name === 'TimeoutError' ? `${new URL(this.site).hostname} did not answer in time` : `Could not reach ${new URL(this.site).hostname}`)
      }
    }
    let res = await send(this.useQueryAuth)
    if (res.status === 401 && !this.useQueryAuth) {
      const retry = await send(true)
      if (retry.status !== 401) { this.useQueryAuth = true; res = retry }
    }
    const text = await res.text()
    let json: unknown = null
    try { json = text ? JSON.parse(text) : null } catch { json = null }
    if (!res.ok) {
      const msg = (json as { message?: string; code?: string } | null)
      if (res.status === 401 || res.status === 403) throw new ChannelError(`WooCommerce rejected the API keys${msg?.message ? `: ${msg.message}` : ''}`, res.status, msg?.code ?? 'UNAUTHORIZED')
      if (res.status === 404 && !msg?.code) throw new ChannelError('The WooCommerce REST API was not found. In WordPress → Settings → Permalinks choose any option except "Plain".', 404, 'NO_API')
      throw new ChannelError(`WooCommerce: ${msg?.message ?? `HTTP ${res.status}`}`, res.status, msg?.code)
    }
    if (json === null && text) throw new ChannelError('The site answered with a web page instead of the API — a security plugin or firewall may be blocking it', res.status, 'NOT_JSON')
    return json as T
  }

  async order(id: string | number): Promise<WooOrder> {
    return this.call<WooOrder>('GET', `orders/${encodeURIComponent(String(id))}`)
  }

  /** Orders created since a date, newest first, up to `max`. */
  async ordersSince(sinceIso: string, max = 250): Promise<WooOrder[]> {
    const out: WooOrder[] = []
    for (let page = 1; out.length < max && page <= 10; page++) {
      const batch = await this.call<WooOrder[]>('GET', 'orders', undefined, { after: sinceIso, per_page: '50', page: String(page), orderby: 'date', order: 'desc' })
      out.push(...batch)
      if (batch.length < 50) break
    }
    return out.slice(0, max)
  }

  async webhooks(): Promise<Array<{ id: number; topic: string; delivery_url: string; status: string }>> {
    return this.call('GET', 'webhooks', undefined, { per_page: '100' })
  }

  async ensureWebhooks(url: string, secret: string): Promise<Array<{ id: number; topic: string }>> {
    const existing = (await this.webhooks()).filter((w) => w.delivery_url === url)
    const out: Array<{ id: number; topic: string }> = []
    for (const topic of WOO_TOPICS) {
      const have = existing.find((w) => w.topic === topic)
      if (have) {
        // Keep the secret in step with ours and make sure it is switched on.
        await this.call('PUT', `webhooks/${have.id}`, { secret, status: 'active' })
        out.push({ id: have.id, topic }); continue
      }
      const made = await this.call<{ id: number }>('POST', 'webhooks', { name: `Orders → OMS (${topic})`, topic, delivery_url: url, secret, status: 'active' })
      out.push({ id: made.id, topic })
    }
    return out
  }

  async removeWebhooks(ids: number[]): Promise<void> {
    for (const id of ids) await this.call('DELETE', `webhooks/${id}`, undefined, { force: 'true' }).catch(() => undefined)
  }

  async test(webhookUrl: string): Promise<{ checks: Check[]; currency: string | null; name: string | null }> {
    const checks: Check[] = [{ key: 'https', label: 'Secure address', status: 'ok', detail: this.site }]
    let latest: WooOrder | undefined
    try {
      latest = (await this.call<WooOrder[]>('GET', 'orders', undefined, { per_page: '1' }))[0]
      checks.push({ key: 'api', label: 'API keys work', status: 'ok', detail: 'Orders can be read' })
    } catch (error) {
      checks.push({ key: 'api', label: 'API keys work', status: 'fail', detail: (error as Error).message })
      return { checks, currency: null, name: null }
    }
    try {
      const hooks = (await this.webhooks()).filter((w) => w.delivery_url === webhookUrl)
      const need = WOO_TOPICS.filter((t) => !hooks.some((h) => h.topic === t && h.status === 'active'))
      const paused = hooks.filter((h) => h.status !== 'active')
      checks.push(need.length
        ? { key: 'webhooks', label: 'Instant order updates', status: 'fail', detail: paused.length
            ? 'WooCommerce paused the webhooks after failed deliveries — click "Fix webhooks"'
            : `Not set up: ${need.join(', ')} — click "Fix webhooks"` }
        : { key: 'webhooks', label: 'Instant order updates', status: 'ok', detail: 'New and changed orders arrive within seconds' })
    } catch (error) {
      const e = error as ChannelError
      checks.push({ key: 'webhooks', label: 'Instant order updates', status: 'fail', detail: e.unauthorized
        ? 'The keys can read orders but not manage webhooks — create Read/Write keys' : e.message })
    }
    checks.push(!latest
      ? { key: 'customer_data', label: 'Customer details', status: 'warn', detail: 'No orders yet to check — place a test order to confirm phone and address come through' }
      : !(latest.billing?.phone || latest.shipping?.phone)
        ? { key: 'customer_data', label: 'Customer details', status: 'warn', detail: `Order #${latest.number} has no phone number — make phone required at checkout` }
        : { key: 'customer_data', label: 'Customer details', status: 'ok', detail: `Name, phone and address come through (checked #${latest.number})` })
    const currency = latest?.currency ?? null
    checks.push(!currency
      ? { key: 'currency', label: 'Currency', status: 'warn', detail: 'Will show after the first order' }
      : currency === 'BDT'
        ? { key: 'currency', label: 'Currency', status: 'ok', detail: 'BDT' }
        : { key: 'currency', label: 'Currency', status: 'warn', detail: `Store currency is ${currency}; amounts are imported as they are, not converted` })
    return { checks, currency, name: new URL(this.site).hostname }
  }
}

interface WooAddress { first_name?: string; last_name?: string; address_1?: string; address_2?: string; city?: string; state?: string; postcode?: string; country?: string; phone?: string; email?: string }
export interface WooOrder {
  id: number; number: string; status: string; currency: string; date_created_gmt?: string; date_paid_gmt?: string | null
  total: string; shipping_total: string; discount_total: string; payment_method?: string; payment_method_title?: string
  customer_note?: string; billing?: WooAddress; shipping?: WooAddress
  line_items: Array<{ product_id: number; variation_id: number; name: string; quantity: number; subtotal: string; sku?: string; image?: { src?: string } | null; meta_data?: Array<{ display_key?: string; display_value?: string }> }>
  meta_data?: Array<{ key: string; value: unknown }>
}

export function normalizeWooOrder(o: WooOrder): NormalizedOrder {
  const s = o.shipping ?? {}
  const b = o.billing ?? {}
  const a = s.address_1 ? s : b
  const meta = Object.fromEntries((o.meta_data ?? []).filter((m) => typeof m.value === 'string').map((m) => [m.key, m.value as string]))
  const utm: Record<string, string> = {}
  for (const k of ['source', 'medium', 'campaign', 'content', 'term']) if (meta[`_wc_order_attribution_utm_${k}`]) utm[`utm_${k}`] = meta[`_wc_order_attribution_utm_${k}`]
  const touch = touchFrom(meta._wc_order_attribution_session_entry, meta._wc_order_attribution_referrer, meta._wc_order_attribution_session_start_time ?? o.date_created_gmt ?? null, utm)
  const total = money(o.total)
  const paid = o.date_paid_gmt && o.payment_method !== 'cod' && WOO_IMPORT_STATUSES.includes(o.status) ? total : 0
  const state = clean(a.state)
  return {
    external_id: String(o.id),
    number: o.number ? `#${o.number}` : null,
    created_at: o.date_created_gmt ? `${o.date_created_gmt}Z` : null,
    cancelled: WOO_CANCEL_STATUSES.includes(o.status),
    test: false,
    customer: {
      name: clean([a.first_name, a.last_name].filter(Boolean).join(' ')) ?? clean([b.first_name, b.last_name].filter(Boolean).join(' ')),
      phone: clean(s.phone) ?? clean(b.phone),
      email: clean(b.email),
    },
    shipping: {
      address: clean([a.address_1, a.address_2].filter(Boolean).join(', ')),
      area: null, city: clean(a.city), state, postal_code: clean(a.postcode),
      district_hint: state ? BD_STATES[state.toUpperCase()] ?? state : clean(a.city),
    },
    lines: o.line_items.map((l) => ({
      external_variant_id: String(l.variation_id || l.product_id || '') || null,
      external_product_id: l.product_id ? String(l.product_id) : null,
      sku: clean(l.sku),
      title: l.name,
      variant_title: clean((l.meta_data ?? []).filter((m) => m.display_key && !m.display_key.startsWith('_')).map((m) => m.display_value).join(' / ')),
      quantity: l.quantity,
      unit_price: l.quantity > 0 ? money(money(l.subtotal) / l.quantity) : 0,
      image_url: l.image?.src ?? null,
    })),
    shipping_price: money(o.shipping_total),
    discount_total: money(o.discount_total),
    total,
    paid_amount: paid,
    currency: o.currency ?? null,
    gateway: clean(o.payment_method_title),
    note: clean(o.customer_note),
    attribution: touch ? { first_touch: touch, last_touch: touch } : null,
  }
}
