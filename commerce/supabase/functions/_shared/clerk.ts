// Clerk is the sign-in system: it owns passwords, e-mail codes and sessions.
// The database still works with Supabase Auth users (every row-level rule,
// role and staff record is keyed by their ids), so a verified Clerk session
// is exchanged for a Supabase session of the user with the same verified
// e-mail. Only the server talks to Clerk's Backend API; the secret key lives
// in the CLERK_SECRET_KEY edge function secret, or encrypted in Vault as the
// platform credential "auth.clerk" ({ "secret_key": "sk_..." }).
import { env } from './env.ts'
import { HttpError } from './http.ts'
import { adminClient } from './supabase.ts'

const API = 'https://api.clerk.com/v1'

type Fetch = typeof fetch

export interface ClerkUser {
  id: string
  external_id: string | null
  first_name: string | null
  last_name: string | null
  primary_email_address_id: string | null
  email_addresses: Array<{ id: string; email_address: string; verification: { status: string } | null }>
}

export interface ClerkClaims { sub: string; sid?: string; azp?: string; exp: number; nbf?: number; iat?: number }

let vaultKey: { at: number; value: string | null } | null = null

/** Clerk's secret key: the edge secret first, then the platform credential in Vault. */
export async function clerkSecret(readVault: () => Promise<string | null> = vaultSecret): Promise<string> {
  const key = env('CLERK_SECRET_KEY')
  if (key) return key
  if (!vaultKey || Date.now() - vaultKey.at > 5 * 60_000) vaultKey = { at: Date.now(), value: await readVault() }
  if (!vaultKey.value) throw new HttpError(503, 'Sign-in is not set up yet', 'NOT_CONFIGURED')
  return vaultKey.value
}

async function vaultSecret(): Promise<string | null> {
  const { data, error } = await adminClient().rpc('platform_secret_get', { p_key: 'auth.clerk' })
  if (error) return null
  const value = (data as { secret_key?: unknown } | null)?.secret_key
  return typeof value === 'string' && value.startsWith('sk_') ? value : null
}

async function api<T>(path: string, init: RequestInit = {}, f: Fetch = fetch): Promise<T> {
  const res = await f(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await clerkSecret()}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const first = (body as { errors?: Array<{ code?: string; long_message?: string; message?: string }> } | null)?.errors?.[0]
    const error = new HttpError(res.status >= 500 ? 502 : 422, first?.long_message ?? first?.message ?? 'Sign-in service error', 'CLERK_ERROR', { code: first?.code })
    error.internal = { status: res.status, body }
    throw error
  }
  return body as T
}

// --- Session tokens ---------------------------------------------------------

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0))
const decodeJson = <T>(s: string): T => JSON.parse(new TextDecoder().decode(b64url(s))) as T

let jwksCache: { at: number; keys: Array<JsonWebKey & { kid?: string }> } | null = null

async function signingKey(kid: string, f: Fetch): Promise<JsonWebKey | null> {
  const fresh = jwksCache && Date.now() - jwksCache.at < 10 * 60_000
  if (!fresh || !jwksCache!.keys.some((k) => k.kid === kid)) {
    const set = await api<{ keys: Array<JsonWebKey & { kid?: string }> }>('/jwks', {}, f)
    jwksCache = { at: Date.now(), keys: set.keys }
  }
  return jwksCache!.keys.find((k) => k.kid === kid) ?? null
}

/** Clears the cached signing keys (tests). */
export function resetClerkKeys() { jwksCache = null; vaultKey = null }

/**
 * Checks a Clerk session token: RS256 signature by this Clerk instance's key,
 * not expired, and (when CLERK_AUTHORIZED_PARTIES is set) issued to one of our sites.
 */
export async function verifySessionToken(token: string, f: Fetch = fetch, now = Date.now()): Promise<ClerkClaims> {
  const parts = token.split('.')
  if (parts.length !== 3) throw new HttpError(401, 'Sign in again', 'INVALID_TOKEN')
  let header: { alg?: string; kid?: string }
  let claims: ClerkClaims
  try {
    header = decodeJson(parts[0])
    claims = decodeJson(parts[1])
  } catch {
    throw new HttpError(401, 'Sign in again', 'INVALID_TOKEN')
  }
  if (header.alg !== 'RS256' || !header.kid) throw new HttpError(401, 'Sign in again', 'INVALID_TOKEN')
  const jwk = await signingKey(header.kid, f)
  if (!jwk) throw new HttpError(401, 'Sign in again', 'INVALID_TOKEN')
  const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  if (!ok) throw new HttpError(401, 'Sign in again', 'INVALID_TOKEN')
  const t = Math.floor(now / 1000)
  if (typeof claims.exp !== 'number' || claims.exp < t - 5 || (claims.nbf && claims.nbf > t + 5)) {
    throw new HttpError(401, 'Your sign-in expired. Sign in again.', 'TOKEN_EXPIRED')
  }
  if (!claims.sub || !/^user_[A-Za-z0-9]+$/.test(claims.sub)) throw new HttpError(401, 'Sign in again', 'INVALID_TOKEN')
  const parties = (env('CLERK_AUTHORIZED_PARTIES') ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  if (parties.length && claims.azp && !parties.includes(claims.azp)) throw new HttpError(401, 'Sign in from the Fullfilio site', 'INVALID_TOKEN')
  return claims
}

// --- Users ------------------------------------------------------------------

export const getClerkUser = (id: string, f: Fetch = fetch) => api<ClerkUser>(`/users/${encodeURIComponent(id)}`, {}, f)

export async function findClerkUserByEmail(email: string, f: Fetch = fetch): Promise<ClerkUser | null> {
  const list = await api<ClerkUser[]>(`/users?email_address=${encodeURIComponent(email)}&limit=1`, {}, f)
  return list[0] ?? null
}

/** The user's primary e-mail, only when Clerk has verified it. */
export function verifiedPrimaryEmail(user: ClerkUser): string | null {
  const primary = user.email_addresses.find((e) => e.id === user.primary_email_address_id)
  return primary && primary.verification?.status === 'verified' ? primary.email_address.trim().toLowerCase() : null
}

/**
 * Creates the Clerk account for someone who already has a Fullfilio account.
 * Their e-mail was verified by us before; their current password (if given)
 * carries over, so nothing changes for them.
 */
export function createClerkUser(input: { email: string; password?: string; fullName?: string | null; externalId: string }, f: Fetch = fetch) {
  const [first, ...rest] = (input.fullName ?? '').trim().split(/\s+/).filter(Boolean)
  return api<ClerkUser>('/users', {
    method: 'POST',
    body: JSON.stringify({
      email_address: [input.email],
      external_id: input.externalId,
      first_name: first || undefined,
      last_name: rest.join(' ') || undefined,
      ...(input.password ? { password: input.password, skip_password_checks: true } : { skip_password_requirement: true }),
    }),
  }, f)
}
