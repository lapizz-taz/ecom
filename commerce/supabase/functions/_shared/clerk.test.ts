import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { setSharedCache } from './cache.ts'
import { clerkProxySetting, clerkSecret, clerkWebhookSecret, createClerkUser, deleteClerkUser, setClerkUserBanned, setClerkUserName, verifyWebhook, proxyRequest, proxyResponse, resetClerkKeys, verifiedPrimaryEmail, verifySessionToken, type ClerkUser } from './clerk.ts'

const enc = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
let keys: CryptoKeyPair
let other: CryptoKeyPair
let jwk: JsonWebKey

async function sign(claims: Record<string, unknown>, pair = keys, kid = 'ins_1') {
  const head = enc({ alg: 'RS256', kid, typ: 'JWT' })
  const body = enc(claims)
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`))
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`
}

const now = Date.UTC(2026, 9, 11, 12)
const t = Math.floor(now / 1000)
const jwksFetch = vi.fn(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: 'ins_1' }] }), { status: 200 }))

describe('clerk session tokens', () => {
  beforeAll(async () => {
    const algo = { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }
    keys = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']) as CryptoKeyPair
    other = await crypto.subtle.generateKey(algo, true, ['sign', 'verify']) as CryptoKeyPair
    jwk = await crypto.subtle.exportKey('jwk', keys.publicKey)
  })
  beforeEach(() => { resetClerkKeys(); jwksFetch.mockClear(); vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_x') })
  afterEach(() => vi.unstubAllEnvs())

  it('accepts a token signed by the instance key', async () => {
    const claims = await verifySessionToken(await sign({ sub: 'user_abc', sid: 'sess_1', exp: t + 60, nbf: t - 5 }), jwksFetch as never, now)
    expect(claims.sub).toBe('user_abc')
    expect(jwksFetch).toHaveBeenCalledWith('https://api.clerk.com/v1/jwks', expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer sk_test_x' }) }))
  })

  it('shares the public signing keys through the cache (Workers KV), per Clerk instance', async () => {
    const store = new Map<string, string>()
    setSharedCache({ get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v) } })
    try {
      const token = await sign({ sub: 'user_abc', exp: t + 60 })
      await verifySessionToken(token, jwksFetch as never, now)
      expect(jwksFetch).toHaveBeenCalledTimes(1)
      expect([...store.keys()]).toEqual([expect.stringMatching(/^clerk:jwks:[0-9a-f]{16}$/)])
      expect([...store.values()][0]).not.toContain('sk_test_x')
      // A new server instance (empty memory) uses the shared copy instead of asking Clerk.
      resetClerkKeys()
      await verifySessionToken(token, jwksFetch as never, now)
      expect(jwksFetch).toHaveBeenCalledTimes(1)
      // Another Clerk instance (other secret key) never reads this instance's keys.
      resetClerkKeys()
      vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_other')
      await verifySessionToken(token, jwksFetch as never, now)
      expect(jwksFetch).toHaveBeenCalledTimes(2)
      // A broken cache is ignored.
      setSharedCache({ get: async () => { throw new Error('kv down') }, put: async () => { throw new Error('kv down') } })
      resetClerkKeys()
      await expect(verifySessionToken(token, jwksFetch as never, now)).resolves.toMatchObject({ sub: 'user_abc' })
    } finally {
      setSharedCache(null)
    }
  })

  it('rejects tampered, foreign, expired and malformed tokens', async () => {
    const good = await sign({ sub: 'user_abc', exp: t + 60 })
    const [h, , s] = good.split('.')
    await expect(verifySessionToken(`${h}.${enc({ sub: 'user_evil', exp: t + 60 })}.${s}`, jwksFetch as never, now)).rejects.toMatchObject({ status: 401 })
    await expect(verifySessionToken(await sign({ sub: 'user_abc', exp: t + 60 }, other), jwksFetch as never, now)).rejects.toMatchObject({ status: 401 })
    await expect(verifySessionToken(await sign({ sub: 'user_abc', exp: t - 60 }), jwksFetch as never, now)).rejects.toMatchObject({ code: 'TOKEN_EXPIRED' })
    await expect(verifySessionToken(await sign({ sub: 'user_abc', exp: t + 60 }, keys, 'ins_unknown'), jwksFetch as never, now)).rejects.toMatchObject({ status: 401 })
    await expect(verifySessionToken(await sign({ sub: 'not-a-user', exp: t + 60 }), jwksFetch as never, now)).rejects.toMatchObject({ status: 401 })
    await expect(verifySessionToken('abc', jwksFetch as never, now)).rejects.toMatchObject({ status: 401 })
    const none = `${enc({ alg: 'none', kid: 'ins_1' })}.${enc({ sub: 'user_abc', exp: t + 60 })}.`
    await expect(verifySessionToken(none, jwksFetch as never, now)).rejects.toMatchObject({ status: 401 })
  })

  it('checks the site the token was issued to when configured', async () => {
    vi.stubEnv('CLERK_AUTHORIZED_PARTIES', 'https://app.example.com')
    await expect(verifySessionToken(await sign({ sub: 'user_abc', exp: t + 60, azp: 'https://evil.example' }), jwksFetch as never, now)).rejects.toMatchObject({ status: 401 })
    await expect(verifySessionToken(await sign({ sub: 'user_abc', exp: t + 60, azp: 'https://app.example.com' }), jwksFetch as never, now)).resolves.toMatchObject({ sub: 'user_abc' })
  })

  it('fails closed without the secret key', async () => {
    vi.stubEnv('CLERK_SECRET_KEY', '')
    await expect(clerkSecret(async () => ({ secretKey: null, proxyUrl: null }))).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    resetClerkKeys()
    await expect(clerkSecret(async () => ({ secretKey: 'sk_test_vault', proxyUrl: null }))).resolves.toBe('sk_test_vault')
  })

  it('finds the proxy address: setting, then the Vault credential, then the site address', async () => {
    const vault = async () => ({ secretKey: 'sk_live_v', proxyUrl: 'https://shop.example/__clerk/' })
    vi.stubEnv('CLERK_PROXY_URL', 'https://set.example/__clerk')
    resetClerkKeys()
    await expect(clerkProxySetting(vault)).resolves.toBe('https://set.example/__clerk')
    vi.stubEnv('CLERK_PROXY_URL', '')
    await expect(clerkProxySetting(vault)).resolves.toBe('https://shop.example/__clerk')
    resetClerkKeys()
    vi.stubEnv('PLATFORM_URL', 'https://site.example/')
    await expect(clerkProxySetting(async () => ({ secretKey: null, proxyUrl: null }))).resolves.toBe('https://site.example/__clerk')
    vi.unstubAllEnvs()
    resetClerkKeys()
    await expect(clerkProxySetting(async () => ({ secretKey: null, proxyUrl: null }))).resolves.toBeNull()
  })
})

describe('clerk users', () => {
  beforeEach(() => vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_x'))
  afterEach(() => vi.unstubAllEnvs())

  it('only trusts a verified primary e-mail', () => {
    const u = (status: string, primary = 'e1'): ClerkUser => ({
      id: 'user_1', external_id: null, first_name: null, last_name: null, primary_email_address_id: primary,
      email_addresses: [{ id: 'e1', email_address: ' Owner@Shop.com ', verification: { status } }, { id: 'e2', email_address: 'x@y.z', verification: { status: 'verified' } }],
    })
    expect(verifiedPrimaryEmail(u('verified'))).toBe('owner@shop.com')
    expect(verifiedPrimaryEmail(u('unverified'))).toBeNull()
    expect(verifiedPrimaryEmail(u('verified', 'e9'))).toBeNull()
  })

  it('creates a migrated user with the old password, or without one', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: 'user_new' }), { status: 200 }))
    await createClerkUser({ email: 'a@b.co', password: 'old-pass', fullName: 'Ayesha Rahman Khan', externalId: 'uuid-1' }, f as never)
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({
      email_address: ['a@b.co'], external_id: 'uuid-1', first_name: 'Ayesha', last_name: 'Rahman Khan', password: 'old-pass', skip_password_checks: true,
    })
    await createClerkUser({ email: 'a@b.co', externalId: 'uuid-1' }, f as never)
    expect(JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toEqual({ email_address: ['a@b.co'], external_id: 'uuid-1', skip_password_requirement: true })
  })

  it('carries a bcrypt password hash over, and ignores anything else', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ id: 'user_new' }), { status: 200 }))
    const digest = '$2a$10$' + 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0'
    await createClerkUser({ email: 'a@b.co', passwordDigest: digest, externalId: 'u' }, f as never)
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ password_digest: digest, password_hasher: 'bcrypt' })
    await createClerkUser({ email: 'a@b.co', passwordDigest: 'plain-text', externalId: 'u' }, f as never)
    const second = JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)
    expect(second).toMatchObject({ skip_password_requirement: true })
    expect(second).not.toHaveProperty('password_digest')
  })

  it('turns Clerk errors into readable ones', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: 'form_identifier_exists', long_message: 'That email address is taken.' }] }), { status: 422 }))
    await expect(createClerkUser({ email: 'a@b.co', externalId: 'u' }, f as never)).rejects.toMatchObject({ status: 422, message: 'That email address is taken.' })
  })
})

describe('clerk frontend api proxy', () => {
  it('forwards path, query, body and cookies with the proxy headers, and drops spoofable ones', () => {
    const req = new Request('https://x.supabase.co/clerk-proxy/v1/client/sign_ins?_clerk_js_version=5', {
      method: 'POST',
      headers: { cookie: '__client=abc', 'content-type': 'application/x-www-form-urlencoded', host: 'x.supabase.co', 'x-forwarded-for': '203.0.113.9, 10.0.0.1', 'clerk-secret-key': 'sk_evil', 'clerk-proxy-url': 'https://evil.example' },
    })
    const [target, init] = proxyRequest(req, 'v1/client/sign_ins', 'https://site.example/__clerk', 'sk_live_x', new TextEncoder().encode('a=1').buffer as ArrayBuffer)
    const h = init.headers as Headers
    expect(target).toBe('https://frontend-api.clerk.dev/v1/client/sign_ins?_clerk_js_version=5')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(h.get('cookie')).toBe('__client=abc')
    expect(h.get('clerk-secret-key')).toBe('sk_live_x')
    expect(h.get('clerk-proxy-url')).toBe('https://site.example/__clerk')
    expect(h.get('x-forwarded-for')).toBe('203.0.113.9')
    expect(h.get('host')).toBeNull()
  })

  it('prefers the address Vercel saw', () => {
    const req = new Request('https://x/clerk-proxy/v1/environment', { headers: { 'x-vercel-forwarded-for': '198.51.100.7', 'x-forwarded-for': '10.0.0.1' } })
    const [, init] = proxyRequest(req, '/v1/environment', 'https://s/__clerk', 'sk', null)
    expect((init.headers as Headers).get('x-forwarded-for')).toBe('198.51.100.7')
  })

  it('passes every cookie and redirect back, without transport headers', async () => {
    const upstream = new Response('{}', { status: 307, headers: { location: 'https://accounts.google.com/o', 'content-encoding': 'gzip', 'content-type': 'application/json' } })
    upstream.headers.append('set-cookie', '__client=1; Path=/; HttpOnly')
    upstream.headers.append('set-cookie', '__client_uat=2; Path=/')
    const res = proxyResponse(upstream)
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('https://accounts.google.com/o')
    expect(res.headers.get('content-encoding')).toBeNull()
    expect(res.headers.getSetCookie()).toEqual(['__client=1; Path=/; HttpOnly', '__client_uat=2; Path=/'])
  })
})

describe('clerk webhooks', () => {
  const secret = 'whsec_' + Buffer.from('a-very-secret-signing-key-32byte').toString('base64')
  async function signed(body: string, at = Math.floor(Date.now() / 1000), id = 'msg_1') {
    const key = await crypto.subtle.importKey('raw', Buffer.from(secret.slice(6), 'base64'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const mac = Buffer.from(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${at}.${body}`))).toString('base64')
    return new Headers({ 'svix-id': id, 'svix-timestamp': String(at), 'svix-signature': `v1,bogus v1,${mac}` })
  }

  it('accepts only a fresh call signed with the endpoint secret, for this exact body', async () => {
    const body = JSON.stringify({ type: 'user.updated', data: { id: 'user_1' } })
    expect(await verifyWebhook(secret, await signed(body), body)).toBe(true)
    expect(await verifyWebhook(secret, await signed(body), body.replace('user_1', 'user_2'))).toBe(false)
    expect(await verifyWebhook('whsec_' + Buffer.from('another-key-another-key-32bytes!').toString('base64'), await signed(body), body)).toBe(false)
    expect(await verifyWebhook(secret, await signed(body, Math.floor(Date.now() / 1000) - 600), body)).toBe(false)
    expect(await verifyWebhook(secret, new Headers(), body)).toBe(false)
  })

  it('reads the signing secret from the edge secret, then the Vault credential', async () => {
    resetClerkKeys()
    vi.stubEnv('CLERK_WEBHOOK_SECRET', '')
    await expect(clerkWebhookSecret(async () => ({ secretKey: 'sk', proxyUrl: null, webhookSecret: 'whsec_v' }))).resolves.toBe('whsec_v')
    vi.stubEnv('CLERK_WEBHOOK_SECRET', 'whsec_env')
    await expect(clerkWebhookSecret(async () => ({ secretKey: 'sk', proxyUrl: null, webhookSecret: 'whsec_v' }))).resolves.toBe('whsec_env')
    vi.unstubAllEnvs()
    resetClerkKeys()
  })
})

describe('clerk account changes from Fullfilio', () => {
  beforeEach(() => vi.stubEnv('CLERK_SECRET_KEY', 'sk_test_x'))
  afterEach(() => vi.unstubAllEnvs())

  it('bans, unbans, renames and deletes the Clerk account; an account already gone counts as deleted', async () => {
    const calls: Array<[string, RequestInit]> = []
    const ok = vi.fn(async (url: string, init: RequestInit) => { calls.push([url, init]); return new Response('{}', { status: 200 }) })
    await setClerkUserBanned('user_1', true, ok as never)
    await setClerkUserBanned('user_1', false, ok as never)
    await setClerkUserName('user_1', '  Ayesha  Rahman Khan ', ok as never)
    await deleteClerkUser('user_1', ok as never)
    expect(calls.map(([u, i]) => `${i.method} ${u.replace('https://api.clerk.com/v1', '')}`)).toEqual([
      'POST /users/user_1/ban', 'POST /users/user_1/unban', 'PATCH /users/user_1', 'DELETE /users/user_1',
    ])
    expect(JSON.parse(calls[2][1].body as string)).toEqual({ first_name: 'Ayesha', last_name: 'Rahman Khan' })
    const gone = vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: 'resource_not_found', message: 'not found' }] }), { status: 404 }))
    await expect(deleteClerkUser('user_x', gone as never)).resolves.toBeUndefined()
    const down = vi.fn(async () => new Response('{}', { status: 500 }))
    await expect(deleteClerkUser('user_x', down as never)).rejects.toMatchObject({ status: 502 })
  })
})
