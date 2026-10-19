// Who a database request runs as: the account behind a verified token, unless it is
// blocked or its session was signed out.
import type { Identity } from './context.ts'
import type { Sql } from './sql.ts'

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

/** The caller's identity; a blocked account, or a token of a signed-out session, reaches no account. */
export function identityFor(sql: Sql, caller: Caller): Identity {
  let uid: string | null = null
  if (caller.role === 'authenticated' && (caller.userId || caller.clerkUserId)) {
    const u = caller.userId
      ? sql.all('SELECT id, banned_until FROM users WHERE id = ?', [caller.userId])[0]
      : sql.all('SELECT id, banned_until FROM users WHERE clerk_user_id = ?', [caller.clerkUserId!])[0]
    if (u && !(u.banned_until && String(u.banned_until) > new Date().toISOString())) uid = String(u.id)
  }
  if (uid && caller.sessionId) {
    // A signed-out session is over: its access token no longer reaches any data, even before it expires.
    if (sessionEnded(sql, caller.sessionId)) uid = null
    else recordSession(sql, caller.sessionId, uid)
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

export function sessionEnded(sql: Sql, id: string): boolean {
  return sql.all('SELECT 1 FROM _ended_sessions WHERE id = ? LIMIT 1', [id]).length > 0
}

/**
 * auth.sessions: a session is recorded the first time it is seen (its start is what staff
 * session limits measure). One that was signed out stays out: it is not recorded again, so
 * platform checks keep refusing it, as Supabase does after a sign-out.
 */
function recordSession(sql: Sql, id: string, uid: string): void {
  if (sql.all('SELECT 1 FROM sessions WHERE id = ? UNION ALL SELECT 1 FROM _ended_sessions WHERE id = ? LIMIT 1', [id, id]).length) return
  sql.run('INSERT OR IGNORE INTO sessions (id, user_id) VALUES (?, ?)', [id, uid])
}
