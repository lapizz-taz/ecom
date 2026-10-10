// A small Asterisk REST Interface client: REST calls plus the event WebSocket.
import { log } from './log.ts'

export interface AriChannel {
  id: string
  name: string
  state: string
  caller: { number: string; name: string }
  dialplan?: { exten: string; context: string }
}
export type AriEvent = { type: string; channel?: AriChannel; args?: string[]; cause?: number; cause_txt?: string; peer?: AriChannel; dialstatus?: string; [k: string]: unknown }

export interface Ari {
  request<T = unknown>(method: string, path: string, query?: Record<string, string | number | undefined>, body?: unknown): Promise<T>
}

export class AriClient implements Ari {
  private readonly base: string
  private readonly auth: string
  private readonly user: string
  private readonly password: string

  constructor(base: string, user: string, password: string) {
    this.base = base
    this.user = user
    this.password = password
    this.auth = `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`
  }

  async request<T = unknown>(method: string, path: string, query: Record<string, string | number | undefined> = {}, body?: unknown): Promise<T> {
    const url = new URL(this.base + path)
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v))
    const res = await fetch(url, {
      method,
      headers: { Authorization: this.auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`ARI ${method} ${path} → ${res.status} ${text.slice(0, 200)}`)
    return (text ? JSON.parse(text) : null) as T
  }

  /** Connects the event socket and reconnects on loss. */
  listen(app: string, onEvent: (e: AriEvent) => void, onOpen?: () => void): void {
    const wsUrl = this.base.replace(/^http/, 'ws') + `/events?app=${encodeURIComponent(app)}&subscribeAll=false&api_key=${encodeURIComponent(`${this.user}:${this.password}`)}`
    let delay = 1_000
    const connect = () => {
      const ws = new WebSocket(wsUrl)
      ws.onopen = () => { delay = 1_000; log('info', 'ARI events connected'); onOpen?.() }
      ws.onmessage = (m) => {
        try { onEvent(JSON.parse(String(m.data)) as AriEvent) } catch (error) { log('error', 'bad ARI event', { error: (error as Error).message }) }
      }
      ws.onclose = () => {
        log('warn', 'ARI events disconnected, reconnecting', { inMs: delay })
        setTimeout(connect, delay)
        delay = Math.min(delay * 2, 30_000)
      }
      ws.onerror = () => { /* onclose follows */ }
    }
    connect()
  }
}
