import { describe, expect, it, vi } from 'vitest'
import { BkashProvider, clearBkashTokens } from './payments/bkash.ts'
import { callGateway, isGatewayUrl, relayedFetch } from './payments/gateway-relay.ts'
import { PaystationProvider } from './payments/paystation.ts'
import { gatewaySandbox } from './payments/registry.ts'

/** A relay that runs callGateway against a fake gateway, as the Supabase function would. */
function setup(gateway: (req: Request) => Promise<Response> | Response) {
  const seen: Request[] = []
  const gatewayFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init)
    seen.push(req.clone())
    return gateway(req)
  }) as unknown as typeof fetch
  const relayCalls: Array<{ headers: Headers; body: Record<string, unknown> }> = []
  const relayFetchFn = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    relayCalls.push({ headers: new Headers(init?.headers), body })
    return Response.json(await callGateway(body, gatewayFetch))
  }) as unknown as typeof fetch
  const direct = vi.fn(async () => new Response('direct')) as unknown as typeof fetch
  const f = relayedFetch({ url: 'https://p.supabase.co/functions/v1/courier-relay', cronSecret: 'cron-s', fetchFn: relayFetchFn }, direct)
  return { f, seen, relayCalls, direct }
}

describe('payment gateway relay', () => {
  it('knows the gateway hosts, over HTTPS only', () => {
    expect(isGatewayUrl('https://tokenized.pay.bka.sh/v1.2.0-beta/x')).toBe(true)
    expect(isGatewayUrl('https://sandbox.paystation.com.bd/initiate-payment')).toBe(true)
    expect(isGatewayUrl('http://api.paystation.com.bd/x')).toBe(false)
    expect(isGatewayUrl('https://api.paystation.com.bd.evil.com/x')).toBe(false)
    expect(isGatewayUrl('https://example.com')).toBe(false)
  })

  it('sends other requests straight out, untouched', async () => {
    const { f, direct, relayCalls } = setup(() => new Response('never'))
    expect(await (await f('https://example.com/a', { method: 'POST', body: 'x' })).text()).toBe('direct')
    expect(direct).toHaveBeenCalledTimes(1)
    expect(relayCalls).toHaveLength(0)
  })

  it('connects bKash through the relay: JSON body and auth headers arrive intact', async () => {
    clearBkashTokens()
    const { f, seen, relayCalls } = setup(async (req) => {
      if (req.url.endsWith('/token/grant')) return Response.json({ id_token: 'tok', expires_in: 3600, statusCode: '0000' })
      return Response.json({ statusCode: '0000', paymentID: 'P1', bkashURL: 'https://sandbox.bka.sh/pay' })
    })
    const bkash = new BkashProvider({ appKey: 'k', appSecret: 's', username: 'u', password: 'p', sandbox: true }, f)
    await expect(bkash.token()).resolves.toBe('tok')
    expect(seen[0].url).toBe('https://tokenized.sandbox.bka.sh/v1.2.0-beta/tokenized/checkout/token/grant')
    expect(seen[0].headers.get('username')).toBe('u')
    expect(seen[0].headers.get('password')).toBe('p')
    expect(await seen[0].json()).toEqual({ app_key: 'k', app_secret: 's' })
    expect(relayCalls[0].headers.get('x-cron-secret')).toBe('cron-s')
    expect(relayCalls[0].body.action).toBe('gateway')
  })

  it('connects PayStation sandbox through the relay: form fields and merchantId header arrive intact', async () => {
    const { f, seen } = setup(async (req) => {
      if (req.url.endsWith('/transaction-status')) return Response.json({ status_code: '2001', status: 'failed', message: 'Transaction not found' })
      return Response.json({ status_code: '200', status: 'success', payment_url: 'https://sandbox.paystation.com.bd/checkout/1/x' })
    })
    const ps = new PaystationProvider({ merchantId: '104-1653730183', password: 'pw', sandbox: true }, f)
    await expect(ps.test('https://example.com/cb')).resolves.toMatch(/Connected to PayStation/)
    expect(seen.map((r) => new URL(r.url).host)).toEqual(['sandbox.paystation.com.bd', 'sandbox.paystation.com.bd'])
    expect(seen[0].headers.get('merchantId')).toBe('104-1653730183')
    const form = await seen[1].formData()
    expect(form.get('merchantId')).toBe('104-1653730183')
    expect(form.get('password')).toBe('pw')
    expect(form.get('payment_amount')).toBe('10')
  })

  it('says why when the gateway cannot be reached', async () => {
    const { f } = setup(() => { throw new TypeError('connection refused') })
    const ps = new PaystationProvider({ merchantId: 'm', password: 'p' }, f)
    await expect(ps.test()).rejects.toThrow('Could not reach PayStation')
  })

  it('refuses hosts that are not gateways and does not follow redirects', async () => {
    const gatewayFetch = vi.fn(async () => new Response(null, { status: 302, headers: { Location: 'https://evil.example' } })) as unknown as typeof fetch
    expect(await callGateway({ url: 'https://evil.example/x', method: 'POST', headers: {}, body: '' }, gatewayFetch)).toMatchObject({ ok: false })
    expect(gatewayFetch).not.toHaveBeenCalled()
    const r = await callGateway({ url: 'https://api.paystation.com.bd/x', method: 'POST', headers: { cookie: 'x', merchantId: 'm' }, body: '' }, gatewayFetch)
    expect(r).toMatchObject({ ok: true, status: 302 })
    const init = (gatewayFetch as unknown as { mock: { calls: Array<[string, RequestInit]> } }).mock.calls[0][1]
    expect(init.redirect).toBe('manual')
    expect(init.headers).toEqual({ merchantId: 'm' })
  })

  it('PayStation is live unless sandbox is chosen; bKash starts in sandbox', () => {
    expect(new PaystationProvider({ merchantId: 'm', password: 'p' })['base']).toBe('https://api.paystation.com.bd')
    expect(new PaystationProvider({ merchantId: 'm', password: 'p', sandbox: true })['base']).toBe('https://sandbox.paystation.com.bd')
    expect(gatewaySandbox('paystation', undefined)).toBe(false)
    expect(gatewaySandbox('paystation', true)).toBe(true)
    expect(gatewaySandbox('bkash', undefined)).toBe(true)
    expect(gatewaySandbox('bkash', false)).toBe(false)
  })
})
