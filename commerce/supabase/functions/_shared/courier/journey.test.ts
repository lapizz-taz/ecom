import { describe, expect, it, vi } from 'vitest'
import { fetchPathaoJourney, parsePathaoJourney, parseRedxJourney, pathaoTime } from './journey'
import { PathaoProvider, RedxProvider } from './providers'

// The shape of merchant.pathao.com/api/v1/user/tracking (checked on 5 Nov 2026; names made up).
const pathaoBody = {
  code: 200,
  type: 'success',
  message: 'Order information',
  data: {
    order: { consignment: 'DT0511XXXXXX', order_id: 1 },
    state: { id: 5, name: 'Delivered', transition_id: 2 },
    log: [
      { created_at: 'Nov 2, 2026 9:41 PM', desc: 'Pickup requested.', notes: '', grouped_status: ['Accepted', 'Accepted', 1, 1] },
      { created_at: 'Nov 3, 2026 7:47 PM', desc: 'Received at pickup hub: Shewrapara.', notes: '', grouped_status: ['In-Transit', 'In-Transit', 3, 1] },
      { created_at: 'Nov 4, 2026 11:19 AM', desc: 'Assigned to Rider One (01700000000) for delivery.', notes: '', grouped_status: ['Ready For Delivery', 'Ready For Delivery', 4, 1] },
      { created_at: 'Nov 4, 2026 4:05 PM', desc: 'Delivered.', notes: 'Amount Collected: 1450', grouped_status: ['Delivered', 'Delivered', 5, 2] },
      { created_at: 'Nov 4, 2026 4:05 PM', desc: '', notes: '' },
    ],
  },
}

describe('courier journey', () => {
  it('reads Pathao times as Dhaka time', () => {
    expect(pathaoTime('Nov 4, 2026 11:19 AM')).toBe('2026-11-04T05:19:00.000Z')
    expect(pathaoTime('Nov 4, 2026 4:05 PM')).toBe('2026-11-04T10:05:00.000Z')
    expect(pathaoTime('Nov 2, 2026 12:30 AM')).toBe('2026-11-01T18:30:00.000Z')
    expect(pathaoTime('Dec 31, 2026 12:05 PM')).toBe('2026-12-31T06:05:00.000Z')
    expect(pathaoTime('yesterday')).toBeNull()
    expect(pathaoTime(null)).toBeNull()
  })

  it('turns Pathao tracking into steps, newest first, with stages and notes', () => {
    const j = parsePathaoJourney(pathaoBody)!
    expect(j.stage).toBe('Delivered')
    expect(j.steps.map((s) => s.text)).toEqual([
      'Delivered.', 'Assigned to Rider One (01700000000) for delivery.', 'Received at pickup hub: Shewrapara.', 'Pickup requested.',
    ])
    expect(j.steps[0]).toEqual({ at: '2026-11-04T10:05:00.000Z', text: 'Delivered.', note: 'Amount Collected: 1450', stage: 'Delivered' })
    expect(j.steps[1].stage).toBe('Ready For Delivery')
    expect(parsePathaoJourney({ data: {} })).toBeNull()
    expect(parsePathaoJourney('<html>')).toBeNull()
  })

  it('asks Pathao with the consignment id only', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(pathaoBody), { status: 200 }))
    const j = await fetchPathaoJourney('DT0511XXXXXX', fetchFn as unknown as typeof fetch)
    expect(j.steps).toHaveLength(4)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://merchant.pathao.com/api/v1/user/tracking')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ consignment_id: 'DT0511XXXXXX' })
  })

  it('Pathao tracking: the journey when the page answers, the status when it does not', async () => {
    const config = { clientId: 'c', clientSecret: 's', username: 'u', password: 'p', storeId: '1' }
    const live = vi.fn(async (url: string) => url.includes('/user/tracking')
      ? new Response(JSON.stringify(pathaoBody), { status: 200 })
      : new Response('{}', { status: 500 }))
    const t = await new PathaoProvider(config, live as unknown as typeof fetch).getTracking({ consignmentId: 'DT1', trackingNumber: 'DT1' })
    expect(t.journey).toHaveLength(4)
    expect(t.stage).toBe('Delivered')
    expect(t.url).toContain('consignment_id=DT1')

    const fallback = vi.fn(async (url: string) => {
      if (url.includes('/user/tracking')) return new Response('<html>changed</html>', { status: 200 })
      if (url.includes('issue-token')) return new Response(JSON.stringify({ access_token: 'T', expires_in: 3600 }), { status: 200 })
      return new Response(JSON.stringify({ data: { order_status: 'Delivered', order_status_slug: 'delivered' } }), { status: 200 })
    })
    const f = await new PathaoProvider({ ...config, clientId: 'c2' }, fallback as unknown as typeof fetch).getTracking({ consignmentId: 'DT1' })
    expect(f.journey).toBeUndefined()
    expect(f.events).toEqual([{ status: 'delivered' }])
  })

  it('turns RedX tracking into steps, newest first', async () => {
    const body = { tracking: [
      { message_en: 'Package is created successfully', message_bn: '', time: '2026-11-03T05:00:00.000Z' },
      { message_en: 'Package is in transit to Sylhet hub', message_bn: '', time: '2026-11-04T09:00:00.000Z' },
      { message_en: '', message_bn: 'ডেলিভারি হয়েছে', time: '2026-11-05T08:00:00.000Z' },
    ] }
    const j = parseRedxJourney(body)!
    expect(j.steps.map((s) => s.text)).toEqual(['ডেলিভারি হয়েছে', 'Package is in transit to Sylhet hub', 'Package is created successfully'])
    expect(parseRedxJourney({})).toBeNull()

    const fetchFn = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes('/parcel/track/') ? body : { parcel: { status: 'delivered' } }), { status: 200 }))
    const t = await new RedxProvider({ accessToken: 'X' }, fetchFn as unknown as typeof fetch).getTracking({ trackingNumber: '25A1B2' })
    expect(t.journey).toHaveLength(3)
    expect(String(fetchFn.mock.calls[0][0])).toBe('https://openapi.redx.com.bd/v1.0.0-beta/parcel/track/25A1B2')
  })
})
