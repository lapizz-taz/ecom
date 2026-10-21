import { describe, expect, it, vi } from 'vitest'
import {
  hashPerson, metaPayload, normalizeAdConfig, phoneDigits, publicAdConfig, purchaseEventId, purchaseSkipReason, sendGa4, sendMeta, sendServerEvent, sendTikTok,
  sha256, type StoreEvent, testPlatform, tiktokPayload,
} from './ads/store-tracking.ts'
import { attributionSchema, trackSchema } from './schemas.ts'

const MERCHANT = '11111111-1111-4111-8111-111111111111'
vi.mock('./supabase.ts', async (load) => ({ ...(await load<typeof import('./supabase.ts')>()), merchantOf: () => MERCHANT }))
const { beaconEvent, browserPurchase, processAdEvents } = await import('./ads/store-tracking-service.ts')

const config = (over: Record<string, unknown> = {}) => normalizeAdConfig({
  enabled: true, purchase_on: 'placed',
  meta: { pixel_id: '1234567890123456', test_code: '' },
  tiktok: { pixel_id: 'C1A2B3C4D5E6F7G8H9I0', test_code: '' },
  google: { ga4_id: 'g-abc123xyz', ads_id: 'AW-123456789', ads_label: 'AbCdEf12' },
  ...over,
})
const secrets = { meta_token: 'EAAmetatoken123', tiktok_token: 'tt-token-456', ga4_secret: 'ga4-secret-789' }
const ev: StoreEvent = {
  name: 'Purchase', event_id: 'ffs_pu_ISO-10004', time: 1_760_000_000, url: 'https://shop.example.com/checkout', value: 1250, currency: 'BDT', order_id: 'ISO-10004',
  contents: [{ id: 'p1', name: 'Shirt', quantity: 2, price: 625 }],
}

const ok = (body: unknown, status = 200) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A fetch that answers like each platform does when it accepts an event. */
function platformsFetch() {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input)
    if (url.startsWith('https://graph.facebook.com/')) return ok({ events_received: 1, fbtrace_id: 'x' })
    if (url.startsWith('https://business-api.tiktok.com/')) return ok({ code: 0, message: 'OK' })
    if (url.startsWith('https://www.google-analytics.com/mp/collect')) return new Response(null, { status: 204 })
    return ok({ error: 'unexpected' }, 500)
  })
}

describe('ad tracking settings', () => {
  it('fills defaults and drops ids that are not valid', () => {
    const c = normalizeAdConfig({ enabled: true, meta: { pixel_id: 'abc' }, tiktok: { pixel_id: 'lower-case' }, google: { ga4_id: 'g-abcd1234', ads_id: 'AW-12' } })
    expect(c).toMatchObject({ purchase_on: 'placed', browser_events: true, server_events: true, advanced_matching: true, skip_duplicates: true, exclude_low_rr: false })
    expect(c.meta.pixel_id).toBe('')
    expect(c.tiktok.pixel_id).toBe('')
    expect(c.google.ga4_id).toBe('G-ABCD1234')
    expect(c.google.ads_id).toBe('')
  })

  it('gives the storefront ids and switches, never tokens', () => {
    const pub = publicAdConfig(config())
    expect(pub).toMatchObject({ enabled: true, meta_pixel: '1234567890123456', tiktok_pixel: 'C1A2B3C4D5E6F7G8H9I0', ga4_id: 'G-ABC123XYZ' })
    expect(JSON.stringify(pub)).not.toMatch(/token|secret/i)
  })
})

describe('matching data', () => {
  it('normalizes Bangladeshi numbers to 8801…', () => {
    expect(phoneDigits('01712-345678')).toBe('8801712345678')
    expect(phoneDigits('+880 1712 345678')).toBe('8801712345678')
    expect(phoneDigits('12345')).toBe('')
  })

  it('hashes what Meta asks for, and only the visitor id without advanced matching', async () => {
    const full = await hashPerson({ phone: '01712345678', email: ' A@B.com ', name: 'Rahim Uddin', city: 'Dhaka', external_id: 'vid123' })
    expect(full.em).toBe(await sha256('a@b.com'))
    expect(full.ph).toBe(await sha256('8801712345678'))
    expect(full.ph_e164).toBe(await sha256('+8801712345678'))
    expect(full.fn).toBe(await sha256('rahim'))
    expect(full.ln).toBe(await sha256('uddin'))
    expect(full.external_id).toBe(await sha256('vid123'))
    const lean = await hashPerson({ phone: '01712345678', external_id: 'vid123' }, false)
    expect(lean).toEqual({ country: await sha256('bd'), external_id: await sha256('vid123') })
  })
})

describe('payloads', () => {
  it('Meta: one event with its id, hashed user data and an fbc made from the click id', async () => {
    const m = await hashPerson({ phone: '01712345678' })
    const p = metaPayload(ev, m, { ip: '1.2.3.4', ua: 'UA', fbp: 'fb.1.1700000000000.123', fbclid: 'abcDEF' }, 'TEST1')
    const row = p.data[0] as Record<string, any>
    expect(row).toMatchObject({ event_name: 'Purchase', event_id: 'ffs_pu_ISO-10004', action_source: 'website', event_source_url: 'https://shop.example.com/checkout' })
    expect(row.user_data.ph).toEqual([m.ph])
    expect(row.user_data.fbp).toBe('fb.1.1700000000000.123')
    expect(row.user_data.fbc).toMatch(/^fb\.1\.\d+\.abcDEF$/)
    expect(row.custom_data).toMatchObject({ value: 1250, currency: 'BDT', content_ids: ['p1'], num_items: 2, order_id: 'ISO-10004' })
    expect(p.test_event_code).toBe('TEST1')
  })

  it('TikTok: CompletePayment with the same event id', async () => {
    const p = tiktokPayload('PIX', ev, await hashPerson({}), { ttclid: 'tc1' })
    expect(p.event_source_id).toBe('PIX')
    expect(p.data[0]).toMatchObject({ event: 'CompletePayment', event_id: 'ffs_pu_ISO-10004', user: { ttclid: 'tc1' } })
  })
})

describe('senders', () => {
  it('Meta: the token goes in the body, never the URL, and an error never echoes it', async () => {
    const fetchFn = platformsFetch()
    const r = await sendMeta(config(), secrets, ev, await hashPerson({}), {}, { fetchFn })
    expect(r).toEqual({ ok: true })
    const [url, init] = fetchFn.mock.calls[0]
    expect(String(url)).toBe('https://graph.facebook.com/v22.0/1234567890123456/events')
    expect(String(url)).not.toContain(secrets.meta_token)
    expect(JSON.parse(String(init!.body)).access_token).toBe(secrets.meta_token)

    const bad = vi.fn(async () => ok({ error: { message: `Invalid token EAAmetatoken123` } }, 400))
    const e = await sendMeta(config(), secrets, ev, await hashPerson({}), {}, { fetchFn: bad })
    expect(e.ok).toBe(false)
    expect(e.error).not.toContain(secrets.meta_token)
  })

  it('TikTok: Access-Token header, code 0 is success, page views are left to the pixel', async () => {
    const fetchFn = platformsFetch()
    expect(await sendTikTok(config(), secrets, ev, await hashPerson({}), {}, { fetchFn })).toEqual({ ok: true })
    expect((fetchFn.mock.calls[0][1]!.headers as Record<string, string>)['Access-Token']).toBe(secrets.tiktok_token)
    const pv = await sendTikTok(config(), secrets, { ...ev, name: 'PageView' }, await hashPerson({}), {}, { fetchFn })
    expect(pv.skipped).toBeTruthy()
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const refused = vi.fn(async () => ok({ code: 40001, message: 'Access token invalid' }))
    expect((await sendTikTok(config(), secrets, ev, await hashPerson({}), {}, { fetchFn: refused })).ok).toBe(false)
  })

  it('Google: the purchase only', async () => {
    const fetchFn = platformsFetch()
    expect(await sendGa4(config(), secrets, ev, await hashPerson({}), { ga_cid: '123456789.1700000000' }, { fetchFn })).toEqual({ ok: true })
    const url = new URL(String(fetchFn.mock.calls[0][0]))
    expect(url.searchParams.get('measurement_id')).toBe('G-ABC123XYZ')
    const body = JSON.parse(String(fetchFn.mock.calls[0][1]!.body))
    expect(body.client_id).toBe('123456789.1700000000')
    expect(body.events[0]).toMatchObject({ name: 'purchase', params: { transaction_id: 'ISO-10004', value: 1250 } })
    expect((await sendGa4(config(), secrets, { ...ev, name: 'AddToCart' }, await hashPerson({}), {}, { fetchFn })).skipped).toBeTruthy()
  })

  it('skips a platform without its token instead of failing', async () => {
    const fetchFn = platformsFetch()
    const r = await sendServerEvent(config(), { meta_token: secrets.meta_token }, ev, {}, {}, { fetchFn })
    expect(r.meta.ok).toBe(true)
    expect(r.tiktok.skipped).toBeTruthy()
    expect(r.google.skipped).toBeTruthy()
  })

  it('connection test asks TikTok for a test code so no real event is counted', async () => {
    const r = await testPlatform('tiktok', config(), secrets, { fetchFn: platformsFetch() })
    expect(r).toMatchObject({ ok: false, hint: true })
  })
})

describe('Purchase rules', () => {
  const order = { order_number: 'ISO-1', status: 'PENDING', total: 500, currency: 'BDT', merged_into: null, duplicate_of: null, receive_rate_tier: 'GOOD', created_at: '2026-10-01T00:00:00Z' }
  it('counts a normal order and skips the ones the merchant excluded', () => {
    expect(purchaseSkipReason(config(), order)).toBeNull()
    expect(purchaseSkipReason(config(), { ...order, total: 0 })).toMatch(/0/)
    expect(purchaseSkipReason(config(), { ...order, status: 'CANCELLED' })).toMatch(/cancelled/)
    expect(purchaseSkipReason(config(), { ...order, merged_into: 'x' })).toMatch(/Merged/)
    expect(purchaseSkipReason(config(), { ...order, duplicate_of: 'x' })).toMatch(/duplicate/)
    expect(purchaseSkipReason(config({ skip_duplicates: false }), { ...order, duplicate_of: 'x' })).toBeNull()
    expect(purchaseSkipReason(config(), { ...order, receive_rate_tier: 'LOW' })).toBeNull()
    expect(purchaseSkipReason(config({ exclude_low_rr: true }), { ...order, receive_rate_tier: 'LOW' })).toMatch(/Low/)
  })

  it('one event id per order, the same as the database trigger makes', () => {
    expect(purchaseEventId('ISO-10004')).toBe('ffs_pu_ISO-10004')
    expect(purchaseEventId('A/B 7')).toBe('ffs_pu_AB7')
  })
})

describe('storefront payloads', () => {
  it('accepts a browser event with matching ids and rejects a made-up id', () => {
    const base = { action: 'track', event: 'AddToCart', event_id: 'ffs_ac_AbCdEf1234567890', url: 'https://shop.example.com/p/x' }
    expect(trackSchema.safeParse(base).success).toBe(true)
    expect(trackSchema.safeParse({ ...base, event: 'Purchase' }).success).toBe(false)
    expect(trackSchema.safeParse({ ...base, event_id: 'ffc_ac_x' }).success).toBe(false)
  })

  it('a bad browser id drops only the ids, never the order attribution', () => {
    const a = attributionSchema.parse({ visitor_id: 'abcdefgh1234', browser: { fbp: 'nonsense' } })
    expect(a.visitor_id).toBe('abcdefgh1234')
    expect(a.browser).toBeUndefined()
    const b = attributionSchema.parse({ visitor_id: 'abcdefgh1234', browser: { fbp: 'fb.1.1700000000000.1234567890', ga: '123456789.1700000000' } })
    expect(b.browser).toEqual({ fbp: 'fb.1.1700000000000.1234567890', ga: '123456789.1700000000' })
  })
})

// --- the queue runner, against a stand-in for the database -------------------------------------------

interface Job { id: string; order_id: string; event: 'Purchase'; event_id: string; attempts: number }

const PRODUCT = '6f9619ff-8b86-4d11-b42d-00c04fc964ff'

function fakeAdmin(opts: { config: Record<string, unknown>; secret?: Record<string, string> | null; due?: Job[]; orders?: Record<string, Record<string, unknown> | null> }) {
  const results: Array<Record<string, unknown>> = []
  const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    if (fn === 'integration_secret_get') return { data: opts.secret ?? null, error: null }
    if (fn === 'ad_event_due') return { data: opts.due ?? [], error: null }
    if (fn === 'ad_event_order') return { data: opts.orders?.[String(args.p_order_id)] ?? null, error: null }
    if (fn === 'ad_event_result') { results.push(args); return { data: null, error: null } }
    if (fn === 'ad_track_scope') return { data: { hosts: ['shop.example.com'], prices: { [PRODUCT]: 625 } }, error: null }
    return { data: null, error: { message: `unexpected ${fn}` } }
  })
  const from = vi.fn(() => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { config: opts.config }, error: null }) }) }),
  }))
  return { admin: { rpc, from } as never, rpc, results }
}

const orderFacts = (over: Record<string, unknown> = {}) => ({
  order_number: 'ISO-10004', status: 'DELIVERED', total: '1250.00', currency: 'BDT', customer_name: 'Rahim Uddin', customer_phone: '01712345678',
  customer_email: null, city: 'Dhaka', district: 'Dhaka', client_ip: '1.2.3.4', user_agent: 'UA', created_at: '2026-10-01T10:00:00Z',
  merged_into: null, duplicate_of: null, receive_rate_tier: 'GOOD', visitor_id: 'vid12345678', click_id: 'fbc123', click_id_type: 'fbclid',
  landing_page: 'https://shop.example.com/?fbclid=fbc123', browser_ids: { fbp: 'fb.1.1700000000000.42' },
  items: [{ id: 'p1', name: 'Shirt', quantity: 2, price: '625.00' }], ...over,
})

describe('the Purchase queue', () => {
  it('sends a due Purchase to every set-up platform and records DONE', async () => {
    const fetchFn = platformsFetch()
    const { admin, results } = fakeAdmin({
      config: config({ purchase_on: 'delivered' }), secret: secrets,
      due: [{ id: 'q1', order_id: 'o1', event: 'Purchase', event_id: 'ffs_pu_ISO-10004', attempts: 0 }],
      orders: { o1: orderFacts() },
    })
    const out = await processAdEvents(admin, 20, fetchFn)
    expect(out.sent).toBe(1)
    expect(results[0]).toMatchObject({ p_id: 'q1', p_status: 'DONE', p_error: null, p_retry: false })
    const meta = JSON.parse(String(fetchFn.mock.calls.find(([u]) => String(u).includes('graph.facebook.com'))![1]!.body))
    expect(meta.data[0]).toMatchObject({ event_name: 'Purchase', event_id: 'ffs_pu_ISO-10004' })
    expect(meta.data[0].user_data).toMatchObject({ fbp: 'fb.1.1700000000000.42', client_ip_address: '1.2.3.4' })
    expect(meta.data[0].user_data.fbc).toMatch(/\.fbc123$/)
  })

  it('records PARTIAL when one platform refuses, and retries a total failure', async () => {
    const half = vi.fn(async (input: string | URL | Request) => String(input).includes('tiktok') ? ok({ code: 40001, message: 'bad token' }) : platformsFetch()(input))
    const one = fakeAdmin({ config: config(), secret: secrets, due: [{ id: 'q1', order_id: 'o1', event: 'Purchase', event_id: 'e', attempts: 0 }], orders: { o1: orderFacts() } })
    expect((await processAdEvents(one.admin, 20, half)).partial).toBe(1)
    expect(one.results[0]).toMatchObject({ p_status: 'PARTIAL', p_retry: false })

    const down = vi.fn(async () => ok({ error: 'down' }, 503))
    const two = fakeAdmin({ config: config(), secret: secrets, due: [{ id: 'q2', order_id: 'o1', event: 'Purchase', event_id: 'e', attempts: 0 }], orders: { o1: orderFacts() } })
    expect((await processAdEvents(two.admin, 20, down)).waiting).toBe(1)
    expect(two.results[0]).toMatchObject({ p_status: 'FAILED', p_retry: true })
  })

  it('skips without sending when the order no longer qualifies or tracking was turned off', async () => {
    const fetchFn = platformsFetch()
    const cancelled = fakeAdmin({ config: config(), secret: secrets, due: [{ id: 'q1', order_id: 'o1', event: 'Purchase', event_id: 'e', attempts: 0 }], orders: { o1: orderFacts({ status: 'CANCELLED' }) } })
    expect((await processAdEvents(cancelled.admin, 20, fetchFn)).skipped).toBe(1)
    const off = fakeAdmin({ config: config({ enabled: false }), secret: secrets, due: [{ id: 'q1', order_id: 'o1', event: 'Purchase', event_id: 'e', attempts: 0 }], orders: { o1: orderFacts() } })
    expect((await processAdEvents(off.admin, 20, fetchFn)).skipped).toBe(1)
    expect(off.results[0]).toMatchObject({ p_status: 'SKIPPED' })
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it('records SKIPPED when no platform has a token yet', async () => {
    const { admin, results } = fakeAdmin({ config: config(), secret: null, due: [{ id: 'q1', order_id: 'o1', event: 'Purchase', event_id: 'e', attempts: 0 }], orders: { o1: orderFacts() } })
    await processAdEvents(admin, 20, platformsFetch())
    expect(results[0]).toMatchObject({ p_status: 'SKIPPED' })
  })
})

describe('browser Purchase and beacon', () => {
  it('gives the success page the Purchase only in placed mode, for a qualifying order', async () => {
    const a = fakeAdmin({ config: config({ purchase_on: 'placed' }), orders: { o1: orderFacts({ status: 'PENDING' }) } })
    const p = await browserPurchase(a.admin, 'o1', false)
    expect(p).toMatchObject({ event_id: 'ffs_pu_ISO-10004', order_id: 'ISO-10004', value: 1250, contents: [{ id: 'p1', quantity: 2, price: 625 }] })
    expect(p!.matching?.ph_e164).toBe(await sha256('+8801712345678'))
    const merged = fakeAdmin({ config: config(), orders: { o1: orderFacts() } })
    expect(await browserPurchase(merged.admin, 'o1', true)).toBeNull()
  })

  it('the beacon sends only events of the store\'s own pages, with its own products and prices', async () => {
    const fetchFn = platformsFetch()
    const { admin } = fakeAdmin({ config: config(), secret: secrets })
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 240_000)
    const off = await beaconEvent(admin, { event: 'AddToCart', event_id: 'ffs_ac_AbCdEf1234567890', url: 'https://attacker.example/x' }, '1.2.3.4', 'UA', fetchFn)
    const foreignCaller = await beaconEvent(admin, { event: 'PageView', event_id: 'ffs_pv_AbCdEf1234567890', url: 'https://shop.example.com/' }, '1.2.3.4', 'UA', fetchFn, 'https://attacker.example')
    expect(off).toMatchObject({ ok: false, skipped: 'Not a page of this store' })
    expect(foreignCaller).toMatchObject({ ok: false })
    expect(fetchFn).not.toHaveBeenCalled()
    await beaconEvent(admin, {
      event: 'AddToCart', event_id: 'ffs_ac_AbCdEf1234567891', url: 'https://shop.example.com/p/shirt', value: 9_999_999, currency: 'BDT',
      contents: [{ id: PRODUCT, quantity: 2, price: 9_999_999 }, { id: 'not-a-product', quantity: 999, price: 9_999_999 }],
    }, '1.2.3.4', 'UA', fetchFn, 'https://shop.example.com')
    now.mockRestore()
    const meta = (fetchFn.mock.calls as unknown as Array<[string, RequestInit]>).find(([u]) => String(u).includes('graph.facebook.com'))
    expect(meta).toBeTruthy()
    const sent = JSON.parse(String(meta![1].body)).data[0]
    expect(sent.custom_data.value).toBe(1250)
    expect(sent.custom_data.contents).toEqual([expect.objectContaining({ id: PRODUCT, quantity: 2, item_price: 625 })])
  })

  it('the beacon sends nothing while tracking is off', async () => {
    const fetchFn = platformsFetch()
    const { admin } = fakeAdmin({ config: config({ enabled: false }), secret: secrets })
    // The beacon keeps settings for a minute: step past that so it reads these ones.
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 900_000)
    const r = await beaconEvent(admin, { event: 'AddToCart', event_id: 'ffs_ac_AbCdEf1234567890', url: 'https://shop.example.com/' }, '1.2.3.4', 'UA', fetchFn)
    now.mockRestore()
    expect(r.ok).toBe(false)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('more events and returning buyers', () => {
  const hex = (c: string) => c.repeat(64)
  it('takes search, contact and sign-up events, and only hashed buyer details', () => {
    const base = { action: 'track', event_id: 'ffs_se_AbCdEf1234567890', url: 'https://shop.example.com/search?q=shirt' }
    expect(trackSchema.parse({ ...base, event: 'Search', search: 'linen shirt' }).search).toBe('linen shirt')
    expect(trackSchema.safeParse({ ...base, event: 'Contact' }).success).toBe(true)
    expect(trackSchema.safeParse({ ...base, event: 'CompleteRegistration' }).success).toBe(true)
    expect(trackSchema.parse({ ...base, event: 'Contact', user: { ph: hex('a'), em: hex('b') } }).user).toEqual({ ph: hex('a'), em: hex('b') })
    // A plain phone number is never accepted as "hashed".
    expect(trackSchema.parse({ ...base, event: 'Contact', user: { ph: '01712345678' } }).user).toBeUndefined()
  })

  it('a search goes to Meta as search_string and to TikTok as query', () => {
    const se: StoreEvent = { name: 'Search', event_id: 'ffs_se_x', time: 1_760_000_000, url: 'https://shop.example.com/search', search: 'belt' }
    const meta = metaPayload(se, { country: 'c' }, {})
    expect((meta.data[0] as any).custom_data).toEqual({ search_string: 'belt' })
    const tt = tiktokPayload('C1A2B3C4D5E6F7G8H9I0', se, { country: 'c' }, {})
    expect((tt.data[0] as any).event).toBe('Search')
    expect((tt.data[0] as any).properties).toEqual({ query: 'belt' })
  })

  it('fills the browser-hashed details into the server event (advanced matching on), never over the order\'s own', async () => {
    const fetchFn = platformsFetch()
    const pv: StoreEvent = { name: 'ViewContent', event_id: 'ffs_vc_x', time: 1_760_000_000, url: 'https://shop.example.com/p' }
    await sendServerEvent(config(), secrets, pv, { external_id: 'v1' }, {}, { fetchFn }, { ph: hex('a'), em: hex('b'), fn: 'not-a-hash' } as any)
    const metaCall = fetchFn.mock.calls.find(([u]) => String(u).includes('graph.facebook.com'))!
    const user = JSON.parse(String(metaCall[1]!.body)).data[0].user_data
    expect(user.ph).toEqual([hex('a')])
    expect(user.em).toEqual([hex('b')])
    expect(user.fn).toBeUndefined()
    fetchFn.mockClear()
    await sendServerEvent(config({ advanced_matching: false }), secrets, pv, { external_id: 'v1' }, {}, { fetchFn }, { ph: hex('a') })
    const off = JSON.parse(String(fetchFn.mock.calls.find(([u]) => String(u).includes('graph.facebook.com'))![1]!.body)).data[0].user_data
    expect(off.ph).toBeUndefined()
  })
})
