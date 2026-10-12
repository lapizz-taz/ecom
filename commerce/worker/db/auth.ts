// Sign-in sessions on the Cloudflare database: what Supabase Auth did for the pages,
// which keep using supabase-js. Its calls arrive here (through gateway.ts):
//
//   POST admin/generate_link   server only: a one-time sign-in token for an account
//                              (clerk-auth asks for one after checking the Clerk sign-in)
//   POST verify                that token → a session: an access token and a refresh token
//   POST token?grant_type=refresh_token   a new access token while the session exists
//   GET  user / PUT user       the signed-in account (PUT: its own profile details)
//   POST logout?scope=…        ends this session, every session of the person, or the others
//
// Sessions are rows of `sessions` (auth.sessions for the business functions: staff
// session limits and "sign staff out" delete them). Tokens are random and only their
// SHA-256 is stored. Access tokens are signed by the Worker (gateway.ts), not here.
import type { RestResponse } from './rest/index.ts'
import type { Row, Sql } from './sql.ts'
import { touchSignIn, userJson } from './users.ts'

type Json = Record<string, unknown>

/** A one-time sign-in token is good for an hour (Supabase's default), once. */
export const LINK_TTL_MS = 60 * 60_000
/** A refresh token already exchanged still works this long (two tabs refreshing at once). */
export const REFRESH_REUSE_MS = 10_000

export interface Grant {
  user: Json
  sessionId: string
  refreshToken: string
}

const reply = (status: number, body: unknown): RestResponse => ({
  status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
export const authError = (status: number, code: string, msg: string): RestResponse =>
  reply(status, { code: status, error_code: code, msg, message: msg })

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** 256 random bits as hex. */
export const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)))

export async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}

const now = () => new Date().toISOString()
const banned = (u: Row) => Boolean(u.banned_until && String(u.banned_until) > now())
const userById = (sql: Sql, id: string) => sql.all('SELECT * FROM users WHERE id = ?', [id])[0]

/** GoTrue's generate_link answer: the account's fields plus the link's (supabase-js splits them). */
export async function generateLink(sql: Sql, body: Json, site: string): Promise<RestResponse> {
  const type = String(body.type ?? '')
  if (type !== 'magiclink') return authError(400, 'validation_failed', 'Only sign-in links (magiclink) are made here')
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  const user = email ? sql.all('SELECT * FROM users WHERE email = ?', [email])[0] : undefined
  if (!user) return authError(404, 'user_not_found', 'User not found')
  if (banned(user)) return authError(403, 'user_banned', 'User is banned')
  const token = randomToken()
  const tokenHash = await sha256(token)
  sql.transaction(() => {
    sql.run('DELETE FROM _auth_link_tokens WHERE expires_at < ? OR used_at IS NOT NULL', [now()])
    sql.run('INSERT INTO _auth_link_tokens (token_hash, user_id, type, expires_at) VALUES (?, ?, ?, ?)',
      [tokenHash, user.id as string, type, new Date(Date.now() + LINK_TTL_MS).toISOString()])
  })
  return reply(200, {
    ...userJson(user),
    action_link: `${site.replace(/\/+$/, '')}/auth/v1/verify?token=${token}&type=${type}`,
    email_otp: '',
    hashed_token: token,
    redirect_to: typeof body.redirect_to === 'string' ? body.redirect_to : '',
    verification_type: type,
  })
}

function openSession(sql: Sql, user: Row, refreshHash: string): string {
  const sessionId = crypto.randomUUID()
  sql.run('INSERT INTO sessions (id, user_id) VALUES (?, ?)', [sessionId, user.id as string])
  sql.run('INSERT INTO _auth_refresh_tokens (token_hash, session_id, user_id) VALUES (?, ?, ?)', [refreshHash, sessionId, user.id as string])
  touchSignIn(sql, user.id as string)
  return sessionId
}

/** A one-time sign-in token (verifyOtp with token_hash) → a new session. */
export async function verify(sql: Sql, body: Json): Promise<Grant | RestResponse> {
  const token = typeof body.token_hash === 'string' ? body.token_hash : ''
  const type = String(body.type ?? '')
  if (!token || (type !== 'magiclink' && type !== 'email')) return authError(400, 'validation_failed', 'Verify requires a token_hash and type magiclink')
  const tokenHash = await sha256(token)
  const refreshToken = randomToken()
  const refreshHash = await sha256(refreshToken)
  return sql.transaction(() => {
    const link = sql.all('SELECT * FROM _auth_link_tokens WHERE token_hash = ?', [tokenHash])[0]
    if (!link || link.used_at || String(link.expires_at) < now()) return authError(403, 'otp_expired', 'Token has expired or is invalid')
    sql.run('UPDATE _auth_link_tokens SET used_at = ? WHERE token_hash = ?', [now(), tokenHash])
    const user = userById(sql, link.user_id as string)
    if (!user) return authError(403, 'otp_expired', 'Token has expired or is invalid')
    if (banned(user)) return authError(403, 'user_banned', 'User is banned')
    const sessionId = openSession(sql, user, refreshHash)
    return { user: userJson(userById(sql, user.id as string)!), sessionId, refreshToken }
  })
}

/** A refresh token → a new one for the same session, while the session and the account last. */
export async function refresh(sql: Sql, body: Json): Promise<Grant | RestResponse> {
  const presented = typeof body.refresh_token === 'string' ? body.refresh_token : ''
  if (!presented) return authError(400, 'validation_failed', 'refresh_token required')
  const presentedHash = await sha256(presented)
  const refreshToken = randomToken()
  const refreshHash = await sha256(refreshToken)
  return sql.transaction(() => {
    const row = sql.all('SELECT * FROM _auth_refresh_tokens WHERE token_hash = ?', [presentedHash])[0]
    if (!row) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
    const session = sql.all('SELECT * FROM sessions WHERE id = ?', [row.session_id as string])[0]
    if (!session) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
    if (row.revoked_at && Date.now() - new Date(String(row.revoked_at)).getTime() > REFRESH_REUSE_MS) {
      return authError(400, 'refresh_token_already_used', 'Invalid Refresh Token: Already Used')
    }
    const user = userById(sql, row.user_id as string)
    if (!user) return authError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found')
    if (banned(user)) return authError(403, 'user_banned', 'User is banned')
    if (!row.revoked_at) sql.run('UPDATE _auth_refresh_tokens SET revoked_at = ? WHERE token_hash = ?', [now(), presentedHash])
    sql.run('INSERT INTO _auth_refresh_tokens (token_hash, session_id, user_id) VALUES (?, ?, ?)', [refreshHash, session.id as string, user.id as string])
    sql.run('UPDATE sessions SET updated_at = ? WHERE id = ?', [now(), session.id as string])
    return { user: userJson(user), sessionId: session.id as string, refreshToken }
  })
}

/** The signed-in account; a session that was ended (signed out, "sign staff out") no longer counts. */
export function currentUser(sql: Sql, uid: string, sessionId: string | null): RestResponse {
  if (sessionId && !sql.all('SELECT 1 FROM sessions WHERE id = ?', [sessionId]).length) {
    return authError(403, 'session_not_found', 'Session from session_id claim in JWT does not exist')
  }
  const user = userById(sql, uid)
  if (!user) return authError(404, 'user_not_found', 'User from sub claim in JWT does not exist')
  if (banned(user)) return authError(403, 'user_banned', 'User is banned')
  return reply(200, userJson(user))
}

/** updateUser from the page: profile details only (e-mail and password are Clerk's). */
export function updateCurrentUser(sql: Sql, uid: string, sessionId: string | null, body: Json): RestResponse {
  const check = currentUser(sql, uid, sessionId)
  if (check.status !== 200) return check
  if (body.email !== undefined || body.password !== undefined || body.phone !== undefined) {
    return authError(422, 'not_supported', 'Change the e-mail address or password in your account settings (Clerk)')
  }
  if (body.data !== undefined) {
    const user = userById(sql, uid)!
    const merged = { ...(JSON.parse(String(user.user_metadata ?? '{}')) as Json) }
    for (const [k, v] of Object.entries((body.data ?? {}) as Json)) {
      if (v === null) delete merged[k]
      else merged[k] = v
    }
    sql.run('UPDATE users SET user_metadata = ?, updated_at = ? WHERE id = ?', [JSON.stringify(merged), now(), uid])
  }
  return reply(200, userJson(userById(sql, uid)!))
}

/** Ends sessions: this one (local), all of the person's (global), or all but this one (others). */
export function logout(sql: Sql, uid: string, sessionId: string | null, scope: string): RestResponse {
  sql.transaction(() => {
    if (scope === 'local') {
      if (sessionId) sql.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', [sessionId, uid])
    } else if (scope === 'others') {
      sql.run('DELETE FROM sessions WHERE user_id = ? AND id <> ?', [uid, sessionId ?? ''])
    } else {
      sql.run('DELETE FROM sessions WHERE user_id = ?', [uid])
    }
    sql.run('DELETE FROM _auth_refresh_tokens WHERE session_id NOT IN (SELECT id FROM sessions)')
  })
  return { status: 204, headers: {}, body: null }
}
