// The Cloudflare database: one SQLite-backed Durable Object. Every request runs to
// completion before the next starts, and each write runs in a transaction, so stock
// and money updates never interleave. The Worker verifies who is calling and passes
// that identity along; nothing here trusts the browser for it.
import { DurableObject } from 'cloudflare:workers'
import { Context, type Identity } from './context.ts'
import { migrate } from './migrate.ts'
import { errorResponse, handleRest, type RestRequest, type RestResponse } from './rest/index.ts'
import { durableSql, type Sql } from './sql.ts'
import { authAdmin, type AuthAdminRequest } from './users.ts'

/** What the Worker knows about the caller after checking the token. */
export interface Caller {
  role: Identity['role']
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
    if (caller.role === 'authenticated' && caller.clerkUserId) {
      const u = this.sql.all('SELECT id, banned_until FROM users WHERE clerk_user_id = ?', [caller.clerkUserId])[0]
      if (u && !(u.banned_until && String(u.banned_until) > new Date().toISOString())) uid = String(u.id)
    }
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

  async rest(req: RestRequest, caller: Caller): Promise<RestResponse> {
    try {
      return handleRest(this.sql, new Context(this.sql, this.identity(caller)), req)
    } catch (e) {
      return errorResponse(e)
    }
  }

  /** Sign-in accounts (the Supabase Auth admin API the server code uses). Service callers only. */
  async auth(req: AuthAdminRequest, caller: Caller): Promise<RestResponse> {
    if (caller.role !== 'service_role') return { status: 403, headers: {}, body: JSON.stringify({ code: 'not_admin', msg: 'User not allowed' }) }
    return authAdmin(this.sql, req)
  }
}
