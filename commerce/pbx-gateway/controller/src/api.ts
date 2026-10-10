// Calls the VoiceDrive edge function as the gateway (Bearer token).
import { log } from './log.ts'

export interface OutboundStart { allow: boolean; reason?: string; callId?: string; trunk?: string; dial?: string; callerId?: string; maxSeconds?: number }
export interface InboundTarget { agentId: string; sipUsername: string; extension: string }
export interface InboundStart {
  allow: boolean; reason?: string; callId?: string; targets?: InboundTarget[]
  strategy?: 'RING_ALL' | 'LONGEST_IDLE'; ringSeconds?: number; maxSeconds?: number
}
export interface Trunk {
  businessId: string; code: number; did: string; callerId: string; host: string; port: number
  transport: 'udp' | 'tcp' | 'tls'; user: string | null; password: string; register: boolean; dialFormat: string; enabled: boolean
}
export interface Ended { callId: string; status: string; billsec: number; hangupCause?: string | null; answered: boolean }

export interface VoiceDriveApi {
  ping(version: string, detail: Record<string, unknown>): Promise<unknown>
  trunks(): Promise<Trunk[]>
  outboundStart(sipUsername: string, dialed: string, callId: string | null, gatewayCallId: string): Promise<OutboundStart>
  inboundStart(did: string, from: string, gatewayCallId: string, businessCode: number | null): Promise<InboundStart>
  answered(callId: string, sipUsername?: string | null): Promise<unknown>
  ended(e: Ended): Promise<unknown>
}

export class HttpApi implements VoiceDriveApi {
  private readonly pending: Array<{ e: Ended; tries: number; at: number }> = []
  private readonly url: string
  private readonly token: string

  constructor(url: string, token: string) {
    this.url = url
    this.token = token
    setInterval(() => void this.flush(), 5_000).unref?.()
  }

  private async post<T>(body: Record<string, unknown>, timeoutMs = 8_000): Promise<T> {
    const res = await fetch(this.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`VoiceDrive API ${body.action} answered ${res.status}: ${text.slice(0, 200)}`)
    return JSON.parse(text) as T
  }

  ping(version: string, detail: Record<string, unknown>) { return this.post({ action: 'gw_ping', version, detail }) }
  async trunks() { return (await this.post<{ trunks: Trunk[] }>({ action: 'gw_trunks' })).trunks }
  outboundStart(sipUsername: string, dialed: string, callId: string | null, gatewayCallId: string) {
    return this.post<OutboundStart>({ action: 'gw_outbound_start', sipUsername, dialed, callId, gatewayCallId })
  }
  inboundStart(did: string, from: string, gatewayCallId: string, businessCode: number | null) {
    return this.post<InboundStart>({ action: 'gw_inbound_start', did, from, gatewayCallId, businessCode })
  }
  answered(callId: string, sipUsername?: string | null) { return this.post({ action: 'gw_answered', callId, sipUsername: sipUsername ?? null }) }

  /** The end of a call is what billing uses: retried until the API takes it. */
  async ended(e: Ended): Promise<unknown> {
    try {
      return await this.post({ action: 'gw_ended', ...e })
    } catch (error) {
      log('warn', 'call end not delivered, will retry', { callId: e.callId, error: (error as Error).message })
      this.pending.push({ e, tries: 1, at: Date.now() + 5_000 })
      return null
    }
  }

  private async flush() {
    const now = Date.now()
    for (const item of [...this.pending]) {
      if (item.at > now) continue
      try {
        await this.post({ action: 'gw_ended', ...item.e })
        this.pending.splice(this.pending.indexOf(item), 1)
        log('info', 'call end delivered after retry', { callId: item.e.callId, tries: item.tries + 1 })
      } catch (error) {
        item.tries++
        item.at = now + Math.min(300_000, 5_000 * 2 ** item.tries)
        if (item.tries > 20) {
          this.pending.splice(this.pending.indexOf(item), 1)
          log('error', 'giving up on a call end; the sweep will close it without a charge', { callId: item.e.callId, error: (error as Error).message })
        }
      }
    }
  }
}
