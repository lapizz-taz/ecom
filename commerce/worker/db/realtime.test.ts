import { describe, expect, it } from 'vitest'
import { decode, deliveries, encode, handle, type Message, type SocketState } from './realtime.ts'

const fresh = (vsn = '2.0.0'): SocketState => ({ vsn, uid: null, sid: null, exp: 0, subs: [], next: 0 })
const verify = async (t: string) => (t === 'good' ? { uid: 'u1', sid: 's1', exp: 4_000_000_000 } : null)
const msg = (event: string, payload: Record<string, unknown> = {}, topic = 'realtime:admin-new-orders'): Message => ({ joinRef: '1', ref: '2', topic, event, payload })

describe('live updates protocol (realtime-js)', () => {
  it('reads and writes both message formats', () => {
    expect(decode('["1","2","realtime:x","phx_join",{"a":1}]', '2.0.0')).toEqual({ joinRef: '1', ref: '2', topic: 'realtime:x', event: 'phx_join', payload: { a: 1 } })
    expect(decode('{"topic":"phoenix","event":"heartbeat","payload":{},"ref":"3"}', '1.0.0')).toMatchObject({ topic: 'phoenix', event: 'heartbeat', ref: '3' })
    expect(decode('nonsense', '2.0.0')).toBeNull()
    expect(JSON.parse(encode(msg('phx_reply'), '2.0.0'))).toEqual(['1', '2', 'realtime:admin-new-orders', 'phx_reply', {}])
  })

  it('answers heartbeats and joins with server ids matching the client bindings', async () => {
    const s = fresh()
    expect((await handle(s, { joinRef: null, ref: '9', topic: 'phoenix', event: 'heartbeat', payload: {} }, verify))[0].payload).toEqual({ status: 'ok', response: {} })
    const [r] = await handle(s, msg('phx_join', { access_token: 'good', config: { postgres_changes: [
      { event: 'INSERT', schema: 'public', table: 'orders' }, { event: 'UPDATE', schema: 'public', table: 'orders' }, { event: '*', schema: 'public', table: 'secrets' },
    ] } }), verify)
    expect(r.payload).toEqual({ status: 'ok', response: { postgres_changes: [
      { id: 1, event: 'INSERT', schema: 'public', table: 'orders' }, { id: 2, event: 'UPDATE', schema: 'public', table: 'orders' }, { id: 3, event: '*', schema: 'public', table: 'secrets' },
    ] } })
    expect(s).toMatchObject({ uid: 'u1', sid: 's1' })
    // only tables Supabase published for live updates are watched
    expect(s.subs.map((x) => x[3])).toEqual(['orders', 'orders'])
    expect((await handle(s, msg('phx_join', { access_token: 'forged', config: {} }, 'realtime:y'), verify))[0].payload).toMatchObject({ status: 'error' })
    await handle(s, msg('phx_leave'), verify)
    expect(s.subs).toEqual([])
  })

  it('sends only rows the subscriber may read, to the channels whose event matches', async () => {
    const s = fresh()
    await handle(s, msg('phx_join', { access_token: 'good', config: { postgres_changes: [{ event: 'INSERT', schema: 'public', table: 'orders' }] } }), verify)
    await handle(s, msg('phx_join', { access_token: 'good', config: { postgres_changes: [{ event: '*', schema: 'public', table: 'orders' }] } }, 'realtime:rt-orders'), verify)
    const reads: string[] = []
    const readAs = (_st: SocketState, table: string, search: string) => {
      reads.push(`${table}?${search}`)
      return search.includes('id=eq.mine') ? { id: 'mine', order_number: 'ORD-1' } : null
    }
    const out = deliveries(s, [
      { table: 'orders', type: 'INSERT', key: { id: 'mine' } },
      { table: 'orders', type: 'INSERT', key: { id: 'theirs' } },
      { table: 'orders', type: 'UPDATE', key: { id: 'mine' } },
      { table: 'inventory', type: 'UPDATE', key: { variant_id: 'v' } },
    ], readAs)
    expect(out.map((m) => [m.topic, (m.payload.data as { type: string }).type, (m.payload as { ids: number[] }).ids])).toEqual([
      ['realtime:admin-new-orders', 'INSERT', [1]], ['realtime:rt-orders', 'INSERT', [2]], ['realtime:rt-orders', 'UPDATE', [2]],
    ])
    expect(out[0].payload.data).toMatchObject({ schema: 'public', table: 'orders', record: { id: 'mine', order_number: 'ORD-1' } })
    expect(reads).not.toContain('inventory?select=*&variant_id=eq.v')
    // an expired session gets nothing until it sends a new token
    expect(deliveries({ ...s, exp: 1 }, [{ table: 'orders', type: 'INSERT', key: { id: 'mine' } }], readAs)).toEqual([])
  })
})
