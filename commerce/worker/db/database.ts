// The Cloudflare database: one SQLite-backed Durable Object. Every request runs to
// completion before the next starts, and each write runs in a transaction, so stock
// and money updates never interleave. The Worker verifies who is calling and passes
// that identity along; nothing here trusts the browser for it.
import { DurableObject } from 'cloudflare:workers'
import * as sessions from './auth.ts'
import { loadStatements, type Summary, targetSummary } from './export.ts'
import * as live from './realtime.ts'
import { socketOwner } from './realtime.ts'
import type { SocketState } from './realtime.ts'
import { authSecret, type TokenEnv, verifyAccessToken } from './tokens.ts'
import { Context, type Identity } from './context.ts'
import { type Caller, identityFor, sessionEnded } from './identity.ts'
import { migrate } from './migrate.ts'
import { errorResponse, handleRest, type RestRequest, type RestResponse } from './rest/index.ts'
import { durableSql, type Sql } from './sql.ts'
import { authAdmin, type AuthAdminRequest } from './users.ts'

export type { Caller }

const MAX_SOCKETS = 5000

export class Database extends DurableObject {
  protected readonly sql: Sql

  constructor(state: DurableObjectState, env: unknown) {
    super(state, env as never)
    this.sql = durableSql(state.storage)
    void state.blockConcurrencyWhile(async () => {
      try {
        migrate(this.sql)
      } catch (e) {
        console.error('database migration failed', e instanceof Error ? e.message : e, (e as { details?: unknown }).details ?? '')
        throw e
      }
    })
  }

  /** The account linked to a Clerk user (blocked accounts get none). */
  private identity(caller: Caller): Identity {
    return identityFor(this.sql, caller)
  }

  async rest(req: RestRequest, caller: Caller): Promise<RestResponse> {
    try {
      const ctx = new Context(this.sql, this.identity(caller))
      const res = handleRest(this.sql, ctx, req)
      // Saved: tell live-update subscribers about the rows they may read.
      if (res.status < 400 && ctx.changes.length) this.broadcast(ctx.changes)
      return res
    } catch (e) {
      return errorResponse(e)
    }
  }

  // --- The switch-over copy from Supabase (worker/copy.ts) ---------------------------

  private copying: { token: string; at: number } | null = null

  private isLive(): boolean {
    return (this.env as { DATABASE_BACKEND?: string }).DATABASE_BACKEND === 'cloudflare'
  }

  /** Claims a copy run; false when this database is live, or the run is done or under way. */
  async copyBegin(token: string): Promise<boolean> {
    if (this.isLive()) return false
    if (this.copying && Date.now() - this.copying.at < 15 * 60_000) return false
    if (this.sql.all('SELECT 1 FROM _copy_runs WHERE token = ?', [token]).length) return false
    this.copying = { token, at: Date.now() }
    this.sql.run('INSERT INTO _copy_runs (token, started_at) VALUES (?, ?)', [token, new Date().toISOString()])
    return true
  }

  /** Replaces this database with the copied rows (one transaction) and returns its summary. Never once live. */
  async copyLoad(statements: string[]): Promise<Summary> {
    if (this.isLive() || !this.copying) throw new Error('No copy is under way, or the Cloudflare database is already live')
    await this.ctx.storage.deleteAll()
    migrate(this.sql)
    loadStatements(this.sql, statements)
    this.sql.run('INSERT OR IGNORE INTO _copy_runs (token, started_at) VALUES (?, ?)', [this.copying.token, new Date(this.copying.at).toISOString()])
    return targetSummary(this.sql, { vault: true })
  }

  async copyEnd(token: string, ok: boolean, issues: string[]): Promise<void> {
    this.sql.run(`INSERT INTO _copy_runs (token, started_at, finished_at, ok, issues) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT (token) DO UPDATE SET finished_at = excluded.finished_at, ok = excluded.ok, issues = excluded.issues`,
    [token, new Date().toISOString(), new Date().toISOString(), ok ? 1 : 0, JSON.stringify(issues)])
    if (this.copying?.token === token) this.copying = null
  }

  /** Live updates (realtime.ts): the WebSocket supabase-js opens at /realtime/v1/websocket. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.endsWith('/realtime/v1/websocket') || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not found', { status: 404 })
    }
    // Bounded: a few sockets per visitor and a ceiling for the whole database, so nobody can
    // hold open enough connections to crowd out everyone else.
    const owner = socketOwner(request.headers.get('cf-connecting-ip'))
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response('Too many live connections', { status: 503 })
    if (this.ctx.getWebSockets(`ip:${owner.key}`).length >= owner.max) return new Response('Too many live connections', { status: 429 })
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server, [`ip:${owner.key}`])
    const state: SocketState = { vsn: url.searchParams.get('vsn') ?? '1.0.0', uid: null, sid: null, exp: 0, subs: [], next: 0 }
    server.serializeAttachment(state)
    return new Response(null, { status: 101, webSocket: client })
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return
    const state = ws.deserializeAttachment() as SocketState
    const m = live.decode(message, state.vsn)
    if (!m) return
    const replies = await live.handle(state, m, (token) => this.verifyLiveToken(token))
    ws.serializeAttachment(state)
    for (const r of replies) ws.send(live.encode(r, state.vsn))
  }

  /** A session access token (tokens.ts) of an account that is not blocked; null otherwise. */
  private async verifyLiveToken(token: string): Promise<{ uid: string; sid: string; exp: number } | null> {
    const secret = authSecret(this.env as TokenEnv)
    const claims = secret ? await verifyAccessToken(secret, token) : null
    if (!claims || claims === 'expired') return null
    const u = this.sql.all('SELECT banned_until FROM users WHERE id = ?', [claims.sub])[0]
    if (!u || (u.banned_until && String(u.banned_until) > new Date().toISOString())) return null
    if (claims.session_id && sessionEnded(this.sql, claims.session_id)) return null
    return { uid: claims.sub, sid: claims.session_id, exp: claims.exp }
  }

  private broadcast(changes: live.Change[]): void {
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment() as SocketState | null
      if (!state?.subs.length) continue
      for (const m of live.deliveries(state, changes, (st, table, search) => this.readAs(st, table, search))) {
        try {
          ws.send(live.encode(m, state.vsn))
        } catch {
          // closed meanwhile
        }
      }
    }
  }

  /** A row as a live-update subscriber may read it (row security applies), or null. */
  private readAs(state: SocketState, table: string, search: string): Record<string, unknown> | null {
    const identity = this.identity(state.uid ? { role: 'authenticated', userId: state.uid, sessionId: state.sid } : { role: 'anon' })
    if (state.uid && !identity.uid) return null
    const res = handleRest(this.sql, new Context(this.sql, identity), { method: 'GET', path: table, search, headers: {}, body: null })
    if (res.status !== 200 || !res.body) return null
    return (JSON.parse(res.body) as Array<Record<string, unknown>>)[0] ?? null
  }

  /** Sign-in accounts (the Supabase Auth admin API the server code uses). Service callers only. */
  async auth(req: AuthAdminRequest, caller: Caller, site = ''): Promise<RestResponse> {
    if (caller.role !== 'service_role') return { status: 403, headers: {}, body: JSON.stringify({ code: 'not_admin', msg: 'User not allowed' }) }
    if (req.path.replace(/^\/+|\/+$/g, '') === 'admin/generate_link' && req.method.toUpperCase() === 'POST') {
      return sessions.generateLink(this.sql, (req.body ? JSON.parse(req.body) : {}) as Record<string, unknown>, site)
    }
    return authAdmin(this.sql, req)
  }

  /** Sign-in sessions for the pages (worker/db/auth.ts); the Worker signs the access tokens. */
  async verifyLink(body: Record<string, unknown>): Promise<sessions.Grant | RestResponse> {
    return sessions.verify(this.sql, body)
  }

  async refreshSession(body: Record<string, unknown>): Promise<sessions.Grant | RestResponse> {
    return sessions.refresh(this.sql, body)
  }

  async currentUser(uid: string, sessionId: string | null): Promise<RestResponse> {
    return sessions.currentUser(this.sql, uid, sessionId)
  }

  async updateCurrentUser(uid: string, sessionId: string | null, body: Record<string, unknown>): Promise<RestResponse> {
    return this.sql.transaction(() => sessions.updateCurrentUser(this.sql, uid, sessionId, body))
  }

  async logout(uid: string, sessionId: string | null, scope: string): Promise<RestResponse> {
    return sessions.logout(this.sql, uid, sessionId, scope)
  }
}
