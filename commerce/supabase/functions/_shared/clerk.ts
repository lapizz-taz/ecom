// Clerk is the sign-in system: it owns passwords, e-mail codes and sessions.
// The database still works with Supabase Auth users (every row-level rule,
// role and staff record is keyed by their ids), so a verified Clerk session
// is exchanged for a Supabase session of the user with the same verified
// e-mail. Only the server talks to Clerk's Backend API; the secret key lives
// in the CLERK_SECRET_KEY edge function secret, or encrypted in Vault as the
// platform credential "auth.clerk" ({ "secret_key": "sk_...", "proxy_url":
// "https://<site>/__clerk" }; proxy_url only for a production instance).
import { cacheGet, cachePut } from './cache.ts'
import { env } from './env.ts'
import { HttpError } from './http.ts'
import type { SupabaseClient } from '@supabase/supabase-js'
import { adminClient } from './supabase.ts'

const API = 'https://api.clerk.com/v1'

type Fetch = typeof fetch

export interface ClerkUser {
  id: string
  external_id: string | null
  first_name: string | null
  last_name: string | null
  primary_email_address_id: string | null
  banned?: boolean
  email_addresses: Array<{ id: string; email_address: string; verification: { status: string } | null }>
}

export interface ClerkClaims { sub: string; sid?: string; azp?: string; exp: number; nbf?: number; iat?: number }

export interface ClerkSettings { secretKey: string | null; proxyUrl: string | null; webhookSecret?: string | null }

let vaultCache: { at: number; value: ClerkSettings } | null = null

async function vaultSettings(read: () => Promise<ClerkSettings>): Promise<ClerkSettings> {
  if (!vaultCache || Date.now() - vaultCache.at > 5 * 60_000) vaultCache = { at: Date.now(), value: await read() }
  return vaultCache.value
}

/** Clerk's secret key: the edge secret first, then the platform credential in Vault. */
export async function clerkSecret(readVault: () => Promise<ClerkSettings> = readClerkCredential): Promise<string> {
  const key = env('CLERK_SECRET_KEY')
  if (key) return key
  const { secretKey } = await vaultSettings(readVault)
  if (!secretKey) throw new HttpError(503, 'Sign-in is not set up on the server yet: CLERK_SECRET_KEY is missing.', 'NOT_CONFIGURED')
  return secretKey
}

/** The public /__clerk address Clerk's production instance expects, or null when not set. */
export async function clerkProxySetting(readVault: () => Promise<ClerkSettings> = readClerkCredential): Promise<string | null> {
  const set = env('CLERK_PROXY_URL') ?? (await vaultSettings(readVault)).proxyUrl
  if (set) return set.replace(/\/+$/, '')
  const site = env('PLATFORM_URL')
  return site ? `${site.replace(/\/+$/, '')}/__clerk` : null
}

/** The signing secret of Clerk's webhook (Clerk → Webhooks → endpoint), or null when not set. */
export async function clerkWebhookSecret(readVault: () => Promise<ClerkSettings> = readClerkCredential): Promise<string | null> {
  return env('CLERK_WEBHOOK_SECRET') ?? (await vaultSettings(readVault)).webhookSecret ?? null
}

async function readClerkCredential(): Promise<ClerkSettings> {
  const { data, error } = await adminClient().rpc('platform_secret_get', { p_key: 'auth.clerk' })
  if (error) return { secretKey: null, proxyUrl: null }
  const v = (data ?? {}) as { secret_key?: unknown; proxy_url?: unknown; webhook_secret?: unknown }
  return {
    webhookSecret: typeof v.webhook_secret === 'string' && v.webhook_secret.startsWith('whsec_') ? v.webhook_secret : null,
    secretKey: typeof v.secret_key === 'string' && v.secret_key.startsWith('sk_') ? v.secret_key : null,
    proxyUrl: typeof v.proxy_url === 'string' && /^https:\/\/[^/]+\/__clerk\/?$/.test(v.proxy_url) ? v.proxy_url : null,
  }
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

type Jwk = JsonWebKey & { kid?: string }
let jwksCache: { at: number; keys: Jwk[] } | null = null

/** Name of the shared cache entry for this Clerk instance's public keys (from a hash of its secret key). */
async function jwksCacheKey(): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(await clerkSecret())))
  return `clerk:jwks:${Array.from(digest.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('')}`
}

async function signingKey(kid: string, f: Fetch): Promise<JsonWebKey | null> {
  const fresh = jwksCache && Date.now() - jwksCache.at < 10 * 60_000
  if (!fresh || !jwksCache!.keys.some((k) => k.kid === kid)) {
    // Public keys only: another server instance may have fetched them already (Workers KV on Cloudflare).
    const cacheKey = await jwksCacheKey()
    const cached = await cacheGet(cacheKey)
    let keys = cached ? (JSON.parse(cached) as Jwk[]) : null
    if (!keys?.some((k) => k.kid === kid)) {
      keys = (await api<{ keys: Jwk[] }>('/jwks', {}, f)).keys
      await cachePut(cacheKey, JSON.stringify(keys), 3600)
    }
    jwksCache = { at: Date.now(), keys }
  }
  return jwksCache!.keys.find((k) => k.kid === kid) ?? null
}

/** Clears the cached signing keys (tests). */
export function resetClerkKeys() { jwksCache = null; vaultCache = null }

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
  // Not among the current keys of the Clerk instance whose secret key this server has: most
  // often that key belongs to another instance (e.g. development keys on the live site).
  if (!jwk) throw new HttpError(401, 'The server\'s sign-in key belongs to a different Clerk instance than this site. Update CLERK_SECRET_KEY on the server.', 'CLERK_KEY_MISMATCH')
  const key = await crypto.subtle.importKey('jwk', { ...jwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  if (!ok) throw new HttpError(401, 'Sign in again', 'INVALID_TOKEN')
  const t = Math.floor(now / 1000)
  if (typeof claims.exp !== 'number' || claims.exp < t - 5 || (claims.nbf && claims.nbf > t + 5)) {
    throw new HttpError(401, 'Your sign-in expired. Sign in again.', 'TOKEN_EXPIRED')
  }
  if (!claims.sub || !/^user_[A-Za-z0-9]+$/.test(claims.sub)) throw new HttpError(401, 'Sign in again', 'INVALID_TOKEN')
  const parties = (env('CLERK_AUTHORIZED_PARTIES') ?? '').split(',').map((p) => p.trim()).filter(Boolean)
  // When authorized parties are configured, REQUIRE azp and that it is listed —
  // a token with no azp must not skip the check. Clerk session tokens always
  // carry azp, so this does not reject any legitimate sign-in.
  if (parties.length && !(typeof claims.azp === 'string' && parties.includes(claims.azp))) {
    throw new HttpError(401, 'Sign in from the Fullfilio site', 'INVALID_TOKEN')
  }
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

/** A bcrypt hash as Supabase Auth stores it. */
export const BCRYPT_DIGEST = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/

/**
 * Creates the Clerk account for someone who already has a Fullfilio account.
 * Their e-mail was verified by us before; their current password carries over
 * (given in plain text, or as the bcrypt hash the database keeps), so nothing
 * changes for them.
 */
export function createClerkUser(
  input: { email: string; password?: string; passwordDigest?: string | null; fullName?: string | null; externalId: string },
  f: Fetch = fetch,
) {
  const [first, ...rest] = (input.fullName ?? '').trim().split(/\s+/).filter(Boolean)
  const secret = input.password
    ? { password: input.password, skip_password_checks: true }
    : input.passwordDigest && BCRYPT_DIGEST.test(input.passwordDigest)
      ? { password_digest: input.passwordDigest, password_hasher: 'bcrypt' }
      : { skip_password_requirement: true }
  return api<ClerkUser>('/users', {
    method: 'POST',
    body: JSON.stringify({
      email_address: [input.email],
      external_id: input.externalId,
      first_name: first || undefined,
      last_name: rest.join(' ') || undefined,
      ...secret,
    }),
  }, f)
}

const splitName = (full: string | null | undefined) => {
  const [first, ...rest] = (full ?? '').trim().split(/\s+/).filter(Boolean)
  return { first_name: first ?? '', last_name: rest.join(' ') }
}

/** Removes a Clerk account; one that is already gone counts as removed. */
export async function deleteClerkUser(id: string, f: Fetch = fetch): Promise<void> {
  try {
    await api(`/users/${encodeURIComponent(id)}`, { method: 'DELETE' }, f)
  } catch (e) {
    if (!(e instanceof HttpError && (e.details as { code?: string } | undefined)?.code === 'resource_not_found')) throw e
  }
}

/** Blocks or unblocks signing in with this Clerk account (Fullfilio deactivate / reactivate). */
export const setClerkUserBanned = (id: string, banned: boolean, f: Fetch = fetch) =>
  api<ClerkUser>(`/users/${encodeURIComponent(id)}/${banned ? 'ban' : 'unban'}`, { method: 'POST' }, f)

/** Sets the name on the Clerk account (Fullfilio is where it was changed). */
export const setClerkUserName = (id: string, fullName: string, f: Fetch = fetch) =>
  api<ClerkUser>(`/users/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(splitName(fullName)) }, f)

export const clerkFullName = (u: Pick<ClerkUser, 'first_name' | 'last_name'>): string | null =>
  [u.first_name, u.last_name].filter(Boolean).join(' ').trim() || null

/** Clerk's organization settings (Fullfilio does not use Clerk organizations). */
export function updateOrganizationSettings(patch: Record<string, unknown>, f: Fetch = fetch) {
  return api<{ force_organization_selection?: boolean }>('/instance/organization_settings', { method: 'PATCH', body: JSON.stringify(patch) }, f)
}

/** Clerk is set up on this server (its secret key is available). */
export const clerkEnabled = (): Promise<boolean> => clerkSecret().then(() => true, () => false)

/**
 * Gives a Fullfilio login its Clerk account (once) and links the two, so the
 * person signs in with Clerk: with the password given, an e-mail code, or
 * "Forgot password". False when Clerk is not set up.
 */
export async function ensureClerkAccount(
  admin: SupabaseClient,
  who: { userId: string; email: string; password?: string; passwordDigest?: string | null; fullName?: string | null },
): Promise<'created' | 'existed' | false> {
  if (!(await clerkEnabled())) return false
  const existing = await findClerkUserByEmail(who.email)
  const clerkId = existing?.id ??
    (await createClerkUser({ email: who.email, password: who.password, passwordDigest: who.passwordDigest, fullName: who.fullName, externalId: who.userId })).id
  const { data } = await admin.auth.admin.getUserById(who.userId)
  if (data.user && data.user.app_metadata?.clerk_user_id !== clerkId) {
    await admin.auth.admin.updateUserById(who.userId, { app_metadata: { ...data.user.app_metadata, clerk_user_id: clerkId } })
  }
  return existing ? 'existed' : 'created'
}

// --- Frontend API proxy -----------------------------------------------------

/** Clerk's Frontend API, reached through our own /__clerk address in production. */
export const CLERK_FAPI = 'https://frontend-api.clerk.dev'

const DROP_REQUEST = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'x-forwarded-for', 'x-vercel-forwarded-for', 'cf-connecting-ip', 'clerk-secret-key', 'clerk-proxy-url'])
const DROP_RESPONSE = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

/** The visitor's address as the edge saw it (Vercel's header first when Vercel sits in front of us; the Cloudflare Worker removes it and sets X-Forwarded-For). */
export function visitorIp(req: Request): string | null {
  const first = (v: string | null) => v?.split(',')[0]?.trim() || null
  return first(req.headers.get('x-vercel-forwarded-for')) ?? first(req.headers.get('x-forwarded-for')) ?? req.headers.get('x-real-ip')
}

/**
 * Builds the request Clerk expects from a proxy: same method, path, query,
 * body and cookies, plus the proxy address, our secret key and the visitor's IP.
 */
export function proxyRequest(req: Request, path: string, proxyUrl: string, secret: string, body: ArrayBuffer | null): [string, RequestInit] {
  const source = new URL(req.url)
  const headers = new Headers()
  req.headers.forEach((value, key) => { if (!DROP_REQUEST.has(key.toLowerCase())) headers.set(key, value) })
  headers.set('Clerk-Proxy-Url', proxyUrl)
  headers.set('Clerk-Secret-Key', secret)
  const ip = visitorIp(req)
  if (ip) headers.set('X-Forwarded-For', ip)
  const target = `${CLERK_FAPI}/${path.replace(/^\/+/, '')}${source.search}`
  return [target, { method: req.method, headers, body, redirect: 'manual' }]
}

/** Clerk's answer as ours: status, body and every cookie, minus transport headers. */
export function proxyResponse(res: Response): Response {
  const headers = new Headers()
  res.headers.forEach((value, key) => { if (!DROP_RESPONSE.has(key.toLowerCase()) && key.toLowerCase() !== 'set-cookie') headers.set(key, value) })
  for (const cookie of res.headers.getSetCookie?.() ?? []) headers.append('set-cookie', cookie)
  return new Response(res.status === 204 || res.status === 304 ? null : res.body, { status: res.status, statusText: res.statusText, headers })
}

// --- Webhooks ---------------------------------------------------------------

/**
 * Checks a Clerk (Svix) webhook: an HMAC-SHA256 of "id.timestamp.body" with
 * the endpoint's signing secret, sent at most five minutes ago.
 */
export async function verifyWebhook(secret: string, headers: Headers, body: string, now = Date.now()): Promise<boolean> {
  const id = headers.get('svix-id')
  const timestamp = headers.get('svix-timestamp')
  const signatures = headers.get('svix-signature')
  if (!id || !timestamp || !signatures || !/^\d+$/.test(timestamp)) return false
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false
  const key = await crypto.subtle.importKey('raw', b64(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)))
  const expected = btoa(String.fromCharCode(...mac))
  return signatures.split(' ').some((part) => {
    const [version, sig] = part.split(',')
    return version === 'v1' && sig?.length === expected.length && timingSafeEqual(sig, expected)
  })
}

const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}
