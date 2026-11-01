import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PushMessage, SendResult, VapidKeys } from '../_shared/web-push.ts'
import { type ClaimedOrder, drain, money, newOrderMessage } from './handler.ts'

const order = (n: number, extra: Partial<ClaimedOrder> = {}): ClaimedOrder => ({
  id: `o${n}`, number: String(1050 + n), customer: `Customer ${n}`, total: 379.9, created_by: null, source: 'STOREFRONT', channel: null, ...extra,
})

describe('the message', () => {
  it('names one order with its customer, amount and where it came from', () => {
    expect(newOrderMessage([order(1, { customer: 'Test Order', channel: 'SHOPIFY' })])).toEqual({
      title: 'New order 1051', body: 'Test Order · ৳379.9 · Shopify', url: '/admin/orders/o1', tag: 'order-o1',
    })
    expect(newOrderMessage([order(2, { total: '1500' })]).body).toBe('Customer 2 · ৳1,500 · Online store')
  })

  it('sums up a burst of orders in one notification', () => {
    const five = [1, 2, 3, 4, 5].map((n) => order(n, { total: 1000 }))
    expect(newOrderMessage(five)).toEqual({
      title: '5 new orders', body: '1051, 1052, 1053 and 2 more · ৳5,000 in all', url: '/admin/orders/web', tag: 'new-orders',
    })
    expect(money(1234.5)).toBe('৳1,234.5')
  })
})

describe('sending a business\'s new orders', () => {
  const keys: VapidKeys = { public_key: 'pub', private_jwk: {} }
  function fakeDb(claim: unknown) {
    const calls: Array<{ fn: string; args: Record<string, unknown> }> = []
    const client = { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push({ fn, args }); return { data: fn === 'push_claim' ? claim : null, error: null } } }
    return { client: client as unknown as SupabaseClient, calls }
  }

  it('tells every listening device except the person who made the order, and records the answers', async () => {
    const { client, calls } = fakeDb({
      orders: [order(1, { created_by: 'u-maker' })],
      devices: [
        { id: 'd-maker', user_id: 'u-maker', endpoint: 'https://fcm.googleapis.com/a', p256dh: 'k', auth: 'a' },
        { id: 'd-owner', user_id: 'u-owner', endpoint: 'https://web.push.apple.com/b', p256dh: 'k', auth: 'a' },
        { id: 'd-old', user_id: 'u-owner', endpoint: 'https://fcm.googleapis.com/c', p256dh: 'k', auth: 'a' },
        { id: 'd-busy', user_id: 'u-other', endpoint: 'https://fcm.googleapis.com/d', p256dh: 'k', auth: 'a' },
      ],
    })
    const sent: Array<{ device: string; message: PushMessage }> = []
    const send = async (device: { endpoint: string }, message: PushMessage): Promise<SendResult> => {
      sent.push({ device: device.endpoint, message })
      if (device.endpoint.endsWith('/c')) return { ok: false, status: 410, gone: true, error: 'expired' }
      if (device.endpoint.endsWith('/d')) return { ok: false, status: 429, gone: false, error: 'slow down' }
      return { ok: true, status: 201 }
    }
    const result = await drain(client, send as never, async () => keys)
    expect(result).toEqual({ orders: 1, sent: 1, gone: 1, failed: 1 })
    expect(sent.map((s) => s.device)).toEqual(['https://web.push.apple.com/b', 'https://fcm.googleapis.com/c', 'https://fcm.googleapis.com/d'])
    expect(sent[0].message.title).toBe('New order 1051')
    expect(calls.at(-1)).toEqual({ fn: 'push_done', args: { p_sent: ['d-owner'], p_gone: ['d-old'], p_failed: ['d-busy'] } })
  })

  it('does nothing (and needs no keys) when nothing waits or nobody listens', async () => {
    let asked = 0
    const keysFor = async () => { asked++; return keys }
    for (const claim of [{ orders: [], devices: [] }, { orders: [order(1)], devices: [] }]) {
      const { client, calls } = fakeDb(claim)
      expect((await drain(client, (async () => ({ ok: true, status: 201 })) as never, keysFor)).sent).toBe(0)
      expect(calls.map((c) => c.fn)).toEqual(['push_claim'])
    }
    expect(asked).toBe(0)
  })
})
