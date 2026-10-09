import { describe, expect, it, vi } from 'vitest'
import { emailFromIdToken, GoogleAdsClient, googleAuthUrl } from './ads/google.ts'
import { TikTokClient, tiktokAuthUrl } from './ads/tiktok.ts'

const res = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const ok = (data: unknown) => res({ code: 0, message: 'OK', data })

describe('TikTok Ads client', () => {
  it('sends staff to the TikTok consent screen with our app, state and redirect URI', () => {
    const url = new URL(tiktokAuthUrl('7123', 'st4te', 'https://x.supabase.co/functions/v1/ad-platforms/callback/tiktok'))
    expect(url.pathname).toBe('/portal/auth')
    expect(Object.fromEntries(url.searchParams)).toEqual({ app_id: '7123', state: 'st4te', redirect_uri: 'https://x.supabase.co/functions/v1/ad-platforms/callback/tiktok' })
  })

  it('exchanges the auth code and lists advertisers with currency and time zone', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('oauth2/access_token')) return ok({ access_token: 'tok-abc', advertiser_ids: ['111', 222] })
      if (url.includes('oauth2/advertiser/get')) return ok({ list: [{ advertiser_id: '111', advertiser_name: 'Main' }, { advertiser_id: '222', advertiser_name: 'Second' }] })
      if (url.includes('advertiser/info')) return ok({ list: [{ advertiser_id: '111', name: 'Main', currency: 'USD', display_timezone: 'Asia/Dhaka' }] })
      throw new Error(`unexpected ${url} ${init?.method}`)
    })
    const c = new TikTokClient(fetchFn as typeof fetch)
    const app = { appId: '7123', secret: 's'.repeat(40) }
    expect(await c.exchange(app, 'code-1')).toEqual({ accessToken: 'tok-abc', advertiserIds: ['111', '222'] })
    const [, init] = fetchFn.mock.calls[0]
    expect(JSON.parse(String(init!.body))).toEqual({ app_id: '7123', secret: 's'.repeat(40), auth_code: 'code-1' })
    const advertisers = await c.advertisers(app, 'tok-abc', ['111', '222'])
    expect(advertisers).toEqual([
      { external_id: '111', name: 'Main', currency: 'USD', timezone: 'Asia/Dhaka' },
      { external_id: '222', name: 'Second', currency: null, timezone: null },
    ])
    // The token goes in a header, never in the URL.
    const listCall = fetchFn.mock.calls.find(([u]) => String(u).includes('advertiser/get'))!
    expect(String(listCall[0])).not.toContain('tok-abc')
    expect((listCall[1]!.headers as Record<string, string>)['Access-Token']).toBe('tok-abc')
  })

  it('reads daily campaign numbers across pages and explains errors', async () => {
    let page = 0
    const fetchFn = vi.fn(async () => {
      page++
      return ok({
        list: [{ dimensions: { campaign_id: `9${page}`, stat_time_day: '2026-10-01 00:00:00' }, metrics: { spend: '12.50', impressions: '1000', clicks: '20', conversion: '2' } }],
        page_info: { total_page: 2 },
      })
    })
    const rows = await new TikTokClient(fetchFn as typeof fetch).daily('t', '111', '2026-10-01', '2026-10-01')
    expect(rows).toEqual([
      { campaign_id: '91', date: '2026-10-01', spend: 12.5, impressions: 1000, clicks: 20, conversions: 2, conversion_value: 0 },
      { campaign_id: '92', date: '2026-10-01', spend: 12.5, impressions: 1000, clicks: 20, conversions: 2, conversion_value: 0 },
    ])
    const bad = new TikTokClient(vi.fn(async () => res({ code: 40105, message: 'Access token is invalid' })) as typeof fetch)
    await expect(bad.campaigns('t', '111')).rejects.toMatchObject({ message: 'TikTok: Access token is invalid', tokenInvalid: true })
  })
})

describe('Google Ads client', () => {
  const app = { clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'secret-xyz', developerToken: 'DEVTOKEN_1234567890ab' }

  it('asks for offline access so a refresh token comes back', () => {
    const url = new URL(googleAuthUrl(app.clientId, 'st', 'https://x/cb'))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: app.clientId, redirect_uri: 'https://x/cb', response_type: 'code', access_type: 'offline', prompt: 'consent', state: 'st',
    })
    expect(url.searchParams.get('scope')).toContain('https://www.googleapis.com/auth/adwords')
  })

  it('exchanges the code, reads the email and lists customers including manager clients', async () => {
    const idToken = `x.${btoa(JSON.stringify({ email: 'ads@shop.com' })).replace(/=+$/, '')}.y`
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/token')) return res({ access_token: 'acc', refresh_token: 'ref', id_token: idToken })
      if (url.endsWith('customers:listAccessibleCustomers')) return res({ resourceNames: ['customers/1112223333'] })
      const body = JSON.parse(String(init!.body ?? '{}'))
      if (String(body.query).includes('FROM customer_client')) {
        expect((init!.headers as Record<string, string>)['login-customer-id']).toBe('1112223333')
        return res({ results: [{ customerClient: { id: '4445556666', descriptiveName: 'Shop BD', currencyCode: 'BDT', timeZone: 'Asia/Dhaka', manager: false } }] })
      }
      if (String(body.query).includes('FROM customer ')) return res({ results: [{ customer: { id: '1112223333', descriptiveName: 'Agency MCC', currencyCode: 'USD', manager: true } }] })
      throw new Error(`unexpected ${url}`)
    })
    const c = new GoogleAdsClient(app, fetchFn as typeof fetch)
    expect(await c.exchange('code', 'https://x/cb')).toEqual({ refreshToken: 'ref', accessToken: 'acc', email: 'ads@shop.com' })
    const form = new URLSearchParams(String(fetchFn.mock.calls[0][1]!.body))
    expect(Object.fromEntries(form)).toMatchObject({ code: 'code', grant_type: 'authorization_code', client_id: app.clientId, client_secret: 'secret-xyz' })
    const customers = await c.customers('acc')
    expect(customers).toEqual([
      { external_id: '1112223333', login_customer_id: null, name: 'Agency MCC', currency: 'USD', timezone: null, is_manager: true },
      { external_id: '4445556666', login_customer_id: '1112223333', name: 'Shop BD', currency: 'BDT', timezone: 'Asia/Dhaka', is_manager: false },
    ])
    const adsCall = fetchFn.mock.calls.find(([u]) => String(u).includes('listAccessibleCustomers'))!
    expect((adsCall[1]!.headers as Record<string, string>)['developer-token']).toBe(app.developerToken)
  })

  it('reads cost in micros per campaign and day, and explains Google errors', async () => {
    const c = new GoogleAdsClient(app, vi.fn(async () => res({
      results: [{ campaign: { id: '77' }, segments: { date: '2026-10-02' }, metrics: { costMicros: '1250000', impressions: '300', clicks: '9', conversions: 1.5, conversionsValue: 2400 } }],
    })) as typeof fetch)
    expect(await c.daily('acc', '4445556666', '2026-10-01', '2026-10-02')).toEqual([
      { campaign_id: '77', date: '2026-10-02', spend: 1.25, impressions: 300, clicks: 9, conversions: 1.5, conversion_value: 2400 },
    ])
    const notApproved = new GoogleAdsClient(app, vi.fn(async () => res({
      error: { code: 403, status: 'PERMISSION_DENIED', details: [{ errors: [{ errorCode: { authorizationError: 'DEVELOPER_TOKEN_NOT_APPROVED' }, message: 'x' }] }] },
    }, 403)) as typeof fetch)
    await expect(notApproved.campaigns('acc', '1')).rejects.toThrow(/only approved for test accounts/)
    const badGrant = new GoogleAdsClient(app, vi.fn(async () => res({ error: 'invalid_grant' }, 400)) as typeof fetch)
    await expect(badGrant.accessToken('r')).rejects.toMatchObject({ tokenInvalid: true })
    expect(emailFromIdToken('garbage')).toBeNull()
  })
})
