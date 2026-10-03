import { describe, expect, it } from 'vitest'
import { courierTime, mapPathaoEvent, normalizePathao, normalizeSteadfast, sameSecret } from './courier/webhooks.ts'

describe('Pathao webhooks', () => {
  it('reads an event with its fees and a stable key', async () => {
    const body = {
      consignment_id: 'DL121224VS8TTJ', merchant_order_id: 'ISO-10070', updated_at: '2024-12-21 23:57:55',
      timestamp: '2024-12-21T17:57:55+00:00', store_id: 130820, event: 'order.delivered',
      collected_amount: 1000, delivery_fee: 83.46, cod_fee: '10',
    }
    const raw = JSON.stringify(body)
    const event = await normalizePathao(body, raw)
    expect(event).toMatchObject({
      event_key: 'pathao:DL121224VS8TTJ:order.delivered:2024-12-21 23:57:55',
      consignment_id: 'DL121224VS8TTJ', order_ref: 'ISO-10070', status: 'DELIVERED', provider_status: 'delivered',
      occurred_at: '2024-12-21T17:57:55.000Z', charges: { delivery_fee: 83.46, cod_fee: 10, collected: 1000 },
    })
    expect((await normalizePathao(body, raw)).event_key).toBe(event.event_key)
  })

  it('maps the lifecycle, including returns and cancellations', () => {
    expect(mapPathaoEvent('order.picked')).toBe('PICKED_UP')
    expect(mapPathaoEvent('order.assigned-for-delivery')).toBe('OUT_FOR_DELIVERY')
    expect(mapPathaoEvent('order.delivery-failed')).toBe('FAILED')
    expect(mapPathaoEvent('order.returned')).toBe('RETURNED')
    expect(mapPathaoEvent('order.pickup-cancelled')).toBe('CANCELLED')
    expect(mapPathaoEvent('order.paid')).toBeNull()
    expect(mapPathaoEvent('store.created')).toBeNull()
  })

  it('ignores fee fields that are not amounts', async () => {
    const event = await normalizePathao({ consignment_id: 'X', event: 'order.returned', delivery_fee: 'n/a', return_charge: 45 }, '{}')
    expect(event.charges).toEqual({ return_fee: 45 })
  })
})

describe('Steadfast webhooks', () => {
  it('reads delivery updates and tracking notes', async () => {
    const body = { notification_type: 'delivery_status', consignment_id: 12345, invoice: 'ISO-10071', cod_amount: 1500,
      status: 'delivered', delivery_charge: 100, tracking_message: 'Delivered', updated_at: '2025-03-02 12:45:30' }
    expect(await normalizeSteadfast(body, JSON.stringify(body))).toMatchObject({
      consignment_id: '12345', order_ref: 'ISO-10071', status: 'DELIVERED', charges: { delivery_fee: 100, collected: 1500 },
      occurred_at: '2025-03-02T06:45:30.000Z',
    })
    const note = await normalizeSteadfast({ notification_type: 'tracking_update', consignment_id: 1, tracking_message: 'At hub' }, '{"a":1}')
    expect(note.status).toBeNull()
    expect(note.event_key).toMatch(/^steadfast:1:tracking_update:-:[0-9a-f]{20}$/)
  })
})

describe('helpers', () => {
  it('reads courier times as Dhaka time unless a zone is given', () => {
    expect(courierTime(null, '2025-01-01 10:00')).toBe('2025-01-01T04:00:00.000Z')
    expect(courierTime('2025-01-01T10:00:00Z', null)).toBe('2025-01-01T10:00:00.000Z')
    expect(courierTime(null, 'yesterday')).toBeNull()
  })

  it('compares secrets without leaking their length', () => {
    expect(sameSecret('abc-123-secret-xyz', 'abc-123-secret-xyz')).toBe(true)
    expect(sameSecret('abc-123-secret-xy', 'abc-123-secret-xyz')).toBe(false)
    expect(sameSecret('', '')).toBe(false)
    expect(sameSecret(null, 'x')).toBe(false)
  })
})
