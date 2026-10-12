// Sign-in accounts (what Supabase Auth's auth.users held), served with the Supabase
// Auth admin API the server code already uses (getUserById, createUser,
// updateUserById, deleteUser, listUsers, inviteUserByEmail). Passwords and e-mail
// sending live in Clerk now; an account here is linked to its Clerk user by
// clerk_user_id, and the account id stays the same uuid.
import { toTimestamp } from './codec.ts'
import type { RestResponse } from './rest/index.ts'
import type { Row, Sql } from './sql.ts'

export interface AuthAdminRequest {
  method: string
  /** After /auth/v1/: "admin/users", "admin/users/<id>", "invite", … */
  path: string
  search: string
  body?: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Json = Record<string, unknown>

const reply = (status: number, body: unknown): RestResponse => ({
  status, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
const fail = (status: number, code: string, msg: string) => reply(status, { code, error_code: code, msg, message: msg })

export function userJson(r: Row): Json {
  return {
    id: r.id,
    aud: 'authenticated',
    role: 'authenticated',
    email: r.email ?? '',
    phone: r.phone ?? '',
    email_confirmed_at: r.email_confirmed_at ?? null,
    confirmed_at: r.email_confirmed_at ?? null,
    banned_until: r.banned_until ?? null,
    last_sign_in_at: r.last_sign_in_at ?? null,
    app_metadata: JSON.parse(String(r.app_metadata ?? '{}')),
    user_metadata: JSON.parse(String(r.user_metadata ?? '{}')),
    identities: [],
    is_anonymous: false,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

/** GoTrue's ban_duration: "876000h", "24h30m", "none". */
function bannedUntil(duration: unknown, now = Date.now()): string | null {
  if (duration === 'none' || duration === null || duration === undefined) return null
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(String(duration))
  if (!m || !(m[1] || m[2] || m[3])) throw new Error('invalid ban_duration')
  const ms = ((Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 + Number(m[3] ?? 0)) * 1000
  return new Date(Math.min(now + ms, Date.UTC(9999, 0, 1))).toISOString()
}

/** GoTrue merges metadata updates; a key set to null is removed. */
function mergeMeta(current: unknown, patch: unknown): string {
  const out = { ...(JSON.parse(String(current ?? '{}')) as Json) }
  for (const [k, v] of Object.entries((patch ?? {}) as Json)) {
    if (v === null) delete out[k]
    else out[k] = v
  }
  return JSON.stringify(out)
}

const clerkIdOf = (appMetadata: string) => {
  const v = (JSON.parse(appMetadata) as Json).clerk_user_id
  return typeof v === 'string' && v ? v : null
}

function byId(sql: Sql, id: string): Row | undefined {
  return UUID.test(id) ? sql.all('SELECT * FROM users WHERE id = ?', [id.toLowerCase()])[0] : undefined
}

function create(sql: Sql, body: Json, confirmDefault: boolean): RestResponse {
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : null
  if (email && sql.all('SELECT 1 FROM users WHERE email = ?', [email]).length) {
    return fail(422, 'email_exists', 'A user with this email address has already been registered')
  }
  const now = new Date().toISOString()
  const id = typeof body.id === 'string' && UUID.test(body.id) ? body.id.toLowerCase() : crypto.randomUUID()
  const app = mergeMeta('{"provider":"email","providers":["email"]}', body.app_metadata)
  const user = mergeMeta('{}', body.user_metadata ?? body.data)
  const confirmed = body.email_confirm === true || (confirmDefault && body.email_confirm !== false)
  let banned: string | null
  try {
    banned = bannedUntil(body.ban_duration)
  } catch {
    return fail(400, 'validation_failed', 'invalid ban_duration')
  }
  sql.run(`INSERT INTO users (id, email, phone, clerk_user_id, user_metadata, app_metadata, email_confirmed_at, banned_until, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [id, email, typeof body.phone === 'string' ? body.phone : null, clerkIdOf(app), user, app, confirmed ? now : null, banned, now, now])
  return reply(200, userJson(byId(sql, id)!))
}

function updateUser(sql: Sql, id: string, body: Json): RestResponse {
  const row = byId(sql, id)
  if (!row) return fail(404, 'user_not_found', 'User not found')
  const now = new Date().toISOString()
  const sets: string[] = []
  const params: Array<string | null> = []
  const set = (col: string, v: string | null) => {
    sets.push(`${col} = ?`)
    params.push(v)
  }
  if (typeof body.email === 'string') {
    const email = body.email.trim().toLowerCase()
    if (sql.all('SELECT 1 FROM users WHERE email = ? AND id <> ?', [email, row.id as string]).length) {
      return fail(422, 'email_exists', 'A user with this email address has already been registered')
    }
    set('email', email)
  }
  if (typeof body.phone === 'string') set('phone', body.phone)
  if (body.email_confirm === true) set('email_confirmed_at', (row.email_confirmed_at as string | null) ?? now)
  if (body.user_metadata !== undefined) set('user_metadata', mergeMeta(row.user_metadata, body.user_metadata))
  if (body.app_metadata !== undefined) {
    const app = mergeMeta(row.app_metadata, body.app_metadata)
    set('app_metadata', app)
    set('clerk_user_id', clerkIdOf(app))
  }
  if (body.ban_duration !== undefined) {
    try {
      set('banned_until', bannedUntil(body.ban_duration))
    } catch {
      return fail(400, 'validation_failed', 'invalid ban_duration')
    }
  }
  set('updated_at', now)
  sql.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, [...params, row.id as string])
  return reply(200, userJson(byId(sql, row.id as string)!))
}

export function authAdmin(sql: Sql, req: AuthAdminRequest): RestResponse {
  try {
    const method = req.method.toUpperCase()
    const body = (req.body ? JSON.parse(req.body) : {}) as Json
    const path = req.path.replace(/^\/+|\/+$/g, '')
    if (path === 'admin/users' && method === 'GET') {
      const qs = new URLSearchParams(req.search)
      const perPage = Math.min(Math.max(Number(qs.get('per_page') ?? 50) || 50, 1), 1000)
      const page = Math.max(Number(qs.get('page') ?? 1) || 1, 1)
      const rows = sql.all('SELECT * FROM users ORDER BY created_at, id LIMIT ? OFFSET ?', [perPage, (page - 1) * perPage])
      const total = Number(sql.all('SELECT count(*) AS n FROM users')[0].n)
      return { ...reply(200, { users: rows.map(userJson), aud: 'authenticated' }), headers: { 'Content-Type': 'application/json', 'X-Total-Count': String(total) } }
    }
    if (path === 'admin/users' && method === 'POST') return sql.transaction(() => create(sql, body, false))
    if (path === 'invite' && method === 'POST') return sql.transaction(() => create(sql, body, false))
    const m = /^admin\/users\/([^/]+)$/.exec(path)
    if (m) {
      const id = decodeURIComponent(m[1])
      if (method === 'GET') {
        const row = byId(sql, id)
        return row ? reply(200, userJson(row)) : fail(404, 'user_not_found', 'User not found')
      }
      if (method === 'PUT') return sql.transaction(() => updateUser(sql, id, body))
      if (method === 'DELETE') {
        const row = byId(sql, id)
        if (!row) return fail(404, 'user_not_found', 'User not found')
        sql.transaction(() => sql.run('DELETE FROM users WHERE id = ?', [row.id as string]))
        return reply(200, {})
      }
    }
    if (path === 'admin/generate_link') {
      return fail(400, 'not_supported', 'Sign-in links are sent by Clerk now')
    }
    return fail(404, 'not_found', 'Not found')
  } catch (e) {
    return fail(500, 'unexpected_failure', e instanceof Error ? e.message : 'failed')
  }
}

/** Marks a sign-in on the account (shown as last sign-in in the team list). */
export function touchSignIn(sql: Sql, id: string): void {
  sql.run('UPDATE users SET last_sign_in_at = ? WHERE id = ?', [toTimestamp(new Date()), id])
}
