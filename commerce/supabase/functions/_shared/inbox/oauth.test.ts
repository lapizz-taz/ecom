import { describe, expect, it, vi } from 'vitest'
import { exchangeCode, grantedNumbers, grantedPages, loginUrl, pageFields, readState, signState } from './oauth.ts'

const app = { app_id: '1653473169830242', app_secret: 'appsecretappsecret123456', login_config_id: '911022668675556', whatsapp_config_id: '555000111' }
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('Continue with Facebook: signed state', () => {
  it('round-trips for the store and person who started, and only while fresh', async () => {
    const now = Date.UTC(2026, 9, 17, 10)
    const state = await signState(app.app_secret, { m: 'store-1', u: 'user-1', k: 'PAGES' }, now)
    expect(await readState(app.app_secret, state, now + 60_000)).toMatchObject({ m: 'store-1', u: 'user-1', k: 'PAGES' })
    // Expired after 15 minutes.
    expect(await readState(app.app_secret, state, now + 16 * 60_000)).toBeNull()
  })

  it('carries the business kind and the popup mark', async () => {
    const state = await signState(app.app_secret, { m: 'store-1', u: 'user-1', k: 'BUSINESS', w: 1 })
    expect(await readState(app.app_secret, state)).toMatchObject({ k: 'BUSINESS', w: 1 })
  })

  it('refuses a state signed with another secret or changed on the way', async () => {
    const state = await signState(app.app_secret, { m: 'store-1', u: 'user-1', k: 'WHATSAPP' })
    expect(await readState('another-secret-entirely', state)).toBeNull()
    const [payload, sig] = state.split('.')
    const forged = btoa(JSON.stringify({ m: 'store-2', u: 'user-1', k: 'WHATSAPP', exp: 9e9, n: 'x' })).replace(/=+$/, '')
    expect(await readState(app.app_secret, `${forged}.${sig}`)).toBeNull()
    expect(await readState(app.app_secret, payload)).toBeNull()
    expect(await readState(app.app_secret, 'garbage')).toBeNull()
  })
})

describe('Continue with Facebook: Meta calls', () => {
  it('builds the login address with the right configuration for Pages and for WhatsApp', () => {
    const pages = new URL(loginUrl(app, 'PAGES', 'https://fullfilio.com/admin/inbox/meta-callback', 'st'))
    expect(pages.hostname).toBe('www.facebook.com')
    expect(Object.fromEntries(pages.searchParams)).toMatchObject({
      client_id: app.app_id, config_id: app.login_config_id, redirect_uri: 'https://fullfilio.com/admin/inbox/meta-callback',
      state: 'st', response_type: 'code', override_default_response_type: 'true',
    })
    expect(pages.searchParams.has('extras')).toBe(false)
    // "Connect using Business" uses its own (system-user) configuration.
    const biz = new URL(loginUrl({ ...app, business_config_id: '777000222' }, 'BUSINESS', 'https://x/cb', 'st'))
    expect(biz.searchParams.get('config_id')).toBe('777000222')
    const wa = new URL(loginUrl(app, 'WHATSAPP', 'https://x/cb', 'st'))
    expect(wa.searchParams.get('config_id')).toBe(app.whatsapp_config_id)
    expect(JSON.parse(wa.searchParams.get('extras')!)).toMatchObject({ sessionInfoVersion: '3', featureType: '' })
    // Keeping the number on the WhatsApp Business app asks Meta for the coexistence sign-up.
    const coexist = new URL(loginUrl(app, 'WHATSAPP', 'https://x/cb', 'st', true))
    expect(JSON.parse(coexist.searchParams.get('extras')!)).toMatchObject({ featureType: 'whatsapp_business_app_onboarding' })
  })

  it('swaps the code for a token, then for a long-lived one (Pages only)', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(ok({ access_token: 'SHORT' }))
      .mockResolvedValueOnce(ok({ access_token: 'LONG', expires_in: 5183944 }))
    expect(await exchangeCode(app, 'CODE', 'https://x/cb', true, fetchFn)).toBe('LONG')
    const first = new URL(fetchFn.mock.calls[0][0])
    expect(Object.fromEntries(first.searchParams)).toMatchObject({ client_id: app.app_id, client_secret: app.app_secret, code: 'CODE', redirect_uri: 'https://x/cb' })
    expect(new URL(fetchFn.mock.calls[1][0]).searchParams.get('grant_type')).toBe('fb_exchange_token')

    const once = vi.fn().mockResolvedValueOnce(ok({ access_token: 'BUSINESS' }))
    expect(await exchangeCode(app, 'CODE', 'https://x/cb', false, once)).toBe('BUSINESS')
    expect(once).toHaveBeenCalledTimes(1)
  })

  it('passes on Meta\'s error when the code is refused', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'This authorization code has expired.', code: 100 } }), { status: 400 }))
    await expect(exchangeCode(app, 'OLD', 'https://x/cb', true, fetchFn)).rejects.toThrow(/expired/)
  })

  it('lists the granted Pages with their tokens and Instagram accounts, across pages of results', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(ok({
        data: [
          { id: '101', name: 'Isolation', access_token: 'PT1', picture: { data: { url: 'https://p/1' } }, instagram_business_account: { id: '1784', username: 'isolation.pvt' } },
          { id: '102', name: 'No token' },
        ],
        paging: { cursors: { after: 'C1' }, next: 'https://graph/next' },
      }))
      .mockResolvedValueOnce(ok({ data: [{ id: '103', name: 'Second', access_token: 'PT3' }] }))
    const pages = await grantedPages('USER', app.app_secret, fetchFn)
    expect(pages).toEqual([
      { id: '101', name: 'Isolation', picture: 'https://p/1', token: 'PT1', instagram: { id: '1784', username: 'isolation.pvt', picture: null } },
      { id: '103', name: 'Second', picture: null, token: 'PT3', instagram: null },
    ])
    expect(new URL(fetchFn.mock.calls[1][0]).searchParams.get('after')).toBe('C1')
    // The user token travels in the header, with appsecret_proof, never as a URL parameter.
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe('Bearer USER')
    expect(new URL(fetchFn.mock.calls[0][0]).searchParams.has('access_token')).toBe(false)
    expect(new URL(fetchFn.mock.calls[0][0]).searchParams.has('appsecret_proof')).toBe(true)
  })

  it('finds the WhatsApp numbers in the accounts shared during Embedded Signup', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(ok({ data: { granular_scopes: [
        { scope: 'whatsapp_business_management', target_ids: ['WABA1'] },
        { scope: 'whatsapp_business_messaging', target_ids: ['WABA1'] },
        { scope: 'pages_show_list', target_ids: ['101'] },
      ] } }))
      .mockResolvedValueOnce(ok({ data: [{ id: 'PH1', display_phone_number: '+880 1711-000000', verified_name: 'Isolation' }] }))
    expect(await grantedNumbers(app, 'BIZ', fetchFn)).toEqual([{ id: 'PH1', waba_id: 'WABA1', display_phone: '+880 1711-000000', name: 'Isolation' }])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    expect(fetchFn.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${app.app_id}|${app.app_secret}`)
  })

  it('subscribes Page events, with comments only when wanted', () => {
    expect(pageFields(true).split(',')).toContain('feed')
    expect(pageFields(false).split(',')).not.toContain('feed')
    expect(pageFields(false).split(',')).toContain('messages')
  })
})
