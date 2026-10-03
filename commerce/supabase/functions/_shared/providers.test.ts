import { describe, expect, it, vi } from 'vitest'
import { mapSteadfastStatus, SteadfastProvider } from './courier/providers.ts'
import { HttpCourierHistoryProvider, InternalHistoryProvider, readPath } from './fraud/providers.ts'
import { FraudDetectionService } from './fraud/service.ts'
import type { FraudProvider } from './fraud/types.ts'
import { fromDbError, HttpError } from './http.ts'
import { WebhookProvider } from './notifications/providers.ts'
import { SslCommerzProvider } from './payments/providers.ts'
import { parse, placeOrderSchema } from './schemas.ts'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('HTTP courier-history fraud provider', () => {
  const mapping = {
    total: 'summary.total_parcel',
    delivered: 'summary.success_parcel',
    cancelled: 'summary.cancelled_parcel',
    success_ratio: 'summary.success_ratio',
  }

  it('maps configured response fields and sends the API key', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      summary: { total_parcel: 12, success_parcel: 9, cancelled_parcel: 3, success_ratio: '75%' },
    }))
    const provider = new HttpCourierHistoryProvider({ urlTemplate: 'https://fraud.example/check?phone={phone}', apiKey: 'k', mapping }, fetchFn)
    const result = await provider.checkCustomer({ phone: '01711000000' })
    expect(fetchFn).toHaveBeenCalledWith('https://fraud.example/check?phone=01711000000', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer k' }),
    }))
    expect(result).toMatchObject({ ok: true, courierScore: 75, counts: { total: 12, delivered: 9, cancelled: 3 } })
  })

  it('infers failed parcels when the API only reports totals', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ summary: { total_parcel: 10, success_parcel: 4, cancelled_parcel: 0 } }))
    const provider = new HttpCourierHistoryProvider({ urlTemplate: 'https://x/{phone}', mapping }, fetchFn)
    expect((await provider.checkCustomer({ phone: '1' })).counts.failed).toBe(6)
  })

  it('reports HTTP errors and timeouts without throwing', async () => {
    const failing = new HttpCourierHistoryProvider({ urlTemplate: 'https://x/{phone}', mapping }, vi.fn().mockResolvedValue(jsonResponse({}, 500)))
    expect(await failing.checkCustomer({ phone: '1' })).toMatchObject({ ok: false, error: 'HTTP 500' })
    const aborting = new HttpCourierHistoryProvider({ urlTemplate: 'https://x/{phone}', mapping, timeoutMs: 1 },
      vi.fn().mockImplementation((_url, init: RequestInit) => new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      })))
    expect(await aborting.checkCustomer({ phone: '1' })).toMatchObject({ ok: false, error: 'Timed out' })
  })

  it('reads nested paths safely', () => {
    expect(readPath({ a: { b: { c: 1 } } }, 'a.b.c')).toBe(1)
    expect(readPath({ a: 1 }, 'a.b')).toBeUndefined()
    expect(readPath({ a: 1 }, null)).toBeUndefined()
  })
})

describe('FraudDetectionService', () => {
  const stub = (name: string, result: Partial<Awaited<ReturnType<FraudProvider['checkCustomer']>>>): FraudProvider => ({
    name,
    checkCustomer: () => Promise.resolve({ provider: name, ok: true, counts: {}, ...result }),
  })

  it('merges providers taking the worst history and highest score', async () => {
    const service = new FraudDetectionService([
      new InternalHistoryProvider(),
      stub('a', { counts: { delivered: 5, failed: 1 }, riskScore: 30 }),
      stub('b', { counts: { delivered: 2, failed: 4 }, riskScore: 55, courierScore: 40 }),
    ])
    const payload = await service.check({ phone: '01711000000' }, { orderId: 'o1' })
    expect(payload).toMatchObject({
      status: 'SUCCESS',
      provider_counts: { delivered: 5, failed: 4 },
      provider_risk_score: 55,
      provider_courier_score: 40,
      order_id: 'o1',
      providers: ['internal', 'a', 'b'],
    })
  })

  it('marks partial and total provider failures so the database can be cautious', async () => {
    const partial = await new FraudDetectionService([stub('a', {}), stub('b', { ok: false, error: 'down' })]).check({ phone: '1' })
    expect(partial.status).toBe('PARTIAL')
    const failed = await new FraudDetectionService([new InternalHistoryProvider(), stub('b', { ok: false, error: 'down' })]).check({ phone: '1' })
    expect(failed.status).toBe('ERROR')
    expect(failed.error).toContain('down')
    const internalOnly = await new FraudDetectionService([new InternalHistoryProvider()]).check({ phone: '1' })
    expect(internalOnly.status).toBe('SUCCESS')
  })
})

describe('SSLCommerz payment provider', () => {
  const provider = (fetchFn: typeof fetch) => new SslCommerzProvider({ storeId: 'store', storePassword: 'secret', sandbox: true }, fetchFn)
  const ctx = {
    payment: { id: 'p1', reference: 'PAY-1', amount: 120, currency: 'BDT', purpose: 'ADVANCE' },
    order: { order_number: 'ISO-10001', customer_name: 'A', customer_phone: '017', customer_email: null, shipping_address: 'Road 1', shipping_district: 'Dhaka' },
    urls: { success: 's', fail: 'f', cancel: 'c', ipn: 'i' },
  }

  it('starts a hosted checkout for the reference and amount', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 'SUCCESS', GatewayPageURL: 'https://pay.example/123', sessionkey: 'sk' }))
    const result = await provider(fetchFn).initiate(ctx)
    expect(result).toMatchObject({ type: 'redirect', redirectUrl: 'https://pay.example/123' })
    const form = fetchFn.mock.calls[0][1].body as URLSearchParams
    expect(form.get('tran_id')).toBe('PAY-1')
    expect(form.get('total_amount')).toBe('120.00')
    expect(form.get('ipn_url')).toBe('i')
  })

  it('verifies callbacks with the validation API and never trusts callback fields', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ status: 'VALID', tran_id: 'PAY-1', amount: '120.00', currency: 'BDT', bank_tran_id: 'B1' }))
    const ok = await provider(fetchFn).verifyCallback({ status: 'VALID', tran_id: 'PAY-1', val_id: 'v1', amount: '999999' })
    expect(ok).toMatchObject({ success: true, amount: 120, reference: 'PAY-1', providerTransactionId: 'B1', eventId: 'val:v1' })
    expect(String(fetchFn.mock.calls[0][0])).toContain('val_id=v1')

    const spoofed = await provider(vi.fn().mockResolvedValue(jsonResponse({ status: 'VALID', tran_id: 'PAY-OTHER', amount: '120' })))
      .verifyCallback({ status: 'VALID', tran_id: 'PAY-1', val_id: 'v2' })
    expect(spoofed.success).toBe(false)

    const failed = await provider(vi.fn()).verifyCallback({ status: 'FAILED', tran_id: 'PAY-1' })
    expect(failed).toMatchObject({ success: false, eventId: 'PAY-1:FAILED' })
  })
})

describe('Steadfast courier provider', () => {
  it('maps courier statuses to shipment statuses', () => {
    expect(mapSteadfastStatus('delivered')).toBe('DELIVERED')
    expect(mapSteadfastStatus('Partial Delivered')).toBe('PARTIALLY_DELIVERED')
    expect(mapSteadfastStatus('cancelled')).toBe('RETURNING')
    expect(mapSteadfastStatus('in_review')).toBe('BOOKED')
    expect(mapSteadfastStatus('unknown')).toBeNull()
    expect(mapSteadfastStatus('something-new')).toBeNull()
  })

  it('creates a consignment with the COD amount and order number as invoice', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({
      status: 200, consignment: { consignment_id: 555, tracking_code: 'TRK555', status: 'in_review' },
    }))
    const sf = new SteadfastProvider({ apiKey: 'a', secretKey: 's' }, fetchFn)
    const created = await sf.createShipment({
      orderNumber: 'ISO-10001', recipientName: 'Rahim', recipientPhone: '01711000000', recipientAddress: 'Road 1',
      district: 'Dhaka', area: 'Dhanmondi', codAmount: 1379.5, itemCount: 2,
    })
    expect(created).toMatchObject({ consignmentId: '555', trackingNumber: 'TRK555', status: 'BOOKED' })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('https://portal.packzy.com/api/v1/create_order')
    expect(init.headers).toMatchObject({ 'Api-Key': 'a', 'Secret-Key': 's' })
    expect(JSON.parse(init.body)).toMatchObject({ invoice: 'ISO-10001', cod_amount: 1380, recipient_address: 'Road 1, Dhanmondi, Dhaka' })
  })

  it('surfaces API validation errors', async () => {
    const sf = new SteadfastProvider({ apiKey: 'a', secretKey: 's' },
      vi.fn().mockResolvedValue(jsonResponse({ status: 400, errors: { recipient_phone: ['invalid'] } })))
    await expect(sf.getShipmentStatus({ consignmentId: '1' })).rejects.toThrow(/recipient_phone/)
  })
})

describe('notification providers', () => {
  it('signs webhook notifications when a secret is configured', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('ok'))
    await new WebhookProvider('https://hook.example', 'secret', fetchFn).send({ channel: 'WHATSAPP', to: '017', body: 'hi' })
    expect(fetchFn.mock.calls[0][1].headers['X-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
  })
})

describe('validation and error mapping', () => {
  const valid = {
    action: 'place',
    customer: { full_name: 'Rahim Uddin', phone: '01711000000', email: '' },
    shipping: { address: 'House 1, Road 2', district: 'Dhaka' },
    items: [{ variant_id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', quantity: 1 }],
    idempotency_key: 'checkout-123456',
  }

  it('accepts a valid checkout and applies defaults', () => {
    const parsed = parse(placeOrderSchema, valid)
    expect(parsed.payment_method).toBe('COD')
    expect(parsed.delivery_method).toBe('standard')
  })

  it('rejects invalid checkouts with a readable message', () => {
    expect(() => parse(placeOrderSchema, { ...valid, items: [] })).toThrow(HttpError)
    try {
      parse(placeOrderSchema, { ...valid, customer: { ...valid.customer, email: 'not-an-email' } })
    } catch (error) {
      expect((error as HttpError).status).toBe(422)
    }
  })

  it('maps database error codes to safe HTTP errors', () => {
    expect(fromDbError({ message: 'INSUFFICIENT_STOCK: Tee has only 1 available' })).toMatchObject({ status: 409, message: 'Tee has only 1 available' })
    expect(fromDbError({ message: 'PERMISSION_DENIED: orders.update is required' }).status).toBe(403)
    expect(fromDbError({ message: 'permission denied for function x', code: '42501' }).status).toBe(403)
    const hidden = fromDbError({ message: 'relation "secret_table" does not exist' })
    expect(hidden.status).toBe(500)
    expect(hidden.message).not.toContain('secret_table')
  })
})
