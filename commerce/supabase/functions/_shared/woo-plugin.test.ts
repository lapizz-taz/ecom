import { describe, expect, it } from 'vitest'
import { normalizeWooOrder, type WooOrder } from './channels/woocommerce'
import { connectionCode, leadSchema, leadToAbandoned, pluginAttribution, pluginEventSchema, signPluginRequest, verifyPluginRequest } from './channels/woo-plugin'

const SECRET = 'a'.repeat(64)
const NOW = 1_800_000_000

describe('plugin request signatures', () => {
  it('accepts a request signed with the store secret', async () => {
    const raw = JSON.stringify({ type: 'heartbeat', data: {} })
    const headers = new Headers(await signPluginRequest(raw, SECRET, 'heartbeat', 'e1', NOW))
    expect(await verifyPluginRequest(raw, headers, SECRET, NOW)).toEqual({ ok: true })
  })
  it('refuses a changed body, another secret, a missing signature and an old request', async () => {
    const raw = '{"type":"lead"}'
    const headers = new Headers(await signPluginRequest(raw, SECRET, 'lead', 'e1', NOW))
    expect(await verifyPluginRequest('{"type":"order"}', headers, SECRET, NOW)).toEqual({ ok: false, reason: 'SIGNATURE' })
    expect(await verifyPluginRequest(raw, headers, 'b'.repeat(64), NOW)).toEqual({ ok: false, reason: 'SIGNATURE' })
    expect(await verifyPluginRequest(raw, new Headers({ 'x-ffc-timestamp': String(NOW) }), SECRET, NOW)).toEqual({ ok: false, reason: 'MISSING' })
    expect(await verifyPluginRequest(raw, headers, SECRET, NOW + 301)).toEqual({ ok: false, reason: 'STALE' })
    expect(await verifyPluginRequest(raw, headers, SECRET, NOW + 299)).toEqual({ ok: true })
  })
  it('matches the PHP signer: base64(HMAC-SHA256(secret, "<ts>.<body>"))', async () => {
    // Value computed with: php -r 'echo base64_encode(hash_hmac("sha256","1800000000.{}","secret-key-for-test-0123456789abcdef",true));'
    const h = await signPluginRequest('{}', 'secret-key-for-test-0123456789abcdef', 'x', 'e', NOW)
    expect(h['X-FFC-Signature']).toBe('sRoRBuyXA3meZRnXrlMNcGUsHCX08iI2mxdTNK9O97M=')
  })
})

describe('connection code', () => {
  it('encodes endpoint, store id, secret and app name for the plugin page', () => {
    const code = connectionCode('https://x.supabase.co/functions/v1/channels', '0b9b5a3e-2f0e-4f6a-9d47-1b2c3d4e5f60', SECRET, 'Fullfilio')
    expect(code.startsWith('ffc1.')).toBe(true)
    const json = JSON.parse(atob(code.slice(5).replace(/-/g, '+').replace(/_/g, '/')))
    expect(json).toEqual({ e: 'https://x.supabase.co/functions/v1/channels', c: '0b9b5a3e-2f0e-4f6a-9d47-1b2c3d4e5f60', s: SECRET, n: 'Fullfilio' })
  })
})

describe('plugin attribution', () => {
  const meta = JSON.stringify({
    first_touch: { at: '2026-10-01T10:00:00Z', landing: 'https://shop.com/p/shirt?utm_source=facebook&utm_campaign=eid', referrer: 'https://l.facebook.com/', params: { utm_source: 'facebook', utm_campaign: 'eid', fbclid: 'AbC' } },
    last_touch: { at: '2026-10-03T09:00:00Z', landing: 'https://shop.com/', referrer: null, params: {} },
    fbp: 'fb.1.1700000000.123', fbc: 'fb.1.1700000000.XyZ', ip: '1.2.3.4', user_agent: 'UA',
  })
  it('keeps the first and the latest visit, with the click id from the Meta cookie', () => {
    const a = pluginAttribution(meta)!
    expect(a.first_touch).toMatchObject({ at: '2026-10-01T10:00:00Z', landing: '/p/shirt?utm_source=facebook&utm_campaign=eid', params: { utm_source: 'facebook', utm_campaign: 'eid', fbclid: 'AbC' } })
    expect(a.last_touch).toMatchObject({ landing: '/', params: { fbclid: 'XyZ' } })
  })
  it('returns null for missing or broken data, so no source is invented', () => {
    expect(pluginAttribution(undefined)).toBeNull()
    expect(pluginAttribution('not json')).toBeNull()
    expect(pluginAttribution(JSON.stringify({ first_touch: null, last_touch: null }))).toBeNull()
  })
  it('wins over WooCommerce order attribution in the imported order', () => {
    const order = {
      id: 7, number: '7', status: 'processing', currency: 'BDT', total: '500', shipping_total: '60', discount_total: '0', line_items: [],
      meta_data: [{ key: '_wc_order_attribution_utm_source', value: 'google' }, { key: '_wc_order_attribution_session_entry', value: 'https://shop.com/?utm_source=google' }, { key: '_ffc_attribution', value: meta }],
    } as unknown as WooOrder
    expect(normalizeWooOrder(order).attribution?.first_touch?.params.utm_source).toBe('facebook')
    const plain = { ...order, meta_data: order.meta_data!.slice(0, 2) } as WooOrder
    expect(normalizeWooOrder(plain).attribution?.first_touch?.params.utm_source).toBe('google')
  })
})

describe('unfinished checkouts', () => {
  const lead = leadSchema.parse({
    id: 'ffc-0b9b5a3e-2f0e-4f6a-9d47-1b2c3d4e5f60', phone: '01711000111', name: 'Rina Akter', address: 'House 9, Road 2', city: 'Mirpur', state: 'BD-13',
    items: [{ product_id: 12, variation_id: 34, title: 'Linen Shirt - M', sku: 'LS-M', quantity: 2, price: 650, line_total: 1300 }],
    subtotal: 1300, shipping: 60, total: 1360, currency: 'bdt', checkout_url: 'https://shop.com/checkout/', updated_at: '2026-10-10T10:00:00Z',
  })
  it('becomes a row of the abandoned-checkouts table', () => {
    expect(leadToAbandoned(lead)).toMatchObject({
      id: lead.id, customer_name: 'Rina Akter', phone: '01711000111', province: 'BD-13', item_count: 2, total: 1360, currency: 'BDT',
      recovery_url: 'https://shop.com/checkout/',
      items: [{ title: 'Linen Shirt - M', quantity: 2, price: 650, external_variant_id: '34', sku: 'LS-M' }],
      completed_at: null,
    })
  })
  it('accepts a checkout from plugin 1.0.0 that sent empty ad tags as [] (seen on a real store)', () => {
    const raw = { ...lead, attribution: { first_touch: { at: '2026-10-11T01:11:00Z', landing: '/checkout/', referrer: null, params: [] }, last_touch: null } }
    expect(pluginEventSchema.safeParse({ type: 'lead', data: raw }).success).toBe(true)
  })
  it('event schema rejects unknown types and bad ids', () => {
    expect(pluginEventSchema.safeParse({ type: 'lead', data: { ...lead, id: 'x' } }).success).toBe(false)
    expect(pluginEventSchema.safeParse({ type: 'delete_everything', data: {} }).success).toBe(false)
    expect(pluginEventSchema.safeParse({ type: 'order', data: { order_id: 5, event: 'created', status: 'processing' } }).success).toBe(true)
  })
})
