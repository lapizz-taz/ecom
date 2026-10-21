import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const merchantFetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}', { status: 202 }))
vi.mock('@/lib/merchant', () => ({ merchantFetch }))
vi.mock('@/lib/functions', () => ({ functionHeaders: async () => ({ apikey: 'anon', Authorization: 'Bearer anon' }) }))
vi.mock('@/lib/env', () => ({ functionsUrl: (n: string) => `https://fn.example.com/${n}` }))

// A minimal browser for the module (the unit tests run in Node).
const g = globalThis as Record<string, unknown>
g.window = globalThis
g.document = { cookie: '', head: { appendChild: vi.fn() }, createElement: () => ({}) }
g.location = { protocol: 'https:', href: 'https://shop.example.com/p/shirt#top', pathname: '/p/shirt', search: '' }
function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, String(v)), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() }
}
g.sessionStorage = memoryStorage()
g.localStorage = memoryStorage()

const { adEvent, adPurchase, browserIds, eventId, firstTime, resetAdPixelsForTest, startAdPixels } = await import('./ad-pixels')

// The server's rule for funnel event ids (supabase/functions/_shared/schemas.ts trackSchema).
const SERVER_ID = /^ffs_[a-z]{2}_[A-Za-z0-9]{8,40}$/
const flush = () => new Promise((r) => setTimeout(r, 0))

let fbq: ReturnType<typeof vi.fn>
let gtag: ReturnType<typeof vi.fn>
let ttq: { page: ReturnType<typeof vi.fn>; track: ReturnType<typeof vi.fn>; identify: ReturnType<typeof vi.fn> }

beforeEach(() => {
  resetAdPixelsForTest()
  merchantFetch.mockClear()
  fbq = vi.fn()
  gtag = vi.fn()
  ttq = { page: vi.fn(), track: vi.fn(), identify: vi.fn() }
  Object.assign(g, { fbq, gtag, ttq })
  ;(g.document as { cookie: string }).cookie = ''
  ;(g.sessionStorage as Storage).clear()
  ;(g.localStorage as Storage).clear()
})
afterEach(() => { delete g.fbq; delete g.gtag; delete g.ttq })

const on = { enabled: true, browser_events: true, server_events: true, meta_pixel: '1234567890123456', tiktok_pixel: 'C1A2B3C4D5E6F7G8H9I0', ga4_id: 'G-ABC123', ads_id: 'AW-123456789', ads_label: 'AbCd1234' }

describe('ad pixels', () => {
  it('makes event ids the server accepts', () => {
    for (const e of ['PageView', 'ViewContent', 'AddToCart', 'InitiateCheckout'] as const) expect(eventId(e)).toMatch(SERVER_ID)
  })

  it('passes on only well-formed browser ids', () => {
    ;(g.document as { cookie: string }).cookie = '_fbp=fb.1.1700000000000.1234567890; _fbc=bad; _ttp=abcDEF123456; _ga=GA1.1.123456789.1700000000'
    expect(browserIds()).toEqual({ fbp: 'fb.1.1700000000000.1234567890', ttp: 'abcDEF123456', ga: '123456789.1700000000' })
  })

  it('holds events until the settings arrive, then fires the pixel and the server copy with one id', async () => {
    adEvent('AddToCart', { value: 1250, currency: 'BDT', contents: [{ id: 'p1', name: 'Shirt', quantity: 2, price: 625 }] })
    expect(merchantFetch).not.toHaveBeenCalled()
    await startAdPixels(on)
    await flush()
    const call = fbq.mock.calls.find((c) => c[0] === 'track')!
    expect(call[1]).toBe('AddToCart')
    const id = (call[3] as { eventID: string }).eventID
    expect(id).toMatch(SERVER_ID)
    expect(ttq.track).toHaveBeenCalledWith('AddToCart', expect.anything(), { event_id: id })
    expect(merchantFetch).toHaveBeenCalledTimes(1)
    const [url, init] = merchantFetch.mock.calls[0]
    expect(url).toBe('https://fn.example.com/checkout')
    expect(init!.keepalive).toBe(true)
    const body = JSON.parse(String(init!.body))
    expect(body).toMatchObject({ action: 'track', event: 'AddToCart', event_id: id, url: 'https://shop.example.com/p/shirt', value: 1250, currency: 'BDT' })
    expect(body.browser.ga).toBeUndefined()
  })

  it('a page view: Meta with an id, TikTok page(), no tokens anywhere', async () => {
    await startAdPixels(on)
    adEvent('PageView')
    await flush()
    expect(fbq).toHaveBeenCalledWith('track', 'PageView', {}, { eventID: expect.stringMatching(/^ffs_pv_/) })
    expect(ttq.page).toHaveBeenCalled()
  })

  it('does nothing when the store has tracking off', async () => {
    adEvent('PageView')
    await startAdPixels({ enabled: false })
    adEvent('ViewContent', { value: 1 })
    await flush()
    expect(fbq).not.toHaveBeenCalled()
    expect(merchantFetch).not.toHaveBeenCalled()
  })

  it('browser pixels off: only the server copies go', async () => {
    await startAdPixels({ ...on, browser_events: false })
    adEvent('ViewContent', { value: 10 })
    await flush()
    expect(fbq).not.toHaveBeenCalled()
    expect(merchantFetch).toHaveBeenCalledTimes(1)
  })

  it('the Purchase uses the order event id the server also sends, and fires the Google Ads conversion', async () => {
    await startAdPixels(on)
    adPurchase({ event_id: 'ffs_pu_ISO-10004', order_id: 'ISO-10004', value: 1250, currency: 'BDT', contents: [{ id: 'p1', quantity: 2, price: 625 }], matching: { em: 'h1' } })
    expect(fbq).toHaveBeenCalledWith('track', 'Purchase', expect.objectContaining({ value: 1250, order_id: 'ISO-10004' }), { eventID: 'ffs_pu_ISO-10004' })
    expect(ttq.track).toHaveBeenCalledWith('CompletePayment', expect.anything(), { event_id: 'ffs_pu_ISO-10004' })
    expect(gtag).toHaveBeenCalledWith('event', 'conversion', expect.objectContaining({ send_to: 'AW-123456789/AbCd1234', transaction_id: 'ISO-10004' }))
    expect(gtag).toHaveBeenCalledWith('set', 'user_data', { sha256_email_address: 'h1' })
    // The browser never sends a server copy of the Purchase; the order's queue does.
    expect(merchantFetch).not.toHaveBeenCalled()
  })
})

describe('one event per real action', () => {
  const cart = { value: 1250, currency: 'BDT', contents: [{ id: 'p1', quantity: 2, price: 625 }] }
  const metaCalls = (name: string) => fbq.mock.calls.filter((c) => c[0] === 'track' && c[1] === name)

  it('remembers a key for its window', () => {
    const t = 1_700_000_000_000
    expect(firstTime('k', 3000, t)).toBe(true)
    expect(firstTime('k', 3000, t + 1000)).toBe(false)
    expect(firstTime('k', 3000, t + 3001)).toBe(true)
  })

  it('a page drawn twice is one page view', async () => {
    await startAdPixels(on)
    adEvent('PageView')
    adEvent('PageView')
    await flush()
    expect(metaCalls('PageView')).toHaveLength(1)
    expect(ttq.page).toHaveBeenCalledTimes(1)
    expect(merchantFetch).toHaveBeenCalledTimes(1)
  })

  it('a reloaded checkout with the same cart is one InitiateCheckout; a changed cart counts again', async () => {
    await startAdPixels(on)
    adEvent('InitiateCheckout', cart)
    adEvent('InitiateCheckout', cart)
    await flush()
    expect(metaCalls('InitiateCheckout')).toHaveLength(1)
    adEvent('InitiateCheckout', { ...cart, contents: [{ id: 'p1', quantity: 3, price: 625 }] })
    await flush()
    expect(metaCalls('InitiateCheckout')).toHaveLength(2)
    expect(merchantFetch).toHaveBeenCalledTimes(2)
  })

  it('a double tap is one AddToCart', async () => {
    await startAdPixels(on)
    adEvent('AddToCart', cart)
    adEvent('AddToCart', cart)
    await flush()
    expect(metaCalls('AddToCart')).toHaveLength(1)
  })

  it('the success page shown again does not repeat the Purchase', async () => {
    await startAdPixels(on)
    const p = { event_id: 'ffs_pu_ISO-10009', order_id: 'ISO-10009', value: 1250, currency: 'BDT' }
    adPurchase(p)
    adPurchase(p)
    expect(metaCalls('Purchase')).toHaveLength(1)
    expect(gtag.mock.calls.filter((c) => c[1] === 'conversion')).toHaveLength(1)
    adPurchase({ ...p, event_id: 'ffs_pu_ISO-10010', order_id: 'ISO-10010' })
    expect(metaCalls('Purchase')).toHaveLength(2)
  })
})
