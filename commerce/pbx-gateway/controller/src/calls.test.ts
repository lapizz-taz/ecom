import { describe, expect, it, vi } from 'vitest'
import type { Ended, VoiceDriveApi } from './api.ts'
import type { Ari, AriChannel } from './ari.ts'
import { CallManager, endpointOf } from './calls.ts'

const chan = (id: string, name: string, state = 'Ring', number = ''): AriChannel => ({ id, name, state, caller: { number, name: '' } })

function setup(api: Partial<VoiceDriveApi>) {
  const calls: Array<{ method: string; path: string; query?: Record<string, unknown>; body?: unknown }> = []
  const ari: Ari = {
    request: async (method, path, query, body) => {
      calls.push({ method, path, query, body })
      if (path.endsWith('/variable')) return { value: '11111111-2222-3333-4444-555555555555' } as never
      return null as never
    },
  }
  const ended: Ended[] = []
  const answered: Array<[string, string | null | undefined]> = []
  let t = 0
  const full: VoiceDriveApi = {
    ping: async () => ({}), trunks: async () => [],
    outboundStart: async () => ({ allow: false }), inboundStart: async () => ({ allow: false }),
    answered: async (id, sip) => { answered.push([id, sip]) },
    ended: async (e) => { ended.push(e) },
    ...api,
  }
  const m = new CallManager(ari, full, () => t)
  return { m, calls, ended, answered, tick: (ms: number) => { t += ms } }
}

describe('endpointOf', () => {
  it('reads the PJSIP endpoint from a channel name', () => {
    expect(endpointOf('PJSIP/vd1x101-0000000a')).toBe('vd1x101')
    expect(endpointOf('Local/foo')).toBeNull()
  })
})

describe('outgoing calls', () => {
  it('asks the app first; a refused call is hung up and nothing is billed', async () => {
    const outboundStart = vi.fn(async () => ({ allow: false, reason: 'INSUFFICIENT_BALANCE' }))
    const { m, calls, ended } = setup({ outboundStart })
    await m.onEvent({ type: 'StasisStart', args: ['outbound', '01711000111'], channel: chan('a1', 'PJSIP/vd1x101-00000001') })
    expect(outboundStart).toHaveBeenCalledWith('vd1x101', '01711000111', '11111111-2222-3333-4444-555555555555', 'a1')
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/channels/a1', query: { reason: 'rejected' } })
    expect(ended).toEqual([])
  })

  it('dials through the trunk with the caller ID, bridges on answer, and reports seconds from answer to hang-up', async () => {
    const { m, calls, ended, answered, tick } = setup({
      outboundStart: async () => ({ allow: true, callId: 'c1', trunk: 'vdtrunk-1', dial: '01711000111', callerId: '09639123456', maxSeconds: 900 }),
    })
    await m.onEvent({ type: 'StasisStart', args: ['outbound', '01711000111'], channel: chan('a1', 'PJSIP/vd1x101-00000001') })
    const create = calls.find((c) => c.path === '/channels/create')!
    expect(create.query).toMatchObject({ endpoint: 'PJSIP/01711000111@vdtrunk-1', app: 'voicedrive', originator: 'a1' })
    expect(create.body).toEqual({ variables: { 'CALLERID(num)': '09639123456', 'CALLERID(name)': '09639123456' } })
    const dialedId = create.query!.channelId as string
    expect(calls.some((c) => c.path === `/channels/${dialedId}/dial`)).toBe(true)

    tick(5_000) // ringing is free
    await m.onEvent({ type: 'ChannelStateChange', channel: chan(dialedId, 'PJSIP/vdtrunk-1-00000002', 'Up') })
    expect(answered).toEqual([['c1', undefined]])
    expect(calls.some((c) => c.path === '/bridges/vdb-c1/addChannel' && (c.query as Record<string, string>).channel === `a1,${dialedId}`)).toBe(true)

    tick(61_200)
    await m.onEvent({ type: 'ChannelDestroyed', channel: chan('a1', 'PJSIP/vd1x101-00000001'), cause: 16, cause_txt: 'Normal Clearing' })
    expect(ended).toEqual([{ callId: 'c1', status: 'COMPLETED', billsec: 61.2, hangupCause: 'Normal Clearing', answered: true }])
    // The other side going away later doesn't report twice.
    await m.onEvent({ type: 'ChannelDestroyed', channel: chan(dialedId, 'x'), cause: 16 })
    expect(ended).toHaveLength(1)
    expect(m.activeCalls).toBe(0)
  })

  it('StasisEnd without a cause waits for ChannelDestroyed, which knows the customer was busy', async () => {
    vi.useFakeTimers()
    try {
      const { m, calls, ended } = setup({ outboundStart: async () => ({ allow: true, callId: 'c9', trunk: 'vdtrunk-1', dial: '018', maxSeconds: 60 }) })
      await m.onEvent({ type: 'StasisStart', args: ['outbound', '018'], channel: chan('a1', 'PJSIP/vd1x101-00000001') })
      const dialedId = calls.find((c) => c.path === '/channels/create')!.query!.channelId as string
      await m.onEvent({ type: 'StasisEnd', channel: chan(dialedId, 'x') })
      await m.onEvent({ type: 'ChannelDestroyed', channel: chan(dialedId, 'x'), cause: 17, cause_txt: 'User busy' })
      await vi.advanceTimersByTimeAsync(2_000)
      expect(ended).toHaveLength(1)
      expect(ended[0]).toMatchObject({ callId: 'c9', status: 'BUSY', answered: false })
    } finally {
      vi.useRealTimers()
    }
  })

  it('a busy customer ends the call as BUSY with no seconds', async () => {
    const { m, calls, ended } = setup({ outboundStart: async () => ({ allow: true, callId: 'c2', trunk: 'vdtrunk-1', dial: '017', maxSeconds: 60 }) })
    await m.onEvent({ type: 'StasisStart', args: ['outbound', '017'], channel: chan('a1', 'PJSIP/vd1x101-00000001') })
    const dialedId = calls.find((c) => c.path === '/channels/create')!.query!.channelId as string
    await m.onEvent({ type: 'Dial', peer: chan(dialedId, 'x'), dialstatus: 'BUSY' })
    await m.onEvent({ type: 'ChannelDestroyed', channel: chan('a1', 'x'), cause: 17 })
    expect(ended[0]).toMatchObject({ callId: 'c2', status: 'BUSY', billsec: 0, answered: false })
  })

  it('cuts the call at the allowed seconds', async () => {
    vi.useFakeTimers()
    try {
      const { m, calls, ended } = setup({ outboundStart: async () => ({ allow: true, callId: 'c3', trunk: 'vdtrunk-1', dial: '017', maxSeconds: 30 }) })
      await m.onEvent({ type: 'StasisStart', args: ['outbound', '017'], channel: chan('a1', 'PJSIP/vd1x101-00000001') })
      const dialedId = calls.find((c) => c.path === '/channels/create')!.query!.channelId as string
      await m.onEvent({ type: 'ChannelStateChange', channel: chan(dialedId, 'x', 'Up') })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(ended[0]).toMatchObject({ callId: 'c3', status: 'COMPLETED', hangupCause: 'max_seconds' })
      expect(calls.filter((c) => c.method === 'DELETE' && c.path.startsWith('/channels/')).length).toBeGreaterThanOrEqual(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('incoming calls', () => {
  const inbound = (targets: string[], strategy: 'RING_ALL' | 'LONGEST_IDLE' = 'RING_ALL') => async () => ({
    allow: true, callId: 'in1', strategy, ringSeconds: 20, maxSeconds: 600,
    targets: targets.map((s, i) => ({ agentId: `ag${i}`, sipUsername: s, extension: String(101 + i) })),
  })

  it('rings every available agent with the call id header; the first to answer gets the caller', async () => {
    const { m, calls, ended, answered, tick } = setup({ inboundStart: inbound(['vd1x101', 'vd1x102']) })
    await m.onEvent({ type: 'StasisStart', args: ['inbound', '09639123456', '1'], channel: chan('c1', 'PJSIP/vdtrunk-1-1', 'Ring', '01722000444') })
    const legs = calls.filter((c) => c.path === '/channels/create')
    expect(legs.map((l) => l.query!.endpoint)).toEqual(['PJSIP/vd1x101', 'PJSIP/vd1x102'])
    expect(legs[0].body).toMatchObject({ variables: { 'PJSIP_HEADER(add,X-VD-Call-Id)': 'in1', 'CALLERID(num)': '01722000444' } })
    const [l1, l2] = legs.map((l) => l.query!.channelId as string)
    await m.onEvent({ type: 'ChannelStateChange', channel: chan(l2, 'PJSIP/vd1x102-2', 'Up') })
    expect(answered).toEqual([['in1', 'vd1x102']])
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/channels/${l1}`)).toBe(true)
    expect(calls.some((c) => c.path === '/channels/c1/answer')).toBe(true)
    tick(42_000)
    await m.onEvent({ type: 'ChannelDestroyed', channel: chan('c1', 'x'), cause: 16 })
    expect(ended[0]).toMatchObject({ callId: 'in1', status: 'COMPLETED', billsec: 42, answered: true })
  })

  it('no agent answers: a missed call', async () => {
    const { m, calls, ended } = setup({ inboundStart: inbound(['vd1x101']) })
    await m.onEvent({ type: 'StasisStart', args: ['inbound', '09639123456', '1'], channel: chan('c1', 'x', 'Ring', '019') })
    const leg = calls.find((c) => c.path === '/channels/create')!.query!.channelId as string
    await m.onEvent({ type: 'ChannelDestroyed', channel: chan(leg, 'x'), cause: 19 })
    expect(ended[0]).toMatchObject({ callId: 'in1', status: 'NO_ANSWER', answered: false })
  })

  it('longest idle rings one agent at a time', async () => {
    const { m, calls } = setup({ inboundStart: inbound(['vd1x101', 'vd1x102'], 'LONGEST_IDLE') })
    await m.onEvent({ type: 'StasisStart', args: ['inbound', '09639123456', '1'], channel: chan('c1', 'x', 'Ring', '019') })
    let legs = calls.filter((c) => c.path === '/channels/create')
    expect(legs).toHaveLength(1)
    await m.onEvent({ type: 'ChannelDestroyed', channel: chan(legs[0].query!.channelId as string, 'x'), cause: 19 })
    legs = calls.filter((c) => c.path === '/channels/create')
    expect(legs.map((l) => l.query!.endpoint)).toEqual(['PJSIP/vd1x101', 'PJSIP/vd1x102'])
  })

  it('a caller who hangs up while ringing is a missed call and the agents stop ringing', async () => {
    const { m, calls, ended } = setup({ inboundStart: inbound(['vd1x101']) })
    await m.onEvent({ type: 'StasisStart', args: ['inbound', '09639123456', '1'], channel: chan('c1', 'x', 'Ring', '019') })
    const leg = calls.find((c) => c.path === '/channels/create')!.query!.channelId as string
    await m.onEvent({ type: 'ChannelDestroyed', channel: chan('c1', 'x'), cause: 16 })
    expect(ended[0]).toMatchObject({ status: 'NO_ANSWER' })
    expect(calls.some((c) => c.method === 'DELETE' && c.path === `/channels/${leg}`)).toBe(true)
  })

  it('refused calls (channel limit) get congestion', async () => {
    const { m, calls } = setup({ inboundStart: async () => ({ allow: false, reason: 'CHANNEL_LIMIT' }) })
    await m.onEvent({ type: 'StasisStart', args: ['inbound', '09639123456', '1'], channel: chan('c1', 'x', 'Ring', '019') })
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/channels/c1', query: { reason: 'congestion' } })
  })
})
