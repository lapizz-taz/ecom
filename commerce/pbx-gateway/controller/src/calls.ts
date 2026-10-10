// Call control for the "voicedrive" ARI application.
//
//   outbound  agent softphone → app request check → trunk → customer
//   inbound   trunk (business DID) → ring the business's available agents
//
// The gateway, not the browser, times the call: billsec runs from the
// customer answering to the first hang-up and is reported to the app, which
// charges it. A call is cut at the maxSeconds the app allowed.
import { randomUUID } from 'node:crypto'
import type { InboundTarget, VoiceDriveApi } from './api.ts'
import type { Ari, AriChannel, AriEvent } from './ari.ts'
import { log } from './log.ts'

type Status = 'COMPLETED' | 'NO_ANSWER' | 'BUSY' | 'FAILED' | 'CANCELLED'

interface Base {
  callId: string
  answeredAt?: number
  ended: boolean
  bridgeId?: string
  maxTimer?: ReturnType<typeof setTimeout>
  failure?: Status
  cause?: string
}
interface OutSession extends Base { kind: 'out'; agent: string; dialed?: string; maxSeconds: number }
interface InSession extends Base {
  kind: 'in'
  caller: string
  legs: Map<string, string>      // channel id → sip username
  winner?: string
  queue: InboundTarget[]         // still to ring (longest idle)
  ringTimer?: ReturnType<typeof setTimeout>
  ringSeconds: number
  each: number                   // seconds each agent rings
  maxSeconds: number
  from: string
}
type Session = OutSession | InSession

const DIAL_FAIL: Record<string, Status> = { BUSY: 'BUSY', NOANSWER: 'NO_ANSWER', CHANUNAVAIL: 'FAILED', CONGESTION: 'FAILED', CANCEL: 'CANCELLED' }
const CAUSE_FAIL: Record<number, Status> = { 17: 'BUSY', 18: 'NO_ANSWER', 19: 'NO_ANSWER', 21: 'FAILED', 34: 'FAILED', 38: 'FAILED' }
const REFUSE_REASON: Record<string, string> = { CHANNEL_LIMIT: 'congestion', INSUFFICIENT_BALANCE: 'rejected', UNKNOWN_NUMBER: 'unallocated' }

export const endpointOf = (channelName: string): string | null => /^PJSIP\/(.+)-[0-9a-f]+$/.exec(channelName)?.[1] ?? null

export class CallManager {
  private readonly sessions = new Map<string, Session>()   // callId → session
  private readonly byChannel = new Map<string, string>()   // channel id → callId
  private readonly ari: Ari
  private readonly api: VoiceDriveApi
  private readonly now: () => number

  constructor(ari: Ari, api: VoiceDriveApi, now: () => number = () => performance.now()) {
    this.ari = ari
    this.api = api
    this.now = now
  }

  get activeCalls(): number { return this.sessions.size }

  private chain: Promise<void> = Promise.resolve()

  /** Events are handled one at a time, in the order Asterisk sent them. */
  onEvent(e: AriEvent): Promise<void> {
    this.chain = this.chain.then(() => this.handle(e))
    return this.chain
  }

  private async handle(e: AriEvent): Promise<void> {
    try {
      switch (e.type) {
        case 'StasisStart': return await this.onStart(e.channel!, e.args ?? [])
        case 'ChannelStateChange': return await this.onState(e.channel!)
        case 'Dial': return await this.onDial(e)
        // The hang-up cause comes with ChannelDestroyed; StasisEnd (no cause) is only a fallback.
        case 'ChannelDestroyed': return await this.onGone(e.channel!.id, e.cause, e.cause_txt)
        case 'StasisEnd': {
          const id = e.channel!.id
          setTimeout(() => void this.onEvent({ type: 'StasisEndLate', channel: e.channel }), 1_000).unref?.()
          return void id
        }
        case 'StasisEndLate': return await this.onGone(e.channel!.id)
      }
    } catch (error) {
      log('error', 'event handling failed', { type: e.type, channel: e.channel?.id, error: (error as Error).message })
    }
  }

  // ------------------------------------------------------------------ start
  private async onStart(ch: AriChannel, args: string[]) {
    const [role] = args
    if (role === 'outbound') return this.startOutbound(ch, args[1] ?? ch.dialplan?.exten ?? '')
    if (role === 'inbound') return this.startInbound(ch, args[1] ?? '', args[2] ? Number(args[2]) : null)
    // 'dialed' and 'agentleg' channels are ours; they are tracked when created.
  }

  private async startOutbound(ch: AriChannel, dialed: string) {
    const sip = endpointOf(ch.name)
    if (!sip) return this.hangup(ch.id, 'rejected')
    let callId: string | null = null
    try {
      const v = await this.ari.request<{ value: string }>('GET', `/channels/${ch.id}/variable`, { variable: 'PJSIP_HEADER(read,X-VD-Call-Id)' })
      callId = /^[0-9a-f-]{36}$/.test(v?.value ?? '') ? v.value : null
    } catch { callId = null }
    let res
    try {
      res = await this.api.outboundStart(sip, dialed, callId, ch.id)
    } catch (error) {
      log('error', 'outbound check failed; refusing the call', { sip, error: (error as Error).message })
      return this.hangup(ch.id, 'congestion')
    }
    if (!res.allow || !res.callId || !res.trunk || !res.dial) {
      log('info', 'outbound refused', { sip, reason: res.reason, callId: res.callId })
      return this.hangup(ch.id, REFUSE_REASON[res.reason ?? ''] ?? 'rejected')
    }
    const s: OutSession = { kind: 'out', callId: res.callId, agent: ch.id, ended: false, maxSeconds: res.maxSeconds ?? 900 }
    this.track(s, ch.id)
    const dialedId = `vd-${randomUUID()}`
    s.dialed = dialedId
    this.byChannel.set(dialedId, s.callId)
    try {
      await this.ari.request('POST', '/channels/create', {
        endpoint: `PJSIP/${res.dial}@${res.trunk}`, app: 'voicedrive', appArgs: `dialed,${s.callId}`,
        channelId: dialedId, originator: ch.id,
      }, { variables: { 'CALLERID(num)': res.callerId ?? '', 'CALLERID(name)': res.callerId ?? '' } })
      await this.ari.request('POST', `/channels/${ch.id}/ring`).catch(() => undefined)
      await this.ari.request('POST', `/channels/${dialedId}/dial`, { caller: ch.id, timeout: 60 })
    } catch (error) {
      log('error', 'could not dial out', { callId: s.callId, error: (error as Error).message })
      s.failure = 'FAILED'
      await this.finish(s)
    }
  }

  private async startInbound(ch: AriChannel, did: string, businessCode: number | null) {
    const from = ch.caller?.number ?? ''
    let res
    try {
      res = await this.api.inboundStart(did, from, ch.id, Number.isFinite(businessCode) ? businessCode : null)
    } catch (error) {
      log('error', 'inbound check failed', { did, error: (error as Error).message })
      return this.hangup(ch.id, 'congestion')
    }
    if (!res.allow || !res.callId) {
      log('info', 'inbound refused', { did, reason: res.reason })
      return this.hangup(ch.id, REFUSE_REASON[res.reason ?? ''] ?? 'busy')
    }
    const s: InSession = {
      kind: 'in', callId: res.callId, caller: ch.id, ended: false, legs: new Map(), queue: [...(res.targets ?? [])],
      ringSeconds: res.ringSeconds ?? 30, each: res.ringSeconds ?? 30, maxSeconds: res.maxSeconds ?? 900, from,
    }
    this.track(s, ch.id)
    await this.ari.request('POST', `/channels/${ch.id}/ring`).catch(() => undefined)
    if (!s.queue.length) {
      // Nobody available: a short ring, then a missed call.
      s.ringTimer = setTimeout(() => void this.cut(s, 'no_agents'), 3_000)
      return
    }
    // Ring everyone, or one at a time (longest idle first) within the group's ring time.
    const strategy = res.strategy ?? 'RING_ALL'
    s.each = strategy === 'RING_ALL' ? s.ringSeconds : Math.max(10, Math.floor(s.ringSeconds / Math.max(1, Math.min(s.queue.length, 3))))
    const batch = strategy === 'RING_ALL' ? s.queue.splice(0) : s.queue.splice(0, 1)
    const total = Math.min(120, strategy === 'RING_ALL' ? s.ringSeconds : s.each * (batch.length + s.queue.length))
    s.ringTimer = setTimeout(() => void this.cut(s, 'ring_timeout'), total * 1000 + 1_000)
    await Promise.all(batch.map((t) => this.ringAgent(s, t, s.each)))
  }

  private async ringAgent(s: InSession, t: InboundTarget, seconds: number) {
    const legId = `vd-${randomUUID()}`
    s.legs.set(legId, t.sipUsername)
    this.byChannel.set(legId, s.callId)
    try {
      await this.ari.request('POST', '/channels/create', {
        endpoint: `PJSIP/${t.sipUsername}`, app: 'voicedrive', appArgs: `agentleg,${s.callId},${t.sipUsername}`, channelId: legId, originator: s.caller,
      }, { variables: { 'PJSIP_HEADER(add,X-VD-Call-Id)': s.callId, 'CALLERID(num)': s.from, 'CALLERID(name)': s.from } })
      await this.ari.request('POST', `/channels/${legId}/dial`, { caller: s.caller, timeout: seconds })
    } catch (error) {
      log('warn', 'could not ring an agent', { callId: s.callId, sip: t.sipUsername, error: (error as Error).message })
      s.legs.delete(legId)
      this.byChannel.delete(legId)
      await this.nextOrMiss(s)
    }
  }

  // ----------------------------------------------------------------- answer
  private async onState(ch: AriChannel) {
    if (ch.state !== 'Up') return
    const s = this.session(ch.id)
    if (!s || s.ended) return
    if (s.kind === 'out' && ch.id === s.dialed && s.answeredAt === undefined) {
      s.answeredAt = this.now()
      await this.ari.request('POST', `/channels/${s.agent}/answer`).catch(() => undefined)
      await this.bridge(s, [s.agent, ch.id])
      void this.api.answered(s.callId).catch((error) => log('warn', 'answered not delivered', { callId: s.callId, error: (error as Error).message }))
      this.armMax(s, s.maxSeconds)
    } else if (s.kind === 'in' && s.legs.has(ch.id) && !s.winner) {
      s.winner = ch.id
      s.answeredAt = this.now()
      if (s.ringTimer) clearTimeout(s.ringTimer)
      for (const leg of s.legs.keys()) if (leg !== ch.id) await this.hangup(leg, 'answered_elsewhere')
      await this.ari.request('POST', `/channels/${s.caller}/answer`)
      await this.bridge(s, [s.caller, ch.id])
      void this.api.answered(s.callId, s.legs.get(ch.id)).catch((error) => log('warn', 'answered not delivered', { callId: s.callId, error: (error as Error).message }))
      this.armMax(s, s.maxSeconds)
    }
  }

  private async onDial(e: AriEvent) {
    const peer = e.peer?.id
    if (!peer || !e.dialstatus) return
    const s = this.session(peer)
    if (!s || s.ended) return
    const fail = DIAL_FAIL[e.dialstatus]
    if (!fail) return
    if (s.kind === 'out' && peer === s.dialed) {
      s.failure = fail
      s.cause = e.dialstatus
      await this.hangup(s.agent, fail === 'BUSY' ? 'busy' : fail === 'NO_ANSWER' ? 'no_answer' : 'congestion')
    }
  }

  // --------------------------------------------------------------- hang-ups
  private async onGone(channelId: string, cause?: number, causeTxt?: string) {
    const s = this.session(channelId)
    this.byChannel.delete(channelId)
    if (!s || s.ended) return
    if (s.kind === 'out') {
      if (channelId === s.dialed && s.answeredAt === undefined && !s.failure && cause !== undefined) s.failure = CAUSE_FAIL[cause] ?? 'FAILED'
      if (channelId === s.agent && s.answeredAt === undefined && !s.failure) s.failure = 'CANCELLED'
      if (cause !== undefined) s.cause = s.cause ?? causeTxt ?? String(cause)
      await this.finish(s)
      return
    }
    if (channelId === s.caller || channelId === s.winner) {
      if (cause !== undefined) s.cause = s.cause ?? causeTxt ?? String(cause)
      await this.finish(s)
      return
    }
    if (s.legs.delete(channelId) && !s.winner && s.legs.size === 0) await this.nextOrMiss(s)
  }

  private async nextOrMiss(s: InSession) {
    if (s.ended || s.winner || s.legs.size > 0) return
    const next = s.queue.shift()
    if (next) return this.ringAgent(s, next, s.each)
    await this.cut(s, 'no_answer')
  }

  /** Ends a call on purpose (time limit, no agents, ring timeout). */
  private async cut(s: Session, why: string) {
    if (s.ended) return
    s.cause = s.cause ?? why
    if (s.kind === 'in' && !s.winner) s.failure = 'NO_ANSWER'
    await this.finish(s)
  }

  private armMax(s: Session, seconds: number) {
    if (s.maxTimer) clearTimeout(s.maxTimer)
    s.maxTimer = setTimeout(() => void this.cut(s, 'max_seconds'), seconds * 1000)
  }

  private async finish(s: Session) {
    if (s.ended) return
    s.ended = true
    const endedAt = this.now()
    if (s.maxTimer) clearTimeout(s.maxTimer)
    if (s.kind === 'in' && s.ringTimer) clearTimeout(s.ringTimer)
    const channels = s.kind === 'out' ? [s.agent, s.dialed] : [s.caller, ...s.legs.keys()]
    for (const id of channels) if (id) await this.hangup(id, 'normal')
    if (s.bridgeId) await this.ari.request('DELETE', `/bridges/${s.bridgeId}`).catch(() => undefined)
    const answered = s.answeredAt !== undefined
    const billsec = answered ? Math.max(0, (endedAt - s.answeredAt!) / 1000) : 0
    const status: Status = answered ? 'COMPLETED' : s.failure ?? (s.kind === 'in' ? 'NO_ANSWER' : 'FAILED')
    this.sessions.delete(s.callId)
    for (const [ch, id] of this.byChannel) if (id === s.callId) this.byChannel.delete(ch)
    log('info', 'call ended', { callId: s.callId, kind: s.kind, status, billsec: Math.round(billsec * 10) / 10, cause: s.cause })
    await this.api.ended({ callId: s.callId, status, billsec: Math.round(billsec * 1000) / 1000, hangupCause: s.cause ?? null, answered })
  }

  // ---------------------------------------------------------------- helpers
  private track(s: Session, channelId: string) {
    this.sessions.set(s.callId, s)
    this.byChannel.set(channelId, s.callId)
  }

  private session(channelId: string): Session | undefined {
    const id = this.byChannel.get(channelId)
    return id ? this.sessions.get(id) : undefined
  }

  private async bridge(s: Session, channels: string[]) {
    const id = `vdb-${s.callId}`
    await this.ari.request('POST', '/bridges', { type: 'mixing', bridgeId: id, name: id })
    await this.ari.request('POST', `/bridges/${id}/addChannel`, { channel: channels.join(',') })
    s.bridgeId = id
  }

  private async hangup(channelId: string, reason: string) {
    await this.ari.request('DELETE', `/channels/${channelId}`, { reason }).catch(() => undefined)
  }
}
