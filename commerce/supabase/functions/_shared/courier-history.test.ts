import { describe, expect, it, vi } from 'vitest'
import { bdMobile, CourierHistoryProvider, summarizeBdCourier, summarizeCourierHistory } from './fraud/courier-history.ts'
import { courierHistoryConfig, FraudDetectionService, providersFromSettings } from './fraud/service.ts'

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

// Shape returned by the courier fraud-check service (see the fraud_checker library).
const sample = {
  user_name: 'Rahim Uddin',
  courierData: [
    { label: 'pathao', order: 6, cancell: 1 },
    { label: 'steadfast', order: '4', cancell: '0' },
    { label: 'redx', order: 0, cancell: 0 },
    { label: 'paperfly', order: 0, cancell: 0 },
  ],
  source: '1',
}

describe('courier-history check (LLCG)', () => {
  it('normalises Bangladeshi mobile numbers and rejects others', () => {
    expect(bdMobile('01712345678')).toBe('01712345678')
    expect(bdMobile('+880 1712-345678')).toBe('01712345678')
    expect(bdMobile('8801712345678')).toBe('01712345678')
    expect(bdMobile('1712345678')).toBe('01712345678')
    expect(bdMobile('01112345678')).toBeNull()
    expect(bdMobile('0171234567')).toBeNull()
    expect(bdMobile('+44 7700 900123')).toBeNull()
  })

  it('adds up parcels per courier and works out the success ratio', () => {
    expect(summarizeCourierHistory(sample)).toEqual({
      couriers: [
        { courier: 'pathao', orders: 6, cancelled: 1, delivered: 5 },
        { courier: 'steadfast', orders: 4, cancelled: 0, delivered: 4 },
        { courier: 'redx', orders: 0, cancelled: 0, delivered: 0 },
        { courier: 'paperfly', orders: 0, cancelled: 0, delivered: 0 },
      ],
      total: 10,
      delivered: 9,
      cancelled: 1,
      success_ratio: 90,
      name_on_record: 'Rahim Uddin',
    })
    expect(summarizeCourierHistory({ courierData: [] })?.success_ratio).toBeNull()
    expect(summarizeCourierHistory({ message: 'Invalid API key' })).toBeNull()
    // Never more cancelled than ordered, never negative.
    expect(summarizeCourierHistory({ courierData: [{ label: 'x', order: 2, cancell: 5 }, { label: 'y', order: -3 }] })?.couriers)
      .toEqual([{ courier: 'x', orders: 2, cancelled: 2, delivered: 0 }, { courier: 'y', orders: 0, cancelled: 0, delivered: 0 }])
  })

  it('calls the service with the key and the cleaned number, and reports counts', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(sample))
    const provider = new CourierHistoryProvider({ apiKey: 'secret-key', service: 'llcg' }, fetchFn)
    const result = await provider.checkCustomer({ phone: '+8801712345678' })
    const url = new URL(String(fetchFn.mock.calls[0][0]))
    expect(`${url.origin}${url.pathname}`).toBe('https://llcgteam.com/courier-fraud-checker/fatch.php')
    expect(url.searchParams.get('api_key')).toBe('secret-key')
    expect(url.searchParams.get('term')).toBe('01712345678')
    expect(result).toMatchObject({ provider: 'courier_history', ok: true, counts: { total: 10, delivered: 9, returned: 1 } })
    expect(result.courierScore).toBeUndefined()
  })

  it('fails safely (no throw, no key in the message) on bad answers', async () => {
    const cases: Array<[unknown, number, RegExp]> = [
      [{ message: 'Invalid API key' }, 200, /Invalid API key/],
      [{ error: 'quota exceeded' }, 200, /quota exceeded/],
      ['<html>blocked</html>', 200, /unexpected answer/],
      [{}, 403, /rejected the API key/],
      [{}, 500, /HTTP 500/],
    ]
    for (const [body, status, pattern] of cases) {
      const provider = new CourierHistoryProvider({ apiKey: 'secret-key', service: 'llcg' }, vi.fn().mockResolvedValue(jsonResponse(body, status)))
      const result = await provider.checkCustomer({ phone: '01712345678' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(pattern)
      expect(result.error).not.toContain('secret-key')
    }
    const offline = new CourierHistoryProvider({ apiKey: 'secret-key', service: 'llcg' }, vi.fn().mockRejectedValue(
      new TypeError('error sending request for url (https://llcgteam.com/courier-fraud-checker/fatch.php?api_key=secret-key&term=01712345678)')))
    expect(await offline.checkCustomer({ phone: '01712345678' })).toMatchObject({ ok: false, error: 'Could not reach LLCG courier fraud checker' })
    const odd = new CourierHistoryProvider({ apiKey: 'secret-key', service: 'llcg' }, vi.fn().mockRejectedValue(new Error('bad thing with secret-key inside')))
    expect((await odd.checkCustomer({ phone: '01712345678' })).error).toBe('bad thing with [redacted] inside')
    const foreign = new CourierHistoryProvider({ apiKey: 'k', service: 'llcg' }, vi.fn())
    expect(await foreign.checkCustomer({ phone: '+44 7700 900123' })).toMatchObject({ ok: false, error: 'Not a Bangladeshi mobile number' })
  })

  it('times out instead of holding up the checkout', async () => {
    const hang = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const provider = new CourierHistoryProvider({ apiKey: 'k', service: 'llcg', timeoutMs: 20 }, hang as unknown as typeof fetch)
    expect(await provider.checkCustomer({ phone: '01712345678' })).toMatchObject({ ok: false, error: 'LLCG courier fraud checker did not answer in time' })
  })

  it('is used only when a key is connected, and its failure is reported to the database', async () => {
    const settings = { providers: ['internal', 'courier_history'] }
    expect(providersFromSettings(settings).map((p) => p.name)).toEqual(['internal'])
    const failing = vi.fn().mockResolvedValue(jsonResponse({}, 500))
    const providers = providersFromSettings(settings, failing, { courierHistory: { api_key: 'k' } })
    expect(providers.map((p) => p.name)).toEqual(['internal', 'courier_history'])
    const payload = await new FraudDetectionService(providers).check({ phone: '01712345678' })
    expect(payload).toMatchObject({ status: 'ERROR', provider: 'courier_history', provider_counts: {} })

    const working = providersFromSettings(settings, vi.fn().mockResolvedValue(jsonResponse(sample)), { courierHistory: { api_key: 'k' } })
    const ok = await new FraudDetectionService(working).check({ phone: '01712345678' })
    expect(ok).toMatchObject({ status: 'SUCCESS', provider_counts: { total: 10, delivered: 9, returned: 1 } })
    expect((ok.provider_response.courier_history as { couriers: unknown[] }).couriers).toHaveLength(4)
  })
})

// Answer documented on app.courier.com.bd → Developer/API.
const bd = {
  status: 'success',
  data: {
    pathao: { name: 'Pathao', logo: 'x', total_parcel: 150, success_parcel: 120, cancelled_parcel: 30, success_ratio: 80 },
    steadfast: { name: 'SteadFast', total_parcel: 200, success_parcel: 175, cancelled_parcel: 25, success_ratio: 87.5 },
    parceldex: { name: 'ParcelDex', total_parcel: 0, success_parcel: 0, cancelled_parcel: 0, success_ratio: 0 },
    redx: { name: 'Redx', total_parcel: 80, success_parcel: 65, cancelled_parcel: 15, success_ratio: 81.25 },
    summary: { total_parcel: 430, success_parcel: 360, cancelled_parcel: 70, success_ratio: 83.72 },
  },
  reports: [{ id: 'abc123', name: 'John Doe', details: 'Fraud reported by merchant', created_at: '2024-01-01T00:00:00.000000Z', courierName: 'SteadFast' }],
}

describe('courier-history check (BD Courier)', () => {
  it('reads parcels per courier, the summary and merchant fraud reports', () => {
    const s = summarizeBdCourier(bd)!
    expect(s.couriers.map((c) => c.courier)).toEqual(['steadfast', 'pathao', 'redx', 'parceldex'])
    expect(s.couriers[0]).toMatchObject({ courier: 'steadfast', orders: 200, delivered: 175, cancelled: 25, rate_only: false })
    expect(s).toMatchObject({ service: 'bdcourier', total: 430, delivered: 360, cancelled: 70, success_ratio: 83.72 })
    expect(s.reports).toEqual([{ name: 'John Doe', details: 'Fraud reported by merchant', courier: 'SteadFast', created_at: '2024-01-01T00:00:00.000000Z' }])
    // A new number: nothing on record.
    expect(summarizeBdCourier({ status: 'success', data: { summary: { total_parcel: 0, success_parcel: 0, cancelled_parcel: 0 } }, reports: [] }))
      .toMatchObject({ total: 0, success_ratio: null, reports: [] })
    // Parcels still on the way are neither delivered nor cancelled.
    expect(summarizeBdCourier({ status: 'success', data: { pathao: { total_parcel: 10, success_parcel: 6, cancelled_parcel: 1 } } }))
      .toMatchObject({ total: 10, delivered: 6, cancelled: 1, success_ratio: 60 })
    expect(summarizeBdCourier({ status: 'error', message: 'Unauthenticated.' })).toBeNull()
  })

  // What the live API returns when a courier (Steadfast) only reports a rate and a range.
  const rateOnly = {
    status: 'success',
    data: {
      pathao: { name: 'Pathao', total_parcel: 0, success_parcel: 0, cancelled_parcel: 0, success_ratio: 0 },
      steadfast: {
        name: 'SteadFast', rate_only: true, parcel_range: '50+', volume_band: 'high', total_parcel: 0, success_parcel: 0,
        cancelled_parcel: 0, success_ratio: 100, notice: 'SteadFast reports a success rate only.',
      },
      carrybee: { name: 'CarryBee', total_parcel: 3, success_parcel: 2, cancelled_parcel: 1, success_ratio: 66.67 },
      summary: {
        total_parcel: 3, success_parcel: 2, cancelled_parcel: 1, success_ratio: 83.34,
        calculation_note: 'Success rate is the average of each courier success rate (CarryBee 66.67%, SteadFast 100%).',
      },
      risk_verdict: { label: 'Review', level: 'review', action: 'Confirm order details before dispatch', reasons: ['Moderate delivery success rate (83.3%)'] },
    },
    reports: [],
  }

  it('matches the BD Courier app: rate-only couriers, their overall rate and verdict', async () => {
    const s = summarizeBdCourier(rateOnly)!
    expect(s).toMatchObject({ total: 3, delivered: 2, cancelled: 1, success_ratio: 83.34, ratio_source: 'provider', parcel_floor: 53 })
    expect(s.couriers.find((c) => c.courier === 'steadfast')).toMatchObject({ name: 'SteadFast', rate_only: true, parcel_range: '50+', success_ratio: 100, orders: 0 })
    expect(s.couriers.find((c) => c.courier === 'carrybee')).toMatchObject({ success_ratio: 66.67, orders: 3 })
    expect(s.couriers.find((c) => c.courier === 'pathao')?.success_ratio).toBeNull()
    expect(s.couriers.map((c) => c.courier)).not.toContain('risk_verdict')
    expect(s.verdict).toEqual({ label: 'Review', level: 'review', action: 'Confirm order details before dispatch', reasons: ['Moderate delivery success rate (83.3%)'] })
    expect(s.calculation_note).toMatch(/average of each courier/)
    // The decision uses BD Courier's own 83.34%, not 2 of 3 parcels.
    const r = await new CourierHistoryProvider({ apiKey: 'k' }, vi.fn().mockResolvedValue(jsonResponse(rateOnly))).checkCustomer({ phone: '01712345678' })
    expect(r).toMatchObject({ ok: true, courierScore: 83.34, parcelFloor: 53, counts: { total: 3, delivered: 2, returned: 1 } })
    const payload = await new FraudDetectionService([new CourierHistoryProvider({ apiKey: 'k' }, vi.fn().mockResolvedValue(jsonResponse(rateOnly)))])
      .check({ phone: '01712345678' })
    expect(payload).toMatchObject({ provider_courier_score: 83.34, provider_parcel_floor: 53 })
    // Only a rate-only courier: still history, not a "new customer".
    const onlySteadfast = summarizeBdCourier({ status: 'success', data: { steadfast: rateOnly.data.steadfast, summary: { total_parcel: 0, success_parcel: 0, cancelled_parcel: 0, success_ratio: 100 } } })
    expect(onlySteadfast).toMatchObject({ total: 0, success_ratio: 100, parcel_floor: 50 })
  })

  it('POSTs the cleaned number with the key as a Bearer token (never in the URL)', async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse(bd))
    const result = await new CourierHistoryProvider({ apiKey: 'bd-secret' }, fetchFn).checkCustomer({ phone: '+880 1712-345678' })
    const [url, init] = fetchFn.mock.calls[0]
    expect(url).toBe('https://api.bdcourier.com/courier-check')
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ phone: '01712345678' }) })
    expect(init.headers.Authorization).toBe('Bearer bd-secret')
    expect(String(url)).not.toContain('bd-secret')
    expect(result).toMatchObject({ provider: 'courier_history', ok: true, counts: { total: 430, delivered: 360, returned: 70 } })
  })

  it('explains a rejected key, a used-up plan and an error answer', async () => {
    const run = (body: unknown, status: number) =>
      new CourierHistoryProvider({ apiKey: 'bd-secret' }, vi.fn().mockResolvedValue(jsonResponse(body, status))).checkCustomer({ phone: '01712345678' })
    expect((await run({ message: 'Unauthenticated.' }, 401)).error).toBe('BD Courier rejected the API key (Unauthenticated.). Copy it again from your BD Courier account.')
    expect((await run({ message: 'Too many' }, 429)).error).toMatch(/daily limit/)
    expect((await run({ status: 'error', message: 'Phone number is invalid' }, 200)).error).toBe('BD Courier: Phone number is invalid')
    expect((await run({ errors: { phone: ['The phone field is required.'] } }, 422)).error).toBe('BD Courier answered HTTP 422: The phone field is required.')
  })

  it('uses the saved key, else the BDCOURIER_API_KEY secret; old saved keys stay LLCG', () => {
    expect(courierHistoryConfig({ api_key: 'old' })).toMatchObject({ apiKey: 'old', service: 'llcg' })
    expect(courierHistoryConfig({ api_key: 'new', service: 'bdcourier' })).toMatchObject({ apiKey: 'new', service: 'bdcourier' })
    expect(courierHistoryConfig(null)).toBeNull()
    vi.stubEnv('BDCOURIER_API_KEY', 'from-secret')
    try {
      expect(courierHistoryConfig(null)).toMatchObject({ apiKey: 'from-secret', service: 'bdcourier' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
