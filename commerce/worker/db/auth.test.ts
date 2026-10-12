import { beforeAll, describe, expect, it } from 'vitest'
import { currentUser, generateLink, type Grant, LINK_TTL_MS, logout, refresh, REFRESH_REUSE_MS, updateCurrentUser, verify } from './auth.ts'
import type { RestResponse } from './rest/index.ts'
import type { Sql } from './sql.ts'
import { freshDatabase } from './testing.ts'
import { authSecret, signAccessToken, verifyAccessToken } from './tokens.ts'
import { authAdmin } from './users.ts'

let sql: Sql
const SITE = 'https://fullfilio.com'
const isGrant = (r: Grant | RestResponse): r is Grant => 'sessionId' in r
const body = (r: RestResponse) => JSON.parse(r.body ?? '{}') as Record<string, unknown>

function account(email: string, extra: Record<string, unknown> = {}): string {
  const res = authAdmin(sql, { method: 'POST', path: 'admin/users', search: '', body: JSON.stringify({ email, email_confirm: true, app_metadata: { clerk_user_id: `user_${email.split('@')[0]}` }, ...extra }) })
  if (res.status !== 200) throw new Error(res.body ?? 'account not created')
  return String(body(res).id)
}

async function signIn(email: string): Promise<Grant> {
  const link = body(await generateLink(sql, { type: 'magiclink', email }, SITE))
  const g = await verify(sql, { type: 'magiclink', token_hash: link.hashed_token })
  if (!isGrant(g)) throw new Error(g.body ?? 'no grant')
  return g
}

beforeAll(() => { sql = freshDatabase() })

describe('sign-in sessions', () => {
  it('turns a one-time sign-in token into a session, once', async () => {
    const id = account('one@example.com')
    const link = body(await generateLink(sql, { type: 'magiclink', email: 'ONE@example.com' }, SITE))
    expect(link).toMatchObject({ id, email: 'one@example.com', verification_type: 'magiclink' })
    expect(String(link.action_link)).toMatch(/^https:\/\/fullfilio\.com\/auth\/v1\/verify\?token=[0-9a-f]{64}&type=magiclink$/)
    // only a fingerprint is stored
    expect(sql.all('SELECT count(*) AS n FROM _auth_link_tokens WHERE token_hash = ?', [link.hashed_token as string])[0].n).toBe(0)
    const g = await verify(sql, { type: 'magiclink', token_hash: link.hashed_token })
    expect(isGrant(g) && g.user).toMatchObject({ id, email: 'one@example.com' })
    expect(sql.all('SELECT user_id FROM sessions WHERE id = ?', [(g as Grant).sessionId])[0].user_id).toBe(id)
    const again = await verify(sql, { type: 'magiclink', token_hash: link.hashed_token })
    expect(isGrant(again)).toBe(false)
    expect(body(again as RestResponse)).toMatchObject({ error_code: 'otp_expired' })
    expect(body(await verify(sql, { type: 'magiclink', token_hash: 'f'.repeat(64) }) as RestResponse)).toMatchObject({ error_code: 'otp_expired' })
  })

  it('refuses expired links, unknown accounts, blocked accounts and other link types', async () => {
    account('two@example.com')
    const link = body(await generateLink(sql, { type: 'magiclink', email: 'two@example.com' }, SITE))
    sql.run('UPDATE _auth_link_tokens SET expires_at = ?', [new Date(Date.now() - 1000).toISOString()])
    expect(body(await verify(sql, { type: 'magiclink', token_hash: link.hashed_token }) as RestResponse)).toMatchObject({ error_code: 'otp_expired' })
    expect((await generateLink(sql, { type: 'magiclink', email: 'nobody@example.com' }, SITE)).status).toBe(404)
    expect((await generateLink(sql, { type: 'recovery', email: 'two@example.com' }, SITE)).status).toBe(400)
    account('banned@example.com', { ban_duration: '876000h' })
    expect((await generateLink(sql, { type: 'magiclink', email: 'banned@example.com' }, SITE)).status).toBe(403)
    expect(LINK_TTL_MS).toBe(3_600_000)
  })

  it('renews a session with its refresh token, and a used token only for a moment', async () => {
    account('three@example.com')
    const g = await signIn('three@example.com')
    const r1 = await refresh(sql, { refresh_token: g.refreshToken })
    expect(isGrant(r1) && r1.sessionId).toBe(g.sessionId)
    // two tabs refreshing at once: the old token still works briefly
    const r2 = await refresh(sql, { refresh_token: g.refreshToken })
    expect(isGrant(r2)).toBe(true)
    sql.run('UPDATE _auth_refresh_tokens SET revoked_at = ? WHERE revoked_at IS NOT NULL', [new Date(Date.now() - REFRESH_REUSE_MS - 1000).toISOString()])
    expect(body(await refresh(sql, { refresh_token: g.refreshToken }) as RestResponse)).toMatchObject({ error_code: 'refresh_token_already_used' })
    expect(isGrant(await refresh(sql, { refresh_token: (r2 as Grant).refreshToken }))).toBe(true)
    expect(body(await refresh(sql, { refresh_token: 'nope' }) as RestResponse)).toMatchObject({ error_code: 'refresh_token_not_found' })
  })

  it('ends sessions: this one, the others, or all; an ended session cannot be renewed or read', async () => {
    const id = account('four@example.com')
    const a = await signIn('four@example.com')
    const b = await signIn('four@example.com')
    const c = await signIn('four@example.com')
    expect(currentUser(sql, id, a.sessionId).status).toBe(200)
    logout(sql, id, a.sessionId, 'local')
    expect(body(currentUser(sql, id, a.sessionId))).toMatchObject({ error_code: 'session_not_found' })
    expect(body(await refresh(sql, { refresh_token: a.refreshToken }) as RestResponse)).toMatchObject({ error_code: 'refresh_token_not_found' })
    logout(sql, id, b.sessionId, 'others')
    expect(currentUser(sql, id, b.sessionId).status).toBe(200)
    expect(currentUser(sql, id, c.sessionId).status).toBe(403)
    logout(sql, id, b.sessionId, 'global')
    expect(sql.all('SELECT count(*) AS n FROM sessions WHERE user_id = ?', [id])[0].n).toBe(0)
    // remembered as ended (staff sign-out), so never recorded again
    expect(sql.all('SELECT count(*) AS n FROM _ended_sessions WHERE id IN (?, ?, ?)', [a.sessionId, b.sessionId, c.sessionId])[0].n).toBe(3)
  })

  it('"sign staff out" (deleting the rows) ends the session for renewing too', async () => {
    const id = account('five@example.com')
    const g = await signIn('five@example.com')
    sql.run('DELETE FROM sessions WHERE user_id = ?', [id])
    expect(isGrant(await refresh(sql, { refresh_token: g.refreshToken }))).toBe(false)
  })

  it('lets the page change profile details, not the e-mail or password', async () => {
    const id = account('six@example.com', { user_metadata: { full_name: 'Six', keep: 1 } })
    const g = await signIn('six@example.com')
    const res = updateCurrentUser(sql, id, g.sessionId, { data: { full_name: 'Six Two', keep: null } })
    expect(body(res).user_metadata).toEqual({ full_name: 'Six Two' })
    expect(updateCurrentUser(sql, id, g.sessionId, { password: 'x' }).status).toBe(422)
    expect(updateCurrentUser(sql, id, g.sessionId, { email: 'x@example.com' }).status).toBe(422)
  })
})

describe('access tokens', () => {
  it('signs and checks session tokens; other keys, other shapes and expired ones are refused', async () => {
    const secret = authSecret({ SUPABASE_SERVICE_ROLE_KEY: 'service' })!
    expect(secret).not.toBe('service')
    expect(authSecret({ AUTH_JWT_SECRET: 'x'.repeat(40), SUPABASE_SERVICE_ROLE_KEY: 'service' })).toBe('x'.repeat(40))
    expect(authSecret({})).toBeNull()
    const now = Date.UTC(2026, 9, 12, 12)
    const { token, expiresAt } = await signAccessToken(secret, { id: 'u1', email: 'a@b.c', app_metadata: { clerk_user_id: 'user_1' } }, 's1', `${SITE}/auth/v1`, now)
    expect(expiresAt).toBe(now / 1000 + 3600)
    expect(await verifyAccessToken(secret, token, now)).toMatchObject({ sub: 'u1', session_id: 's1', role: 'authenticated', app_metadata: { clerk_user_id: 'user_1' } })
    expect(await verifyAccessToken(secret, token, now + 3601_000)).toBe('expired')
    expect(await verifyAccessToken(authSecret({ SUPABASE_SERVICE_ROLE_KEY: 'other' })!, token, now)).toBeNull()
    const [h, , s] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ sub: 'admin', session_id: 's1', role: 'authenticated', aud: 'authenticated', exp: 9e9 })).toString('base64url')
    expect(await verifyAccessToken(secret, `${h}.${forged}.${s}`, now)).toBeNull()
    const anon = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from('{"role":"anon"}').toString('base64url')}.x`
    expect(await verifyAccessToken(secret, anon, now)).toBeNull()
  })
})
