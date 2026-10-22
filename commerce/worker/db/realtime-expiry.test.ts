// Live-update sockets cannot be held forever (security audit run 5): a socket that never joins is
// closed after 30 s, a visitor's (no sign-in) after 30 minutes, and signed-in staff stay.
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
})
