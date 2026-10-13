import { describe, expect, it, vi } from 'vitest'
import {
  COURIER_PANEL_PROVIDERS, CourierPanelProvider, type CourierPanelCreds, panelAccounts, type SessionStore, testPanelLogin,
} from './fraud/courier-panel.ts'
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
    if (url.includes('api-merchant.carrybee.com') && url.includes('/fraud-check/')) return withCookie({ data: { total_order: 10, cancelled_order: 0, success_rate: 100 } })
    // Paperfly
    if (url.includes('login_using_password.php')) return withCookie({ token: 'pf-tok' })
    if (url.includes('smart-check/list.php')) return withCookie({ totalRecords: 3, records: [{ status: 'Delivered' }, { status: 'Delivered' }, { status: 'Returned' }] })
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
  paperfly: { user: 'shopuser', password: 'p5' },
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
    // Steadfast 8/10, Pathao 5/7, RedX 20/25, Carrybee 10/10, Paperfly total 3 (2 delivered,1 cancel)
    const by = Object.fromEntries(summary.couriers.map((c) => [c.courier, c]))
    expect(by.steadfast).toMatchObject({ orders: 10, delivered: 8, cancelled: 2 })
    expect(by.pathao).toMatchObject({ orders: 7, delivered: 5, cancelled: 2 })
    expect(by.redx).toMatchObject({ orders: 25, delivered: 20, cancelled: 5 })
    expect(by.carrybee).toMatchObject({ orders: 10, delivered: 10, cancelled: 0 })
    expect(summary.total).toBe(10 + 7 + 25 + 10 + 3)
    expect(summary.delivered).toBe(8 + 5 + 20 + 10 + 2)
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
    expect(summary.total).toBe(10 + 25 + 10 + 3)
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
    expect(r.counts.total).toBe(55)
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
    expect(on.map((p) => p.name)).toContain('courier_panel')
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
    expect(COURIER_PANEL_PROVIDERS).toHaveLength(5)
  })
})

function summaryCancelled(): number {
  // steadfast 2 + pathao 2 + redx 5 + carrybee 0 + paperfly 1 = 10
  return 10
}
