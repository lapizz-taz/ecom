// Access tokens of sign-in sessions (worker/db/auth.ts): HS256 JWTs like Supabase
// Auth's, signed with AUTH_JWT_SECRET or, when that is not set, a key derived from the
// (secret) service key, so no new secret is needed. They last an hour; the page's
// supabase-js renews them with the session's refresh token.

export const ACCESS_TTL_S = 3600

export interface TokenEnv {
  AUTH_JWT_SECRET?: string
  SUPABASE_SERVICE_ROLE_KEY?: string
}

export interface AccessClaims {
  sub: string
  session_id: string
  email?: string
  role: 'authenticated'
  aud: 'authenticated'
  exp: number
  iat: number
  iss?: string
  app_metadata?: Record<string, unknown>
  user_metadata?: Record<string, unknown>
}

/** The signing key, or null when neither secret is set (sign-in is then not available). */
export function authSecret(env: TokenEnv): string | null {
  if (env.AUTH_JWT_SECRET && env.AUTH_JWT_SECRET.length >= 32) return env.AUTH_JWT_SECRET
  return env.SUPABASE_SERVICE_ROLE_KEY ? `fullfilio-auth-jwt:${env.SUPABASE_SERVICE_ROLE_KEY}` : null
}

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)))
const fromB64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))

async function hmacKey(secret: string, usage: 'sign' | 'verify') {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage])
}

export async function signAccessToken(
  secret: string,
  user: { id: string; email?: string | null; app_metadata?: unknown; user_metadata?: unknown },
  sessionId: string,
  issuer: string,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  const iat = Math.floor(now / 1000)
  const claims: AccessClaims & Record<string, unknown> = {
    iss: issuer, sub: user.id, aud: 'authenticated', role: 'authenticated', iat, exp: iat + ACCESS_TTL_S,
    email: user.email ?? '', phone: '', session_id: sessionId, aal: 'aal1', amr: [{ method: 'otp', timestamp: iat }], is_anonymous: false,
    app_metadata: (user.app_metadata ?? {}) as Record<string, unknown>, user_metadata: (user.user_metadata ?? {}) as Record<string, unknown>,
  }
  const body = `${b64urlJson({ alg: 'HS256', typ: 'JWT' })}.${b64urlJson(claims)}`
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret, 'sign'), new TextEncoder().encode(body)))
  return { token: `${body}.${b64url(sig)}`, expiresAt: iat + ACCESS_TTL_S }
}

/**
 * The claims of an access token signed with this key: 'expired' once past its time,
 * null when it is not one of ours (another key, malformed, not a session token).
 */
export async function verifyAccessToken(secret: string, token: string, now = Date.now()): Promise<AccessClaims | 'expired' | null> {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  let header: { alg?: string }
  let claims: AccessClaims
  try {
    header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])))
    claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])))
  } catch {
    return null
  }
  if (header.alg !== 'HS256') return null
  let ok = false
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret, 'verify'), fromB64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  } catch {
    return null
  }
  if (!ok) return null
  if (claims.role !== 'authenticated' || typeof claims.sub !== 'string' || typeof claims.session_id !== 'string') return null
  if (typeof claims.exp !== 'number' || claims.exp < Math.floor(now / 1000)) return 'expired'
  return claims
}
