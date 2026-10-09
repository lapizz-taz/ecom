import { beforeEach, describe, expect, it, vi } from 'vitest'
import { BKASH_SANDBOX_URL, BkashProvider, clearBkashTokens } from './payments/bkash.ts'
import { PaystationProvider } from './payments/paystation.ts'
import type { PaymentInitContext } from './payments/types.ts'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const ctx: PaymentInitContext = {
  payment: { id: 'p1', reference: 'PAY-ABC123', amount: 55, currency: 'BDT', purpose: 'ADVANCE' },
  order: {
    order_number: 'ISO-10070', customer_name: 'Rahim', customer_phone: '01711000001', customer_email: null,
    shipping_address: 'House 1, Mirpur', shipping_district: 'Dhaka',
  },
  urls: { success: 'https://fn/payments?callback=success&provider=bkash', fail: 'f', cancel: 'c', ipn: 'i' },
}

const creds = { appKey: 'app-key-1', appSecret: 'secret-1', username: 'user', password: 'pass', sandbox: true }

/** A fake bKash: answers by path, records calls. */
function fakeBkash(routes: Record<string, unknown | ((body: Record<string, unknown>) => unknown)>) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(BKASH_SANDBOX_URL, '')
    const route = routes[path]
    if (route === undefined) return jsonResponse({ errorCode: '404', errorMessage: 'no route' }, 404)
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {}
    return jsonResponse(typeof route === 'function' ? (route as (b: Record<string, unknown>) => unknown)(body) : route)
  })
}

const grant = { id_token: 'tok-1', expires_in: 3600, statusCode: '0000' }

describe('bKash tokenized checkout', () => {
  beforeEach(() => clearBkashTokens())

  it('grants a token once, then creates the payment for the amount due', async () => {
    const fetchFn = fakeBkash({
      '/tokenized/checkout/token/grant': grant,
      '/tokenized/checkout/create': (b) => ({ statusCode: '0000', paymentID: 'TR0011abc', bkashURL: 'https://sandbox.payment.bkash.com/?paymentId=TR0011abc', amount: b.amount }),
    })
    const bkash = new BkashProvider(creds, fetchFn)
    const result = await bkash.initiate(ctx)
    expect(result).toMatchObject({ type: 'redirect', session: 'TR0011abc', redirectUrl: expect.stringContaining('TR0011abc') })
    await bkash.initiate(ctx)
    const calls = fetchFn.mock.calls.map((c) => String(c[0]).replace(BKASH_SANDBOX_URL, ''))
    expect(calls.filter((p) => p.endsWith('/grant'))).toHaveLength(1)
    const create = fetchFn.mock.calls.find((c) => String(c[0]).endsWith('/create'))!
    expect(JSON.parse(String(create[1]!.body))).toMatchObject({ amount: '55.00', currency: 'BDT', intent: 'sale', merchantInvoiceNumber: 'PAY-ABC123', mode: '0011' })
    expect(create[1]!.headers).toMatchObject({ Authorization: 'tok-1', 'X-APP-Key': 'app-key-1' })
    const grantCall = fetchFn.mock.calls.find((c) => String(c[0]).endsWith('/grant'))!
    expect(grantCall[1]!.headers).toMatchObject({ username: 'user', password: 'pass' })
  })

  it('shares one token between function instances, and only for the same credentials', async () => {
    let shared: { id: string; token: string; expiresAt: number } | null = null
    const store = { get: async () => shared, set: async (v: typeof shared & object) => { shared = v } }
    const routes = {
      '/tokenized/checkout/token/grant': grant,
      '/tokenized/checkout/create': { statusCode: '0000', paymentID: 'TR1', bkashURL: 'https://pay/TR1' },
    }
    await new BkashProvider(creds, fakeBkash(routes), Date.now, store).initiate(ctx)
    expect(shared).toMatchObject({ token: 'tok-1' })
    clearBkashTokens() // another instance: nothing in memory
    const second = fakeBkash(routes)
    await new BkashProvider(creds, second, Date.now, store).initiate(ctx)
    expect(second.mock.calls.filter((c) => String(c[0]).endsWith('/grant'))).toHaveLength(0)
    clearBkashTokens()
    const otherKey = fakeBkash(routes)
    await new BkashProvider({ ...creds, appKey: 'new-key' }, otherKey, Date.now, store).initiate(ctx)
    expect(otherKey.mock.calls.filter((c) => String(c[0]).endsWith('/grant'))).toHaveLength(1)
    // Testing credentials never leans on a shared token.
    const wrongSecret = fakeBkash({ '/tokenized/checkout/token/grant': { statusCode: '2001', statusMessage: 'Invalid App Secret' } })
    await expect(new BkashProvider({ ...creds, appKey: 'new-key', appSecret: 'typo' }, wrongSecret, Date.now, store).test()).rejects.toThrow(/Invalid App Secret/)
  })

  it('grants a new token once when bKash says the old one expired', async () => {
    let granted = 0
    let current = ''
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/grant')) {
        current = `tok-${++granted}`
        return jsonResponse({ statusCode: '0000', id_token: current, expires_in: 3600 })
      }
      if ((init!.headers as Record<string, string>).Authorization !== current) return jsonResponse({ message: 'The incoming token has expired' }, 401)
      return jsonResponse({ statusCode: '0000', paymentID: 'TR1', bkashURL: 'https://pay/TR1' })
    })
    const bkash = new BkashProvider(creds, fetchFn)
    await bkash.initiate(ctx)
    current = 'revoked-by-bkash'
    expect((await bkash.initiate(ctx)).session).toBe('TR1')
    expect(granted).toBe(2)
  })

  it('refuses bad credentials with bKash\'s own message', async () => {
    const bkash = new BkashProvider(creds, fakeBkash({ '/tokenized/checkout/token/grant': { statusCode: '2001', statusMessage: 'Invalid App Key' } }))
    await expect(bkash.test()).rejects.toThrow(/Invalid App Key/)
  })

  it('counts a payment only after execute reports it Completed', async () => {
    const bkash = new BkashProvider(creds, fakeBkash({
      '/tokenized/checkout/token/grant': grant,
      '/tokenized/checkout/execute': { statusCode: '0000', transactionStatus: 'Completed', trxID: 'BFD90JRLST', amount: '55.00', currency: 'BDT', merchantInvoiceNumber: 'PAY-ABC123' },
    }))
    expect(await bkash.verifyCallback({ paymentID: 'TR0011abc', status: 'success', reference: 'PAY-ABC123' })).toMatchObject({
      success: true, reference: 'PAY-ABC123', providerTransactionId: 'BFD90JRLST', amount: 55, eventId: 'bkash:trx:BFD90JRLST',
    })
  })

  it('does not trust status=success when bKash says otherwise', async () => {
    const bkash = new BkashProvider(creds, fakeBkash({
      '/tokenized/checkout/token/grant': grant,
      '/tokenized/checkout/execute': { statusCode: '2056', statusMessage: 'Invalid Payment State' },
      '/tokenized/checkout/payment/status': { statusCode: '0000', transactionStatus: 'Initiated', paymentID: 'TR0011abc' },
    }))
    expect(await bkash.verifyCallback({ paymentID: 'TR0011abc', status: 'success', reference: 'PAY-ABC123' })).toMatchObject({
      success: false, amount: null, eventId: 'bkash:TR0011abc:Initiated',
    })
  })

  it('falls back to a status query when execute already happened', async () => {
    const bkash = new BkashProvider(creds, fakeBkash({
      '/tokenized/checkout/token/grant': grant,
      '/tokenized/checkout/execute': { statusCode: '2062', statusMessage: 'The payment has already been completed' },
      '/tokenized/checkout/payment/status': { statusCode: '0000', transactionStatus: 'Completed', trxID: 'BFD90JRLST', amount: '55.00', merchantInvoiceNumber: 'PAY-ABC123' },
    }))
    expect((await bkash.verifyCallback({ paymentID: 'TR0011abc', status: 'success' })).success).toBe(true)
  })

  it('records a cancel without calling bKash, and leaves unreachable payments pending', async () => {
    const fetchFn = fakeBkash({ '/tokenized/checkout/token/grant': grant })
    const bkash = new BkashProvider(creds, fetchFn)
    expect(await bkash.verifyCallback({ paymentID: 'TR1', status: 'cancel', reference: 'PAY-1' })).toMatchObject({ success: false, eventType: 'callback.cancel' })
    expect(fetchFn).not.toHaveBeenCalled()
    const down = new BkashProvider(creds, vi.fn().mockRejectedValue(new TypeError('fetch failed')))
    await expect(down.verifyCallback({ paymentID: 'TR1', status: 'success', reference: 'PAY-1' })).rejects.toThrow(/Could not confirm/)
  })

  it('reconciles: executes authorised payments, waits on fresh ones, expires stale ones', async () => {
    const authorised = new BkashProvider(creds, fakeBkash({
      '/tokenized/checkout/token/grant': grant,
      '/tokenized/checkout/payment/status': { statusCode: '0000', transactionStatus: 'Authorized' },
      '/tokenized/checkout/execute': { statusCode: '0000', transactionStatus: 'Completed', trxID: 'T9', amount: '55.00' },
    }))
    expect((await authorised.reconcile('TR1', 'PAY-1', 10))?.success).toBe(true)
    clearBkashTokens()
    const initiated = new BkashProvider(creds, fakeBkash({
      '/tokenized/checkout/token/grant': grant,
      '/tokenized/checkout/payment/status': { statusCode: '0000', transactionStatus: 'Initiated' },
    }))
    expect(await initiated.reconcile('TR1', 'PAY-1', 10)).toBeNull()
    expect(await initiated.reconcile('TR1', 'PAY-1', 120)).toMatchObject({ success: false, reference: 'PAY-1' })
  })
})

describe('PayStation', () => {
  const ps = (fetchFn: typeof fetch) => new PaystationProvider({ merchantId: 'M-104', password: 'pw', baseUrl: 'https://ps.test' }, fetchFn)

  it('creates a payment link for our invoice number', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status_code: '200', status: 'success', payment_url: 'https://ps.test/checkout/xyz', invoice_number: 'PAY-ABC123' }))
    const result = await ps(fetchFn).initiate(ctx)
    expect(result).toMatchObject({ type: 'redirect', redirectUrl: 'https://ps.test/checkout/xyz', session: 'PAY-ABC123' })
    const form = fetchFn.mock.calls[0][1].body as FormData
    expect(Object.fromEntries(form.entries())).toMatchObject({ merchantId: 'M-104', password: 'pw', invoice_number: 'PAY-ABC123', payment_amount: '55.00', reference: 'ISO-10070' })
  })

  it('verifies the callback with the transaction-status API', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status_code: '200', status: 'success', data: { invoice_number: 'PAY-ABC123', trx_status: 'Success', trx_id: 'PS77', payment_amount: '55' } }))
    expect(await ps(fetchFn).verifyCallback({ status: 'Successful', invoice_number: 'PAY-ABC123' })).toMatchObject({
      success: true, providerTransactionId: 'PS77', amount: 55, reference: 'PAY-ABC123',
    })
    expect(fetchFn.mock.calls[0][0]).toBe('https://ps.test/transaction-status')
    // PayStation's status API takes the merchant ID as a header; the password never goes there.
    expect(fetchFn.mock.calls[0][1].headers).toMatchObject({ merchantId: 'M-104' })
    expect(fetchFn.mock.calls[0][1].headers.token).toBeUndefined()
  })

  it('never takes the callback\'s word for success', async () => {
    const processing = vi.fn().mockResolvedValue(jsonResponse({ status_code: '200', status: 'success', data: { trx_status: 'Processing' } }))
    await expect(ps(processing).verifyCallback({ status: 'Successful', invoice_number: 'PAY-1' })).rejects.toThrow(/not confirmed/)
    const failed = vi.fn().mockResolvedValue(jsonResponse({ status_code: '200', data: { trx_status: 'Failed' } }))
    expect((await ps(failed).verifyCallback({ status: 'Successful', invoice_number: 'PAY-1' })).success).toBe(false)
    const cancelled = vi.fn().mockResolvedValue(jsonResponse({ status_code: '404', message: 'Transaction not found' }))
    expect(await ps(cancelled).verifyCallback({ status: 'Canceled', invoice_number: 'PAY-1' })).toMatchObject({ success: false, eventType: 'callback.canceled' })
  })

  it('tells bad credentials apart from an unknown invoice', async () => {
    const answers = (status: unknown, start: unknown) => vi.fn(async (url: string) => jsonResponse(String(url).endsWith('/transaction-status') ? status : start))
    const notFound = { status_code: '404', status: 'failed', message: 'Transaction not found' }
    const linkOk = { status_code: '200', status: 'success', payment_url: 'https://ps.test/checkout/t' }
    await expect(ps(answers({ status_code: '400', message: 'Invalid Merchant ID' }, linkOk)).test()).rejects.toThrow(/refused the merchant ID: Invalid Merchant ID/)
    await expect(ps(answers(notFound, { status_code: '400', status: 'failed', message: 'Invalid Password' })).test()).rejects.toThrow(/refused the credentials: Invalid Password/)
    const ok = answers(notFound, linkOk)
    expect(await ps(ok).test()).toMatch(/Connected/)
    const form = Object.fromEntries((ok.mock.calls[1][1] as RequestInit & { body: FormData }).body.entries())
    expect(form).toMatchObject({ merchantId: 'M-104', password: 'pw', payment_amount: '10' })
  })
})
