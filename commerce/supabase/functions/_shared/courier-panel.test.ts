import { describe, expect, it, vi } from 'vitest'
import {
  answerDetail, COURIER_PANEL_PROVIDERS, CourierPanelProvider, type CourierPanelCreds, panelAccounts, type SessionStore, parseSteadfast, readLoginForm, setPanelRelay,
  testPanelLogin,
} from './fraud/courier-panel.ts'
import { CourierHistoryProvider, setHistoryRelay } from './fraud/courier-history.ts'
import { httpPanelRelay } from './fraud/courier-relay.ts'
import { providersFromSettings } from './fraud/service.ts'

function freshStore(): SessionStore {
  const m = new Map<string, { value: string; exp: number }>()
  return {
    get: (k) => { const s = m.get(k); return s && s.exp > Date.now() ? s : undefined },
    set: (k, v, ttl) => { m.set(k, { value: v, exp: Date.now() + ttl }) },
    drop: (k) => { m.delete(k) },
  }
}

const withCookie = (body: unknown, cookie?: string, status = 200) => {
  const headers = new Headers({ 'Content-Type': 'application/json' })
  if (cookie) headers.append('set-cookie', cookie)
  return new Response(JSON.stringify(body), { status, headers })
}
const htmlRes = (html: string, cookie?: string) => {
  const headers = new Headers({ 'Content-Type': 'text/html' })
  if (cookie) headers.append('set-cookie', cookie)
  return new Response(html, { status: 200, headers })
}

/** A fetch that answers each courier panel's endpoints with sample data. */
function panelFetch(overrides: Record<string, () => Response> = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input)
    const method = (init?.method ?? 'GET').toUpperCase()
    for (const [frag, make] of Object.entries(overrides)) if (url.includes(frag)) return make()
    // Specific courier hosts first (several of these paths also end in /login).
    // Pathao
    if (url.includes('merchant.pathao.com/api/v1/login')) return withCookie({ access_token: 'pat-tok' })
    if (url.includes('merchant.pathao.com/api/v1/user/success')) return withCookie({ data: { customer: { successful_delivery: 5, total_delivery: 7 } } })
    // RedX
    if (url.includes('api.redx.com.bd/v4/auth/login')) return withCookie({ data: { accessToken: 'redx-tok' } })
    if (url.includes('customer-success-return-rate')) return withCookie({ data: { deliveredParcels: 20, totalParcels: 25 } })
    // Carrybee
    if (url.includes('merchant.carrybee.com/api/auth/csrf')) return withCookie({ csrfToken: 'csrf-cb' }, 'cb=1; Path=/')
    if (url.includes('merchant.carrybee.com/api/auth/callback/login')) return new Response('', { status: 302, headers: new Headers({ 'set-cookie': 'cb_auth=2; Path=/' }) })
    if (url.includes('merchant.carrybee.com/api/auth/session')) return withCookie({ accessToken: 'cb-tok', user: { selectedBusinessId: 'biz-9' } })
    if (url.includes('api-merchant.carrybee.com') && url.includes('/customers/')) return withCookie({ data: { total_order: 10, cancelled_order: 0, success_rate: 100 } })
    if (url.includes('api-merchant.carrybee.com') && url.includes('/fraud-check/')) return withCookie({ data: { total_order: 10, cancelled_order: 0, success_rate: 100 } })
    // Steadfast (its login path is a bare /login, so it must be matched last).
    if (url.includes('steadfast.com.bd/login') && method === 'GET') return htmlRes('<input type="hidden" name="_token" value="tok-sf">', 'sf_sess=1; Path=/')
    if (url.includes('steadfast.com.bd/login') && method === 'POST') return new Response('', { status: 302, headers: new Headers({ 'set-cookie': 'sf_auth=2; Path=/' }) })
    if (url.includes('/user/frauds/check/')) return withCookie({ total_delivered: 8, total_cancelled: 2 })
    return new Response('not found', { status: 404 })
  })
}

const allCreds: CourierPanelCreds = {
  steadfast: { email: 'shop@x.com', password: 'p1' },
  pathao: { email: 'shop@x.com', password: 'p2' },
  redx: { phone: '01712345678', password: 'p3' },
  carrybee: { phone: '01712345678', password: 'p4' },
}

describe('courier panel provider', () => {
  it('lists only couriers with a complete login as connected', () => {
    const p = new CourierPanelProvider({ steadfast: { email: 'a@b.com', password: 'x' }, pathao: { email: 'only-email' } })
    expect(p.connected).toEqual(['steadfast'])
  })

  it('reads each courier panel and merges the totals', async () => {
    const fetchFn = panelFetch()
    const p = new CourierPanelProvider(allCreds, { fetchFn, store: freshStore() })
    const summary = await p.lookup('01811111111')
    // Steadfast 8/10, Pathao 5/7, RedX 20/25, Carrybee 10/10
    const by = Object.fromEntries(summary.couriers.map((c) => [c.courier, c]))
    expect(by.steadfast).toMatchObject({ orders: 10, delivered: 8, cancelled: 2 })
    expect(by.pathao).toMatchObject({ orders: 7, delivered: 5, cancelled: 2 })
    expect(by.redx).toMatchObject({ orders: 25, delivered: 20, cancelled: 5 })
    expect(by.carrybee).toMatchObject({ orders: 10, delivered: 10, cancelled: 0 })
    expect(summary.total).toBe(10 + 7 + 25 + 10)
    expect(summary.delivered).toBe(8 + 5 + 20 + 10)
    expect(summary.success_ratio).toBeGreaterThan(80)
    expect(summary.ratio_source).toBe('counts')
  })

  it('rejects non-Bangladeshi numbers', async () => {
    const p = new CourierPanelProvider(allCreds, { fetchFn: panelFetch(), store: freshStore() })
    await expect(p.lookup('+44 7700 900123')).rejects.toThrow(/Bangladeshi/)
  })

  it('shows a per-courier notice when one courier fails but keeps the rest', async () => {
    const fetchFn = panelFetch({ 'merchant.pathao.com/api/v1/login': () => new Response('{}', { status: 401 }) })
    const p = new CourierPanelProvider(allCreds, { fetchFn, store: freshStore() })
    const summary = await p.lookup('01811111111')
    const pathao = summary.couriers.find((c) => c.courier === 'pathao')!
    expect(pathao.notice).toMatch(/Pathao/)
    expect(pathao.orders).toBe(0)
    // The others still counted.
    expect(summary.total).toBe(10 + 25 + 10)
  })

  it('throws only when every courier fails', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 500 }))
    const p = new CourierPanelProvider({ steadfast: { email: 'a@b.com', password: 'x' } }, { fetchFn, store: freshStore() })
    await expect(p.lookup('01811111111')).rejects.toThrow()
  })

  it('reuses the Pathao token across two lookups (one login)', async () => {
    const fetchFn = panelFetch()
    const store = freshStore()
    const p = new CourierPanelProvider({ pathao: allCreds.pathao }, { fetchFn, store })
    await p.lookup('01811111111')
    await p.lookup('01822222222')
    const logins = fetchFn.mock.calls.filter((c) => String(c[0]).includes('/api/v1/login')).length
    expect(logins).toBe(1)
  })

  it('checkCustomer returns normalised counts and the summary', async () => {
    const p = new CourierPanelProvider(allCreds, { fetchFn: panelFetch(), store: freshStore() })
    const r = await p.checkCustomer({ phone: '01811111111' })
    expect(r.ok).toBe(true)
    expect(r.counts.total).toBe(52)
    expect(r.counts.returned).toBe(summaryCancelled())
    expect(r.raw).toBeTruthy()
  })

  it('testPanelLogin reports success with a sample count', async () => {
    const r = await testPanelLogin('redx', allCreds.redx!, '01811111111', { fetchFn: panelFetch(), store: freshStore() })
    expect(r.ok).toBe(true)
    expect(r.message).toMatch(/RedX/)
  })

  it('testPanelLogin reports a bad password without leaking it', async () => {
    const fetchFn = panelFetch({ 'api.redx.com.bd/v4/auth/login': () => new Response('{}', { status: 401 }) })
    const r = await testPanelLogin('redx', { phone: '01712345678', password: 'secret-pass' }, '01811111111', { fetchFn, store: freshStore() })
    expect(r.ok).toBe(false)
    expect(r.message).not.toContain('secret-pass')
  })

  it('wires into providersFromSettings only when a login is connected', () => {
    const none = providersFromSettings({ providers: ['internal', 'courier_panel'] }, fetch, { panel: {} })
    expect(none.map((p) => p.name)).not.toContain('courier_panel')
    const on = providersFromSettings({ providers: ['internal', 'courier_panel'] }, fetch, { panel: { redx: allCreds.redx } })
    // Stored as the courier_history result, so every screen shows the lines.
    expect(on.map((p) => p.name)).toEqual(['internal', 'courier_history'])
    // Either switch asks both sources, once: never two separate (twice-charged) providers.
    const both = providersFromSettings({ providers: ['courier_history', 'courier_panel'] }, fetch, { panel: { redx: allCreds.redx }, courierHistory: { api_key: 'k', service: 'bdcourier' } })
    expect(both.map((p) => p.name)).toEqual(['courier_history'])
  })

  it('rotates between several accounts of one courier, one login per lookup', async () => {
    const fetchFn = panelFetch()
    const accounts = [{ id: 'a1', email: 'one@x.com', password: 'p1' }, { id: 'a2', email: 'two@x.com', password: 'p2' }]
    const p = new CourierPanelProvider({ pathao: accounts }, { fetchFn, store: freshStore() })
    await p.lookup('01811111111')
    await p.lookup('01822222222')
    const loginBodies = fetchFn.mock.calls
      .filter((c) => String(c[0]).includes('/api/v1/login'))
      .map((c) => JSON.parse(String((c[1] as RequestInit).body)).username)
    // Two different accounts signed in, one per lookup.
    expect(new Set(loginBodies)).toEqual(new Set(['one@x.com', 'two@x.com']))
  })

  it('falls back to the next account when one is refused', async () => {
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url.includes('/api/v1/login')) {
        const user = JSON.parse(String(init?.body)).username
        return user === 'bad@x.com' ? new Response('{}', { status: 422 }) : withCookie({ access_token: 'ok-tok' })
      }
      if (url.includes('/api/v1/user/success')) return withCookie({ data: { customer: { successful_delivery: 3, total_delivery: 4 } } })
      return new Response('nf', { status: 404 })
    })
    const p = new CourierPanelProvider({ pathao: [{ id: 'b1', email: 'bad@x.com', password: 'x' }, { id: 'b2', email: 'good@x.com', password: 'y' }] },
      { fetchFn, store: freshStore() })
    // Whichever account the rotation starts on, the lookup succeeds.
    for (const phone of ['01811111111', '01822222222']) {
      const s = await p.lookup(phone)
      expect(s.couriers.find((c) => c.courier === 'pathao')).toMatchObject({ orders: 4, delivered: 3 })
    }
  })

  it('reports every account failing when none work', async () => {
    const fetchFn = vi.fn(async () => new Response('{}', { status: 422 }))
    const p = new CourierPanelProvider({ pathao: [{ id: 'c1', email: 'a@x.com', password: 'x' }, { id: 'c2', email: 'b@x.com', password: 'y' }] }, { fetchFn, store: freshStore() })
    await expect(p.lookup('01811111111')).rejects.toThrow(/All 2 Pathao accounts failed/)
  })

  it('reads an older single saved login as one account', () => {
    expect(panelAccounts({ steadfast: { email: 'a@b.com', password: 'x' } }, 'steadfast')).toHaveLength(1)
    expect(panelAccounts({ steadfast: [{ email: 'a@b.com', password: 'x' }, { email: '', password: 'y' }] }, 'steadfast')).toHaveLength(1)
  })

  it('covers every courier id', () => {
    expect(COURIER_PANEL_PROVIDERS).toEqual(['steadfast', 'pathao', 'redx', 'carrybee'])
  })
})

function summaryCancelled(): number {
  // steadfast 2 + pathao 2 + redx 5 + carrybee 0 = 9
  return 9
}

describe('courier sign-in fixes', () => {
  it('Carrybee: a token with "|" in it (Laravel style) still reaches the right business', async () => {
    const fetchFn = panelFetch({ 'merchant.carrybee.com/api/auth/session': () => withCookie({ accessToken: '4521|abcDEF', user: { selectedBusinessId: 'biz-9' } }) })
    const r = await testPanelLogin('carrybee', allCreds.carrybee as never, '01811111111', { fetchFn, store: freshStore() })
    expect(r.ok).toBe(true)
    const read = fetchFn.mock.calls.find(([u]) => String(u).includes('/customers/'))!
    expect(String(read[0])).toBe('https://api-merchant.carrybee.com/api/v2/businesses/biz-9/customers/%2B8801811111111')
    expect((read[1]!.headers as Record<string, string>).Authorization).toBe('Bearer 4521|abcDEF')
  })

  it('Steadfast: a login sent back to /login is a wrong password, not "0 parcels"', async () => {
    const fetchFn = panelFetch({ 'steadfast.com.bd/login': () => new Response('', { status: 302, headers: new Headers({ location: 'https://steadfast.com.bd/login' }) }) })
    // The GET of the login page must still answer the form, so route by method.
    const real = panelFetch()
    const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => ((init?.method ?? 'GET') === 'POST' ? fetchFn(input, init) : real(input, init)))
    const r = await testPanelLogin('steadfast', allCreds.steadfast as never, '01811111111', { fetchFn: f, store: freshStore() })
    expect(r).toMatchObject({ ok: false, message: 'Steadfast rejected the email or password' })
  })

  it('Steadfast: a fraud page that redirects (signed out) is not counted as zero', async () => {
    const fetchFn = panelFetch({ '/user/frauds/check/': () => new Response('', { status: 302, headers: new Headers({ location: '/login' }) }) })
    const r = await testPanelLogin('steadfast', allCreds.steadfast as never, '01811111111', { fetchFn, store: freshStore() })
    expect(r.ok).toBe(false)
  })
})

describe('courier relay (the Worker sends courier work to Supabase)', () => {
  it('a provider without a stand-in fetch hands the lookup to the relay', async () => {
    const lookup = vi.fn(async () => ({ couriers: [], total: 3, delivered: 2, cancelled: 1, success_ratio: 66.67, ratio_source: 'counts' as const, name_on_record: null, parcel_floor: 3 }))
    setPanelRelay({ lookup, test: vi.fn() })
    try {
      const p = new CourierPanelProvider({ redx: allCreds.redx })
      const r = await p.checkCustomer({ phone: '+8801811111111' })
      expect(lookup).toHaveBeenCalledWith('01811111111')
      expect(r).toMatchObject({ ok: true, counts: { total: 3, delivered: 2, returned: 1 } })
      // Tests that hand in a fetch still run locally.
      const local = new CourierPanelProvider({ redx: allCreds.redx }, { fetchFn: panelFetch(), store: freshStore() })
      await local.lookup('01811111111')
      expect(lookup).toHaveBeenCalledTimes(1)
    } finally {
      setPanelRelay(null)
    }
  })

  it('login tests go through the relay too', async () => {
    const test = vi.fn(async () => ({ ok: true, message: 'RedX: signed in' }))
    setPanelRelay({ lookup: vi.fn(), test })
    try {
      expect(await testPanelLogin('redx', allCreds.redx as never, '01811111111')).toEqual({ ok: true, message: 'RedX: signed in' })
      expect(test).toHaveBeenCalledWith('redx', allCreds.redx, '01811111111')
    } finally {
      setPanelRelay(null)
    }
  })

  it('a relay that refuses or cannot be reached fails the login test with its reason, never a crash', async () => {
    const test = vi.fn(async () => { throw new Error('Courier check service refused this site — its server key was not accepted') })
    setPanelRelay({ lookup: vi.fn(), test })
    try {
      expect(await testPanelLogin('pathao', allCreds.pathao as never, '01811111111'))
        .toEqual({ ok: false, message: 'Courier check service refused this site — its server key was not accepted' })
    } finally {
      setPanelRelay(null)
    }
  })

  it('the HTTP relay sends the shared secret and only the phone for a lookup', async () => {
    const summary = { couriers: [], total: 1, delivered: 1, cancelled: 0, success_ratio: 100, ratio_source: 'counts', name_on_record: null, parcel_floor: 1 }
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, summary }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    const relay = httpPanelRelay({ url: 'https://p.supabase.co/functions/v1/courier-relay', cronSecret: 'cron-s', serviceKey: 'svc', fetchFn })
    expect(await relay.lookup('01811111111')).toEqual(summary)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://p.supabase.co/functions/v1/courier-relay')
    expect(init.headers).toMatchObject({ 'x-cron-secret': 'cron-s', Authorization: 'Bearer svc' })
    expect(JSON.parse(String(init.body))).toEqual({ action: 'lookup', phone: '01811111111' })
  })

  it('BD Courier goes through the relay too (it refuses Cloudflare Workers); a stand-in fetch still runs locally', async () => {
    const summary = { couriers: [{ courier: 'steadfast', orders: 10, cancelled: 1, delivered: 9 }], total: 10, delivered: 9, cancelled: 1, success_ratio: 90, ratio_source: 'provider' as const, name_on_record: null, parcel_floor: 10, service: 'bdcourier' as const }
    const history = vi.fn(async () => summary)
    setHistoryRelay(history)
    try {
      const viaRelay = await new CourierHistoryProvider({ apiKey: 'bd-key', service: 'bdcourier' }).checkCustomer({ phone: '+8801811111111' })
      expect(history).toHaveBeenCalledWith('01811111111')
      expect(viaRelay).toMatchObject({ ok: true, counts: { total: 10, delivered: 9, returned: 1 }, courierScore: 90 })
      // The global fetch (what the check service passes) is not a stand-in: still the relay.
      await new CourierHistoryProvider({ apiKey: 'bd-key', service: 'bdcourier' }, globalThis.fetch).lookup('01811111111')
      expect(history).toHaveBeenCalledTimes(2)
      // A test's (or the relay's own) fetch runs here.
      const fetchFn = vi.fn(async () => new Response(JSON.stringify({ status: 'success', data: { summary: { total_parcel: 2, success_parcel: 2, cancelled_parcel: 0 } } }), { status: 200 }))
      const local = await new CourierHistoryProvider({ apiKey: 'bd-key', service: 'bdcourier' }, fetchFn).lookup('01811111111')
      expect(fetchFn).toHaveBeenCalledTimes(1)
      expect(history).toHaveBeenCalledTimes(2)
      expect(local.total).toBe(2)
      // A relay failure is a readable reason, not a crash.
      history.mockRejectedValueOnce(new Error('Could not reach the courier check service'))
      expect(await new CourierHistoryProvider({ apiKey: 'bd-key' }).checkCustomer({ phone: '01811111111' }))
        .toEqual({ provider: 'courier_history', ok: false, counts: {}, error: 'Could not reach the courier check service' })
    } finally {
      setHistoryRelay(null)
    }
  })

  it('on the Worker a check gets BD Courier and the courier sign-ins from the relay, merged', async () => {
    const history = vi.fn(async () => ({
      couriers: [{ courier: 'pathao', orders: 5, cancelled: 1, delivered: 4 }, { courier: 'steadfast', orders: 8, cancelled: 0, delivered: 8 }],
      total: 13, delivered: 12, cancelled: 1, success_ratio: 92.31, ratio_source: 'provider' as const, name_on_record: null, parcel_floor: 13, service: 'bdcourier' as const,
    }))
    const lookup = vi.fn(async () => ({
      couriers: [{ courier: 'pathao', name: 'Pathao', orders: 72, cancelled: 1, delivered: 71, success_ratio: 98.61, notice: null }],
      total: 72, delivered: 71, cancelled: 1, success_ratio: 98.61, ratio_source: 'counts' as const, name_on_record: null, parcel_floor: 72,
    }))
    setHistoryRelay(history)
    setPanelRelay({ lookup, test: vi.fn() })
    try {
      const [source] = providersFromSettings({ providers: [] }, globalThis.fetch, { courierHistory: { api_key: 'bd-key', service: 'bdcourier' }, panel: { pathao: allCreds.pathao } })
        .filter((p) => p.name === 'courier_history')
      const r = await source.checkCustomer({ phone: '01811111111' })
      expect(history).toHaveBeenCalledWith('01811111111')
      expect(lookup).toHaveBeenCalledWith('01811111111')
      // Pathao from the sign-in (72) replaces BD Courier's Pathao (5); Steadfast stays from BD Courier.
      expect(r).toMatchObject({ ok: true, counts: { total: 80, delivered: 79, returned: 1 } })
      expect((r.raw as { source_notes?: string[] }).source_notes).toBeUndefined()
    } finally {
      setHistoryRelay(null)
      setPanelRelay(null)
    }
  })

  it('the HTTP relay asks for BD Courier with only the phone', async () => {
    const summary = { couriers: [], total: 0, delivered: 0, cancelled: 0, success_ratio: null, ratio_source: 'counts', name_on_record: null, parcel_floor: 0 }
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ ok: true, summary }), { status: 200 }))
    const relay = httpPanelRelay({ url: 'https://p.supabase.co/functions/v1/courier-relay', cronSecret: 'cron-s', fetchFn })
    expect(await relay.history('01811111111')).toEqual(summary)
    expect(JSON.parse(String((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ action: 'history', phone: '01811111111' })
    const failed = httpPanelRelay({ url: 'https://x/courier-relay', fetchFn: vi.fn(async () => new Response(JSON.stringify({ ok: false, message: 'BD Courier: daily limit reached' }), { status: 200 })) })
    await expect(failed.history('01811111111')).rejects.toThrow('BD Courier: daily limit reached')
  })

  it('the HTTP relay turns a refusal or a failed lookup into a readable error', async () => {
    const refused = httpPanelRelay({ url: 'https://x/courier-relay', fetchFn: vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Not allowed' } }), { status: 401 })) })
    await expect(refused.lookup('01811111111')).rejects.toThrow('Courier check service refused this site')
    const failed = httpPanelRelay({ url: 'https://x/courier-relay', fetchFn: vi.fn(async () => new Response(JSON.stringify({ ok: false, message: 'RedX: rate limit' }), { status: 200 })) })
    await expect(failed.lookup('01811111111')).rejects.toThrow('RedX: rate limit')
  })
})

describe('Steadfast new sign-in page and RedX 400', () => {
  const newPage = `<html><head><title>Merchant sign-in</title><meta name="csrf-token" content="meta-tok"></head><body>
    <form method="POST" action="/merchant/login"><input type="text" name="login" placeholder="Email or phone">
    <input type="password" name="password"><input type="checkbox" name="remember"></form></body></html>`

  it('reads the newer form: email-or-phone field, token from the meta tag, its own action', () => {
    expect(readLoginForm(newPage, 'https://steadfast.com.bd/login')).toEqual({
      action: 'https://steadfast.com.bd/merchant/login', fields: { _token: 'meta-tok' }, idField: 'login', passwordField: 'password',
    })
    expect(readLoginForm('<form action="/login"><input type="hidden" name="_token" value="a&amp;b"><input type="email" name="email"><input type="password" name="password"></form>', 'https://steadfast.com.bd/login'))
      .toMatchObject({ fields: { _token: 'a&b' }, idField: 'email' })
    expect(readLoginForm('<p>maintenance</p>', 'https://steadfast.com.bd/login')).toBeNull()
  })

  it('signs in through the newer page and reads the fraud page', async () => {
    const posts: Array<{ url: string; body: string }> = []
    const fetchFn = panelFetch({
      'steadfast.com.bd/merchant/login': () => new Response('', { status: 302, headers: new Headers({ location: '/dashboard', 'set-cookie': 'sf_auth=2; Path=/' }) }),
      'steadfast.com.bd/login': () => htmlRes(newPage, 'XSRF-TOKEN=x%3Dy; Path=/'),
    })
    const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') posts.push({ url: String(input), body: String(init?.body) })
      return fetchFn(input, init)
    })
    const r = await testPanelLogin('steadfast', allCreds.steadfast as never, '01811111111', { fetchFn: spy, store: freshStore() })
    expect(r).toEqual({ ok: true, message: 'Steadfast: signed in — 8 of 10 parcels delivered for 01811111111' })
    expect(posts[0].url).toBe('https://steadfast.com.bd/merchant/login')
    expect(new URLSearchParams(posts[0].body).get('login')).toBe('shop@x.com')
    expect(new URLSearchParams(posts[0].body).get('_token')).toBe('meta-tok')
  })

  it('says when Steadfast shows a firewall check instead of the sign-in page', async () => {
    const fetchFn = panelFetch({ 'steadfast.com.bd/login': () => htmlRes('<title>Just a moment...</title><div id="challenge-platform"></div>') })
    const r = await testPanelLogin('steadfast', allCreds.steadfast as never, '01811111111', { fetchFn, store: freshStore(), retryPauseMs: 0 })
    expect(r).toEqual({ ok: false, message: 'Steadfast sign-in: its firewall asked for a browser check — try again in a minute' })
    // It looked twice before giving up.
    expect(fetchFn.mock.calls.filter(([u]) => String(u).includes('steadfast.com.bd/login'))).toHaveLength(2)
  })

  it('reads the fraud numbers from a nested answer, and names what came back when they are missing', () => {
    expect(parseSteadfast({ status: 200, data: { total_delivered: '12', total_cancelled: 3 } })).toMatchObject({ ok: true, success: 12, cancel: 3, total: 15 })
    expect(parseSteadfast({ message: 'Unauthenticated.' }).error).toBe("Steadfast's fraud page gave an unexpected answer: Unauthenticated.")
    expect(parseSteadfast({ foo: 1, bar: 2 }).error).toBe("Steadfast's fraud page gave an unexpected answer (fields: foo, bar)")
  })

  it('RedX: a 400 for one way of writing the number tries the others', async () => {
    const urls: string[] = []
    const fetchFn = panelFetch({
      'customer-success-return-rate': () => {
        const last = urls[urls.length - 1]
        return last.endsWith('phoneNumber=01811111111')
          ? withCookie({ data: { deliveredParcels: 4, totalParcels: 5 } })
          : withCookie({ message: 'Invalid phone number' }, undefined, 400)
      },
    })
    const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => { urls.push(String(input)); return fetchFn(input, init) })
    const r = await testPanelLogin('redx', allCreds.redx as never, '01811111111', { fetchFn: spy, store: freshStore() })
    expect(r).toEqual({ ok: true, message: 'RedX: signed in — 4 of 5 parcels delivered for 01811111111' })

    const always400 = panelFetch({ 'customer-success-return-rate': () => withCookie({ message: 'Invalid phone number' }, undefined, 400) })
    const bad = await testPanelLogin('redx', allCreds.redx as never, '01811111111', { fetchFn: always400, store: freshStore() })
    expect(bad).toEqual({ ok: false, message: 'RedX answered HTTP 400: Invalid phone number' })
  })
})

describe('Steadfast\'s new fraud answer, firewall retry, couriers\' own error reasons', () => {
  const newAnswer = { delivery_ratio: 92.5, cancellation_ratio: 7.5, volume_band: '100+', volume_range: { min: 100, max: null }, fraud_reports: [{ id: 1 }, { id: 2 }], fraud_categories: ['Fake order'] }

  it('reads delivery_ratio, the volume band and the reports — and makes up no parcel counts', () => {
    expect(parseSteadfast(newAnswer)).toEqual({ ok: true, success: 0, cancel: 0, total: 0, success_ratio: 92.5, rate_only: true, parcel_range: '100+', reports: 2 })
    // Written as text, nested, or with a range instead of a band.
    expect(parseSteadfast({ data: { delivery_ratio: '88.2%', cancellation_ratio: '11.8%', volume_range: '51-100' } }))
      .toMatchObject({ ok: true, success_ratio: 88.2, rate_only: true, parcel_range: '51–100' })
    // Written as fractions.
    expect(parseSteadfast({ delivery_ratio: 0.9, cancellation_ratio: 0.1, volume_band: 'High' })).toMatchObject({ success_ratio: 90, parcel_range: 'High' })
    // Only the cancellation rate.
    expect(parseSteadfast({ cancellation_ratio: 20, volume_band: '11-50' })).toMatchObject({ success_ratio: 80, parcel_range: '11–50' })
    // No history: no rate, no band — "no parcels", not 0 %.
    expect(parseSteadfast({ delivery_ratio: 0, cancellation_ratio: 0, volume_band: '0', fraud_reports: [] }))
      .toEqual({ ok: true, success: 0, cancel: 0, total: 0, success_ratio: null })
    // The old counts still win when Steadfast sends them.
    expect(parseSteadfast({ total_delivered: 8, total_cancelled: 2, fraud_reports: 1 })).toMatchObject({ ok: true, success: 8, cancel: 2, total: 10, reports: 1 })
  })

  it('a check with only Steadfast\'s rate uses that rate and its band as the evidence', async () => {
    const fetchFn = panelFetch({ '/user/frauds/check/': () => withCookie(newAnswer) })
    const p = new CourierPanelProvider({ steadfast: allCreds.steadfast }, { fetchFn, store: freshStore() })
    const s = await p.lookup('01811111111')
    expect(s.couriers[0]).toMatchObject({ courier: 'steadfast', rate_only: true, parcel_range: '100+', success_ratio: 92.5, fraud_reports: 2, source: 'sign_in' })
    expect(s).toMatchObject({ total: 0, success_ratio: 92.5, ratio_source: 'provider', parcel_floor: 100 })
    expect(await p.checkCustomer({ phone: '01811111111' })).toMatchObject({ ok: true, courierScore: 92.5, parcelFloor: 100 })
    expect(await testPanelLogin('steadfast', allCreds.steadfast as never, '01811111111', { fetchFn, store: freshStore() }))
      .toEqual({ ok: true, message: 'Steadfast: signed in — 92.5% delivered, volume 100+, 2 fraud reports for 01811111111 (rate only, no parcel counts)' })
  })

  it('looks again once when the firewall asks for a browser check, then signs in', async () => {
    let page = 0
    const fetchFn = panelFetch({
      'steadfast.com.bd/login': () => (++page === 1
        ? htmlRes('<title>Just a moment...</title><div id="challenge-platform"></div>')
        : htmlRes('<input type="hidden" name="_token" value="tok-sf">', 'sf_sess=1; Path=/')),
    })
    const posting = vi.fn(async (input: string | URL | Request, init?: RequestInit) =>
      (String(input).includes('steadfast.com.bd/login') && init?.method === 'POST'
        ? new Response('', { status: 302, headers: new Headers({ 'set-cookie': 'sf_auth=2; Path=/' }) })
        : fetchFn(input, init)))
    const r = await testPanelLogin('steadfast', allCreds.steadfast as never, '01811111111', { fetchFn: posting, store: freshStore(), retryPauseMs: 0 })
    expect(r).toEqual({ ok: true, message: 'Steadfast: signed in — 8 of 10 parcels delivered for 01811111111' })
  })

  it('Carrybee: reads /customers/+8801…, and a 404 about the customer is no history', async () => {
    const fetchFn = panelFetch({ '/customers/': () => withCookie({ data: { total_order: 4, cancelled_order: 1, success_rate: 75, fraud_count: 2 } }) })
    expect(await testPanelLogin('carrybee', allCreds.carrybee as never, '01811111111', { fetchFn, store: freshStore() }))
      .toEqual({ ok: true, message: 'Carrybee: signed in — 3 of 4 parcels delivered for 01811111111, 2 fraud reports' })
    const read = fetchFn.mock.calls.find(([u]) => String(u).includes('/customers/'))!
    expect(read[1]!.headers).toMatchObject({ Origin: 'https://merchant.carrybee.com', Referer: 'https://merchant.carrybee.com/' })
    // Only the new address was needed.
    expect(fetchFn.mock.calls.some(([u]) => String(u).includes('/fraud-check/'))).toBe(false)

    const notCarried = panelFetch({ '/customers/': () => withCookie({ message: 'Customer not found' }, undefined, 404) })
    expect(await testPanelLogin('carrybee', allCreds.carrybee as never, '01811111111', { fetchFn: notCarried, store: freshStore() }))
      .toEqual({ ok: true, message: 'Carrybee: signed in — no parcels on record for 01811111111. To be sure the lookup reads real data, test once with a number that has Carrybee parcels.' })
  })

  it('Carrybee: when the new address is missing or refuses, the older fraud-check address is tried', async () => {
    // A missing route is not "no history".
    const noRoute = panelFetch({ '/customers/': () => new Response('Cannot GET /api/v2/businesses/biz-9/customers', { status: 404 }) })
    expect(await testPanelLogin('carrybee', allCreds.carrybee as never, '01811111111', { fetchFn: noRoute, store: freshStore() }))
      .toEqual({ ok: true, message: 'Carrybee: signed in — 10 of 10 parcels delivered for 01811111111' })
    expect(noRoute.mock.calls.some(([u]) => String(u).endsWith('/fraud-check/01811111111'))).toBe(true)

    // Both refuse: the new address's reason is shown, whatever field it is in.
    const both = (res: () => Response) => panelFetch({ '/customers/': res, '/fraud-check/': () => new Response('', { status: 400 }) })
    const said = async (res: () => Response) => (await testPanelLogin('carrybee', allCreds.carrybee as never, '01811111111', { fetchFn: both(res), store: freshStore() })).message
    expect(await said(() => withCookie({ errors: { phone: ['The phone format is invalid.'] } }, undefined, 400))).toBe('Carrybee answered HTTP 400: The phone format is invalid.')
    expect(await said(() => withCookie({ status: 'failed', code: 'E12' }, undefined, 400))).toBe('Carrybee answered HTTP 400: status: failed, code: E12')
    expect(await said(() => new Response('', { status: 400 }))).toBe('Carrybee answered HTTP 400: empty answer')
    expect(await said(() => withCookie({ message: 'No order found for +8801811111111' }, undefined, 400)))
      .toBe('Carrybee: signed in — no parcels on record for 01811111111. To be sure the lookup reads real data, test once with a number that has Carrybee parcels.')
  })

  it('Carrybee: errors inside a 200, a refused session, an expired cached session, and the business id', async () => {
    const hidden = panelFetch({ '/customers/': () => withCookie({ error: true, message: 'Token expired' }) })
    expect(await testPanelLogin('carrybee', allCreds.carrybee as never, '01811111111', { fetchFn: hidden, store: freshStore() }))
      .toEqual({ ok: false, message: 'Carrybee: Token expired' })

    const odd = panelFetch({ '/customers/': () => withCookie({ customer: { id: 1 } }) })
    expect(await testPanelLogin('carrybee', allCreds.carrybee as never, '01811111111', { fetchFn: odd, store: freshStore() }))
      .toEqual({ ok: false, message: 'Carrybee gave an unexpected answer (fields: customer)' })

    const refused = panelFetch({ '/customers/': () => withCookie({ message: 'Unauthenticated.' }, undefined, 401) })
    expect(await testPanelLogin('carrybee', allCreds.carrybee as never, '01811111111', { fetchFn: refused, store: freshStore() }))
      .toEqual({ ok: false, message: 'Carrybee signed in, but refused the new session for the lookup (HTTP 401)' })

    // The business id can sit under merchantBusinesses instead of selectedBusinessId.
    const listed = panelFetch({ 'merchant.carrybee.com/api/auth/session': () => withCookie({ accessToken: 'cb-tok', user: { merchantBusinesses: [{ businessId: 'biz-7' }] } }) })
    expect((await testPanelLogin('carrybee', allCreds.carrybee as never, '01811111111', { fetchFn: listed, store: freshStore() })).ok).toBe(true)
    expect(listed.mock.calls.some(([u]) => String(u).includes('/businesses/biz-7/customers/'))).toBe(true)
    const noBusiness = panelFetch({ 'merchant.carrybee.com/api/auth/session': () => withCookie({ accessToken: 'cb-tok', user: {} }) })
    expect((await testPanelLogin('carrybee', allCreds.carrybee as never, '01811111111', { fetchFn: noBusiness, store: freshStore() })).message)
      .toMatch(/no business selected/)

    // A cached session that Carrybee no longer accepts signs in again instead of failing.
    let answers = 0
    const fetchFn = panelFetch({
      '/customers/': () => (++answers === 2 ? withCookie({}, undefined, 401) : withCookie({ data: { total_order: 2, cancelled_order: 0, success_rate: 100 } })),
    })
    const p = new CourierPanelProvider({ carrybee: allCreds.carrybee }, { fetchFn, store: freshStore() })
    await p.lookup('01811111111') // signs in (answer 1) and keeps the session
    const s = await p.lookup('01811111111') // the kept session gets a 401 (answer 2) → signs in again (answer 3)
    expect(s.couriers[0]).toMatchObject({ courier: 'carrybee', orders: 2, delivered: 2 })
    expect(fetchFn.mock.calls.filter(([u]) => String(u).includes('/api/auth/session')).length).toBe(2)
  })

  it('RedX: sends the headers its own site sends, and shows what a refusal said', async () => {
    const fetchFn = panelFetch()
    await testPanelLogin('redx', allCreds.redx as never, '01811111111', { fetchFn, store: freshStore() })
    const read = fetchFn.mock.calls.find(([u]) => String(u).includes('customer-success-return-rate'))!
    expect(read[1]!.headers).toMatchObject({ Origin: 'https://redx.com.bd', Referer: 'https://redx.com.bd/' })
    expect((read[1]!.headers as Record<string, string>)['User-Agent']).toMatch(/Chrome\/\d+/)

    const page = panelFetch({ 'customer-success-return-rate': () => new Response('<html><title>400 Bad Request</title></html>', { status: 400 }) })
    expect(await testPanelLogin('redx', allCreds.redx as never, '01811111111', { fetchFn: page, store: freshStore() }))
      .toEqual({ ok: false, message: 'RedX answered HTTP 400: 400 Bad Request' })
    const coded = panelFetch({ 'customer-success-return-rate': () => withCookie({ isError: true, errorCode: 'PHONE_MISMATCH', phone: '8801811111111' }, undefined, 400) })
    expect(await testPanelLogin('redx', allCreds.redx as never, '01811111111', { fetchFn: coded, store: freshStore() }))
      .toEqual({ ok: false, message: 'RedX answered HTTP 400: isError: true, errorCode: PHONE_MISMATCH, phone: …' })
  })

  it('Steadfast: "none" is no history, and total_reports counts the reports', () => {
    expect(parseSteadfast({ delivery_ratio: null, cancellation_ratio: null, volume_band: 'none', total_reports: 0 }))
      .toEqual({ ok: true, success: 0, cancel: 0, total: 0, success_ratio: null })
    expect(parseSteadfast({ delivery_ratio: 70, cancellation_ratio: 30, volume_band: 'low', volume_range: '1-5', total_reports: 3 }))
      .toMatchObject({ success_ratio: 70, parcel_range: '1–5', reports: 3 })
  })

  it('reads a courier\'s reason from whichever field it uses', () => {
    expect(answerDetail({ message: 'Invalid phone number' })).toBe('Invalid phone number')
    expect(answerDetail({ message: ['a', 'b'] })).toBe('a; b')
    expect(answerDetail({ error: { message: 'Not verified' } })).toBe('Not verified')
    expect(answerDetail({ error: true, errors: { phone: ['Bad phone'] } })).toBe('Bad phone')
    expect(answerDetail({ detail: 'Too many' })).toBe('Too many')
    expect(answerDetail(null)).toBe('')
  })
})
