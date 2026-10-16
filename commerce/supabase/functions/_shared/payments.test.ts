import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { reconcilePayment, recordVerifiedPayment } from './payment-flow.ts'
import { BKASH_SANDBOX_URL, BkashProvider, clearBkashTokens } from './payments/bkash.ts'
import { PaystationProvider, paystationReference } from './payments/paystation.ts'
import type { PaymentInitContext, VerifiedPayment } from './payments/types.ts'

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
  const ps = (fetchFn: typeof fetch, now = () => 1_760_000_000_000) =>
    new PaystationProvider({ merchantId: 'M-104', password: 'pw', baseUrl: 'https://ps.test' }, fetchFn, now)

  it('creates a payment link for our invoice number', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status_code: '200', status: 'success', payment_url: 'https://ps.test/checkout/xyz' }))
    const result = await ps(fetchFn).initiate(ctx)
    expect(result).toMatchObject({ type: 'redirect', redirectUrl: 'https://ps.test/checkout/xyz', session: 'PAY-ABC123-TMGJ6K3CW' })
    const form = fetchFn.mock.calls[0][1].body as FormData
    expect(Object.fromEntries(form.entries())).toMatchObject({ merchantId: 'M-104', password: 'pw', invoice_number: 'PAY-ABC123-TMGJ6K3CW', payment_amount: '55.00', reference: 'ISO-10070' })
  })

  /** A fake PayStation that, like the real one, refuses an invoice number it has seen (1008). */
  const strictPaystation = () => {
    const seen = new Set<string>()
    return vi.fn(async (url: string, init: RequestInit) => {
      const invoice = String((init.body as FormData).get('invoice_number'))
      if (seen.has(invoice)) return jsonResponse({ status_code: '1008', status: 'failed', message: 'Duplicate invoice number' })
      seen.add(invoice)
      return jsonResponse({ status_code: '200', status: 'success', payment_url: `https://ps.test/checkout/${invoice}` })
    })
  }

  it('gives every attempt its own invoice, so paying again (say after trying bKash) opens PayStation again', async () => {
    const fetchFn = strictPaystation()
    let clock = 1_760_000_000_000
    const gateway = ps(fetchFn as unknown as typeof fetch, () => clock++)
    // The same pending payment, tried a second and a third time.
    const sessions = [await gateway.initiate(ctx), await gateway.initiate(ctx), await gateway.initiate(ctx)].map((r) => r.session!)
    expect(new Set(sessions).size).toBe(3)
    for (const s of sessions) expect(paystationReference(s)).toBe('PAY-ABC123')
    // (The invoice used to be the payment reference itself: the second attempt got "Duplicate invoice number".)
    expect(fetchFn).toHaveBeenCalledTimes(3)
  })

  it('reads our reference back from an attempt\'s invoice (and from the older plain ones)', async () => {
    expect(paystationReference('PAY-0123456789ABCDEF-TMGJ6K3CW')).toBe('PAY-0123456789ABCDEF')
    expect(paystationReference('PAY-0123456789ABCDEF')).toBe('PAY-0123456789ABCDEF')
    expect(paystationReference('BP-0123456789ABCD-T1')).toBe('BP-0123456789ABCD')
    const paid = vi.fn(async () => jsonResponse({ status_code: '200', status: 'success',
      data: { invoice_number: 'PAY-ABC123-TMGJ6K3CX', trx_status: 'Success', trx_id: 'PS78', payment_amount: '55' } }))
    expect(await ps(paid).verifyCallback({ status: 'Successful', invoice_number: 'PAY-ABC123-TMGJ6K3CX' }))
      .toMatchObject({ success: true, reference: 'PAY-ABC123', providerTransactionId: 'PS78', eventId: 'paystation:trx:PS78' })
    expect(await ps(paid).reconcile('PAY-ABC123-TMGJ6K3CX', 'PAY-ABC123', 5)).toMatchObject({ success: true, reference: 'PAY-ABC123' })
    const cancelled = vi.fn().mockResolvedValue(jsonResponse({ status_code: '404', message: 'Transaction not found' }))
    expect(await ps(cancelled).verifyCallback({ status: 'Canceled', invoice_number: 'PAY-ABC123-TMGJ6K3CX' }))
      .toMatchObject({ success: false, reference: 'PAY-ABC123', eventId: 'paystation:PAY-ABC123-TMGJ6K3CX:canceled' })
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

/** Just enough of a Supabase client for payment-flow: one payments row, and confirm_payment. */
function fakeAdmin(payment: Record<string, unknown>) {
  const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => ({
    data: { status: !args.p_success ? 'failed' : payment.status === 'SUCCEEDED' ? 'already_succeeded' : 'succeeded' }, error: null,
  }))
  const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: payment, error: null }) }
  return { admin: { from: () => query, rpc } as unknown as SupabaseClient, rpc }
}

const verdict = (v: Partial<VerifiedPayment>): VerifiedPayment => ({
  reference: 'PAY-1', providerTransactionId: null, amount: null, currency: null, success: false,
  eventId: 'e', eventType: 'callback.cancel', raw: {}, ...v,
})

describe('changing the payment method part way', () => {
  const row = (sessions: string[], extra: Record<string, unknown> = {}) =>
    ({ currency: 'BDT', status: 'PENDING', provider_transaction_id: null, metadata: { sessions }, orders: { order_number: 'ISO-1' }, ...extra })

  it('a cancelled attempt does not fail a payment whose earlier attempt may still be paid', async () => {
    const { admin, rpc } = fakeAdmin(row(['PAY-1-TA', 'PAY-1-TB']))
    expect(await recordVerifiedPayment(admin, 'paystation', verdict({ eventId: 'paystation:PAY-1-TB:canceled' }), 'PAY-1-TB'))
      .toEqual({ status: 'attempt_failed', orderNumber: 'ISO-1' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('still fails a payment that was only ever tried once, and takes the reconcile job\'s final word', async () => {
    const once = fakeAdmin(row(['TR-A']))
    expect((await recordVerifiedPayment(once.admin, 'bkash', verdict({}), 'TR-A')).status).toBe('failed')
    expect(once.rpc).toHaveBeenCalledWith('confirm_payment', expect.objectContaining({ p_reference: 'PAY-1', p_provider: 'bkash', p_success: false }))
    const twice = fakeAdmin(row(['TR-A', 'TR-B']))
    expect((await recordVerifiedPayment(twice.admin, 'bkash', verdict({}))).status).toBe('failed')
    expect(twice.rpc).toHaveBeenCalledTimes(1)
  })

  it('records a late success from the attempt the customer left, checked with the gateway first', async () => {
    const { admin, rpc } = fakeAdmin(row(['PAY-1-TA', 'PAY-1-TB']))
    const provider = new PaystationProvider({ merchantId: 'M', password: 'p', baseUrl: 'https://ps.test' }, vi.fn(async (_u: string, init: RequestInit) => {
      const invoice = String((init.body as FormData).get('invoice_number'))
      // Attempt A was paid in another tab; attempt B was cancelled.
      return jsonResponse(invoice === 'PAY-1-TA'
        ? { status_code: '200', data: { invoice_number: invoice, trx_status: 'Success', trx_id: 'PS9', payment_amount: '78' } }
        : { status_code: '200', data: { invoice_number: invoice, trx_status: 'Canceled' } })
    }) as unknown as typeof fetch)
    expect((await reconcilePayment(admin, provider, { id: 'p1', provider: 'paystation', reference: 'PAY-1', sessions: ['PAY-1-TA', 'PAY-1-TB'], age_minutes: 20 })).status)
      .toBe('succeeded')
    expect(rpc).toHaveBeenCalledWith('confirm_payment', expect.objectContaining({ p_reference: 'PAY-1', p_success: true, p_amount: 78, p_provider_transaction_id: 'PS9' }))
  })

  it('flags a second charge on a payment already paid, so staff can refund it', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { admin } = fakeAdmin(row(['PAY-1-TA', 'PAY-1-TB'], { status: 'SUCCEEDED', provider_transaction_id: 'PS1' }))
    const second = verdict({ success: true, providerTransactionId: 'PS2', amount: 78, currency: 'BDT', eventId: 'paystation:trx:PS2', eventType: 'callback.success' })
    expect((await recordVerifiedPayment(admin, 'paystation', second, 'PAY-1-TB')).status).toBe('already_succeeded')
    expect(error.mock.calls.some((c) => String(c[0]).includes('second payment'))).toBe(true)
    error.mockRestore()
  })
})
