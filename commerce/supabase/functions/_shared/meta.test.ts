import { describe, expect, it, vi } from 'vitest'
import { dateWindows, fetchInsights, listAdAccounts, listPages, mapInsight, MetaApiError, MetaGraph, pickPurchase } from './meta/graph.ts'

const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

describe('Meta Graph client', () => {
  it('sends the token as a bearer header, never in the URL, and adds appsecret_proof', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ data: [] }))
    await new MetaGraph('EAAtoken123456789012345', { fetchFn, appSecret: 'shh', baseUrl: 'https://graph.example' }).get('me/adaccounts', { fields: 'id' })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toMatch(/^https:\/\/graph\.example\/v\d+\.\d+\/me\/adaccounts\?/)
    expect(url).not.toContain('EAAtoken')
    expect(new URL(url).searchParams.get('appsecret_proof')).toMatch(/^[0-9a-f]{64}$/)
    expect(init.headers.Authorization).toBe('Bearer EAAtoken123456789012345')
  })

  it('follows paging and maps ad accounts', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(reply({ data: [{ id: 'act_1', name: 'Isolation', currency: 'USD', timezone_name: 'Asia/Dhaka', account_status: 1 }], paging: { next: 'https://graph.example/v23.0/me/adaccounts?after=abc' } }))
      .mockResolvedValueOnce(reply({ data: [{ account_id: '2', name: 'Second', currency: 'BDT' }] }))
    const accounts = await listAdAccounts(new MetaGraph('t'.repeat(30), { fetchFn, baseUrl: 'https://graph.example' }))
    expect(accounts).toEqual([
      { id: 'act_1', name: 'Isolation', currency: 'USD', timezone: 'Asia/Dhaka', status: 1 },
      { id: 'act_2', name: 'Second', currency: 'BDT', timezone: null, status: null },
    ])
    expect(fetchFn.mock.calls[1][0]).toBe('https://graph.example/v23.0/me/adaccounts?after=abc')
  })

  it('turns Meta errors into typed errors: expired token, rate limit, missing access', async () => {
    const fail = (error: Record<string, unknown>, status = 400) =>
      new MetaGraph('t'.repeat(30), { fetchFn: vi.fn().mockResolvedValue(reply({ error }, status)) }).get('me')
    await expect(fail({ message: 'Error validating access token', code: 190 })).rejects.toMatchObject({ tokenInvalid: true })
    await expect(fail({ message: 'User request limit reached', code: 17 })).rejects.toMatchObject({ rateLimited: true, tokenInvalid: false })
    await expect(fail({ message: 'Permissions error', code: 200 }, 403)).rejects.toMatchObject({ noAccess: true })
    await expect(fail({ message: 'x', code: 100, error_user_msg: 'Friendly reason' })).rejects.toThrow('Meta: Friendly reason')
  })

  it('returns no pages when the token cannot read pages, but still fails on an expired token', async () => {
    const noPages = vi.fn().mockResolvedValue(reply({ error: { message: 'pages_show_list needed', code: 200 } }, 403))
    expect(await listPages(new MetaGraph('t'.repeat(30), { fetchFn: noPages }))).toEqual([])
    const expired = vi.fn().mockResolvedValue(reply({ error: { message: 'expired', code: 190 } }, 401))
    await expect(listPages(new MetaGraph('t'.repeat(30), { fetchFn: expired }))).rejects.toBeInstanceOf(MetaApiError)
  })
})

describe('insights', () => {
  it('counts a purchase once whichever names Meta uses', () => {
    expect(pickPurchase([{ action_type: 'purchase', value: '3' }, { action_type: 'omni_purchase', value: '4' }])).toBe(4)
    expect(pickPurchase([{ action_type: 'offsite_conversion.fb_pixel_purchase', value: '2' }])).toBe(2)
    expect(pickPurchase([{ action_type: 'link_click', value: '50' }])).toBe(0)
    expect(pickPurchase(undefined)).toBe(0)
  })

  it('maps a row per ad, day and placement', () => {
    expect(mapInsight({
      ad_id: '1', adset_id: '2', campaign_id: '3', ad_name: 'Reel', date_start: '2026-10-01', publisher_platform: 'instagram',
      spend: '12.34', impressions: '1000', clicks: '40', inline_link_clicks: '25',
      actions: [{ action_type: 'omni_purchase', value: '2' }], action_values: [{ action_type: 'omni_purchase', value: '45.5' }],
    })).toMatchObject({ ad_id: '1', date: '2026-10-01', platform: 'instagram', spend: 12.34, impressions: 1000, link_clicks: 25, purchases: 2, purchase_value: 45.5 })
  })

  it('splits long ranges into weekly windows', () => {
    expect(dateWindows('2026-09-01', '2026-09-16', 7)).toEqual([
      { since: '2026-09-01', until: '2026-09-07' }, { since: '2026-09-08', until: '2026-09-14' }, { since: '2026-09-15', until: '2026-09-16' },
    ])
    expect(dateWindows('2026-10-03', '2026-10-03')).toEqual([{ since: '2026-10-03', until: '2026-10-03' }])
  })

  it('asks for ad-level daily insights split by placement', async () => {
    const fetchFn = vi.fn().mockResolvedValue(reply({ data: [{ ad_id: '1', date_start: '2026-10-01', publisher_platform: 'facebook', spend: '5' }, { date_start: '2026-10-01' }] }))
    const rows = await fetchInsights(new MetaGraph('t'.repeat(30), { fetchFn, baseUrl: 'https://graph.example' }), '42', '2026-10-01', '2026-10-01')
    expect(rows).toHaveLength(1)
    const url = new URL(fetchFn.mock.calls[0][0])
    expect(url.pathname).toMatch(/\/act_42\/insights$/)
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      level: 'ad', time_increment: '1', breakdowns: 'publisher_platform', time_range: '{"since":"2026-10-01","until":"2026-10-01"}',
    })
  })
})
