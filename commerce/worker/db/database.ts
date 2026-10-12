// The Cloudflare database: one SQLite-backed Durable Object. Every request runs to
// completion before the next starts, and each write runs in a transaction, so stock
// and money updates never interleave. The Worker verifies who is calling and passes
// that identity along; nothing here trusts the browser for it.
import { DurableObject } from 'cloudflare:workers'
import * as sessions from './auth.ts'
import * as live from './realtime.ts'
import type { SocketState } from './realtime.ts'
import { authSecret, type TokenEnv, verifyAccessToken } from './tokens.ts'
import { Context, type Identity } from './context.ts'
import { migrate } from './migrate.ts'
import { errorResponse, handleRest, type RestRequest, type RestResponse } from './rest/index.ts'
import { durableSql, type Sql } from './sql.ts'
import { authAdmin, type AuthAdminRequest } from './users.ts'

/** What the Worker knows about the caller after checking the token. */
export interface Caller {
  role: Identity['role']
  /** Account id of a verified access token of a session opened here (worker/db/auth.ts). */
  userId?: string | null
  /** Clerk user id (user_…) of a verified Clerk session token. */
  clerkUserId?: string | null
  sessionId?: string | null
  email?: string | null
  merchantHeader?: string | null
  userAgent?: string | null
  ip?: string | null
}

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
    let uid: string | null = null
    if (caller.role === 'authenticated' && (caller.userId || caller.clerkUserId)) {
      const u = caller.userId
        ? this.sql.all('SELECT id, banned_until FROM users WHERE id = ?', [caller.userId])[0]
        : this.sql.all('SELECT id, banned_until FROM users WHERE clerk_user_id = ?', [caller.clerkUserId!])[0]
      if (u && !(u.banned_until && String(u.banned_until) > new Date().toISOString())) uid = String(u.id)
    }
    if (uid && caller.sessionId) this.recordSession(caller.sessionId, uid)
    return {
      role: caller.role,
      uid,
      sessionId: caller.sessionId ?? null,
      email: caller.email ?? null,
      merchantHeader: caller.merchantHeader ?? null,
      userAgent: caller.userAgent ?? null,
      ip: caller.ip ?? null,
    }
  }

  /**
   * auth.sessions: a session is recorded the first time it is seen (its start is what staff
   * session limits measure). One that was signed out stays out: it is not recorded again, so
   * platform checks keep refusing it, as Supabase does after a sign-out.
   */
  private recordSession(id: string, uid: string): void {
    if (this.sql.all('SELECT 1 FROM sessions WHERE id = ? UNION ALL SELECT 1 FROM _ended_sessions WHERE id = ? LIMIT 1', [id, id]).length) return
    this.sql.run('INSERT OR IGNORE INTO sessions (id, user_id) VALUES (?, ?)', [id, uid])
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

  /** Live updates (realtime.ts): the WebSocket supabase-js opens at /realtime/v1/websocket. */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (!url.pathname.endsWith('/realtime/v1/websocket') || request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Not found', { status: 404 })
    }
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    this.ctx.acceptWebSocket(server)
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
