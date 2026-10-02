import { describe, expect, it, vi } from 'vitest'
import { bdMobile, CourierHistoryProvider, summarizeCourierHistory } from './fraud/courier-history.ts'
import { FraudDetectionService, providersFromSettings } from './fraud/service.ts'

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

describe('courier-history check', () => {
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
    const provider = new CourierHistoryProvider({ apiKey: 'secret-key' }, fetchFn)
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
      [{}, 403, /HTTP 403/],
    ]
    for (const [body, status, pattern] of cases) {
      const provider = new CourierHistoryProvider({ apiKey: 'secret-key' }, vi.fn().mockResolvedValue(jsonResponse(body, status)))
      const result = await provider.checkCustomer({ phone: '01712345678' })
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(pattern)
      expect(result.error).not.toContain('secret-key')
    }
    const offline = new CourierHistoryProvider({ apiKey: 'secret-key' }, vi.fn().mockRejectedValue(
      new TypeError('error sending request for url (https://llcgteam.com/courier-fraud-checker/fatch.php?api_key=secret-key&term=01712345678)')))
    expect(await offline.checkCustomer({ phone: '01712345678' })).toMatchObject({ ok: false, error: 'Could not reach the courier history service' })
    const odd = new CourierHistoryProvider({ apiKey: 'secret-key' }, vi.fn().mockRejectedValue(new Error('bad thing with secret-key inside')))
    expect((await odd.checkCustomer({ phone: '01712345678' })).error).toBe('bad thing with [redacted] inside')
    const foreign = new CourierHistoryProvider({ apiKey: 'k' }, vi.fn())
    expect(await foreign.checkCustomer({ phone: '+44 7700 900123' })).toMatchObject({ ok: false, error: 'Not a Bangladeshi mobile number' })
  })

  it('times out instead of holding up the checkout', async () => {
    const hang = vi.fn((_url: URL, init: RequestInit) => new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    }))
    const provider = new CourierHistoryProvider({ apiKey: 'k', timeoutMs: 20 }, hang as unknown as typeof fetch)
    expect(await provider.checkCustomer({ phone: '01712345678' })).toMatchObject({ ok: false, error: 'Courier history service timed out' })
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
