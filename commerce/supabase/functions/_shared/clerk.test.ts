import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { clerkSecret, createClerkUser, resetClerkKeys, verifiedPrimaryEmail, verifySessionToken, type ClerkUser } from './clerk.ts'

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
    await expect(clerkSecret(async () => null)).rejects.toMatchObject({ code: 'NOT_CONFIGURED' })
    resetClerkKeys()
    await expect(clerkSecret(async () => 'sk_test_vault')).resolves.toBe('sk_test_vault')
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

  it('turns Clerk errors into readable ones', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ errors: [{ code: 'form_identifier_exists', long_message: 'That email address is taken.' }] }), { status: 422 }))
    await expect(createClerkUser({ email: 'a@b.co', externalId: 'u' }, f as never)).rejects.toMatchObject({ status: 422, message: 'That email address is taken.' })
  })
})
