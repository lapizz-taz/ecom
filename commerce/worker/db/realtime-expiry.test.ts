// Live-update sockets cannot be held forever (security audit run 5): a socket that never joins is
// closed after 30 s, a visitor's (no sign-in) after 30 minutes. Signed-in staff stay while their
// token is good (security audit run 6): closed 5 minutes after it expires, when the page sends a
// token that no longer verifies, and past 20 sockets for one account.
import { describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ DurableObject: class { ctx: unknown; env: unknown; constructor(s: unknown, e: unknown) { this.ctx = s; this.env = e } } }))

class FakeWs {
  att: unknown = null
  sent: string[] = []
  closed: string | null = null
  serializeAttachment(v: unknown) { this.att = JSON.parse(JSON.stringify(v)) }
  deserializeAttachment() { return this.att }
  send(s: string) { this.sent.push(s) }
  close(_code: number, reason: string) { this.closed = reason }
}

function fakeCtx() {
  const socks: Array<{ ws: FakeWs; tags: string[] }> = []
  let alarm: number | null = null
  return {
    socks,
    acceptWebSocket(ws: FakeWs, tags: string[]) { socks.push({ ws, tags }) },
    getWebSockets(tag?: string) { return socks.filter((s) => !s.ws.closed && (!tag || s.tags.includes(tag))).map((s) => s.ws) },
    storage: { getAlarm: async () => alarm, setAlarm: async (t: number) => { alarm = t } },
    get alarm() { return alarm },
  }
}

describe('live-update socket lifetime', () => {
  it('closes unjoined sockets after 30 s and visitors after 30 min; signed-in sockets stay', async () => {
    const { Database } = await import('./database.ts')
    const RealResponse = globalThis.Response
    const g = globalThis as Record<string, unknown>
    g.WebSocketPair = class { 0 = new FakeWs(); 1 = new FakeWs() }
    g.Response = class { status: number; constructor(_b: unknown, init?: { status?: number }) { this.status = init?.status ?? 200 } }
    const ctx = fakeCtx()
    const self = Object.assign(Object.create(Database.prototype), { ctx, env: {}, verifyLiveToken: async (t: string) => (t === 'staff' ? { uid: 'u1', sid: 's1', exp: 9e9 } : null) })
    const open = () => self.fetch(new Request('https://staging.example/realtime/v1/websocket?vsn=2.0.0', { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '192.0.2.1' } }))
    const t0 = 1_000_000
    vi.spyOn(Date, 'now').mockReturnValue(t0)
    for (let i = 0; i < 3; i++) await open()
    g.Response = RealResponse
    expect(ctx.alarm).toBe(t0 + 30_000)
    const [idle, visitor, staff] = ctx.socks.map((s) => s.ws)
    await self.webSocketMessage(visitor, JSON.stringify(['1', '1', 'realtime:x', 'phx_join', { config: { postgres_changes: [] } }]))
    await self.webSocketMessage(staff, JSON.stringify(['1', '1', 'realtime:y', 'phx_join', { access_token: 'staff', config: { postgres_changes: [] } }]))

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 31_000)
    await self.alarm()
    expect([idle.closed, visitor.closed, staff.closed]).toEqual(['Live connection timed out', null, null])
    expect(ctx.alarm).toBe(t0 + 61_000)

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 31 * 60_000)
    await self.alarm()
    expect([visitor.closed, staff.closed]).toEqual(['Live connection timed out', null])
    vi.restoreAllMocks()
  })

  it('closes signed-in sockets after the token expires, on a bad token, and past 20 per account', async () => {
    const { Database } = await import('./database.ts')
    const RealResponse = globalThis.Response
    const g = globalThis as Record<string, unknown>
    g.WebSocketPair = class { 0 = new FakeWs(); 1 = new FakeWs() }
    const ctx = fakeCtx()
    const t0 = 2_000_000_000
    const tokens: Record<string, { uid: string; sid: string; exp: number }> = {
      short: { uid: 'u1', sid: 's1', exp: (t0 + 60_000) / 1000 },
      long: { uid: 'u2', sid: 's2', exp: (t0 + 3_600_000) / 1000 },
      many: { uid: 'u3', sid: 's3', exp: (t0 + 3_600_000) / 1000 },
    }
    const self = Object.assign(Object.create(Database.prototype), { ctx, env: {}, verifyLiveToken: async (t: string) => tokens[t] ?? null })
    let ip = 0
    const open = async () => {
      g.Response = class { status: number; constructor(_b: unknown, init?: { status?: number }) { this.status = init?.status ?? 200 } }
      await self.fetch(new Request('https://staging.example/realtime/v1/websocket?vsn=2.0.0', { headers: { Upgrade: 'websocket', 'cf-connecting-ip': `192.0.2.${++ip}` } }))
      g.Response = RealResponse
      return ctx.socks[ctx.socks.length - 1].ws
    }
    const join = (ws: FakeWs, token: string) => self.webSocketMessage(ws, JSON.stringify(['1', '1', 'realtime:y', 'phx_join', { access_token: token, config: { postgres_changes: [] } }]))
    vi.spyOn(Date, 'now').mockReturnValue(t0)

    const expiring = await open()
    const refreshed = await open()
    const signedOut = await open()
    await join(expiring, 'short')
    await join(refreshed, 'short')
    await join(signedOut, 'long')
    // The page refreshes its token on one socket; on another it signs out (a token that does not verify).
    await self.webSocketMessage(refreshed, JSON.stringify([null, '2', 'realtime:y', 'access_token', { access_token: 'long' }]))
    await self.webSocketMessage(signedOut, JSON.stringify([null, '2', 'realtime:y', 'access_token', { access_token: 'anon-key' }]))
    expect(signedOut.closed).toBe('Sign in again')

    vi.spyOn(Date, 'now').mockReturnValue(t0 + 60_000 + 4 * 60_000)
    await self.alarm()
    expect([expiring.closed, refreshed.closed]).toEqual([null, null]) // within the 5 minutes of grace
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 60_000 + 6 * 60_000)
    await self.alarm()
    expect([expiring.closed, refreshed.closed]).toEqual(['Live connection timed out', null])

    const socks: FakeWs[] = []
    for (let i = 0; i < 21; i++) {
      const ws = await open()
      await join(ws, 'many')
      socks.push(ws)
    }
    expect(socks.slice(0, 20).every((ws) => ws.closed === null)).toBe(true)
    expect(socks[20].closed).toBe('Too many live connections')
    vi.restoreAllMocks()
  })
})
