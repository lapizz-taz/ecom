import { afterEach, describe, expect, it, vi } from 'vitest'
import { carriesServiceKey } from './cron.ts'

const call = (auth?: string) => new Request('https://x/functions/v1/courier-relay', { method: 'POST', headers: auth ? { Authorization: auth } : {} })

describe('carriesServiceKey (asks Supabase whether the bearer key is the service role)', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('accepts a key Supabase runs the service-role-only check for, and asks only once for it', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://p.supabase.co/')
    const fetchFn = vi.fn(async () => new Response('false', { status: 200 }))
    const key = 'sb_secret_aaaaaaaaaaaaaaaaaaaaaaaa'
    expect(await carriesServiceKey(call(`Bearer ${key}`), fetchFn)).toBe(true)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://p.supabase.co/rest/v1/rpc/cron_secret_matches')
    expect(init.headers).toMatchObject({ apikey: key, Authorization: `Bearer ${key}` })
    expect(await carriesServiceKey(call(`Bearer ${key}`), fetchFn)).toBe(true)
    expect(fetchFn).toHaveBeenCalledTimes(1)
  })

  it('refuses a key Supabase refuses, a missing or short key, and an unreachable Supabase', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://p.supabase.co')
    const refused = vi.fn(async () => new Response('{"message":"permission denied"}', { status: 401 }))
    expect(await carriesServiceKey(call('Bearer anon-key-xxxxxxxxxxxxxxxxxxxx'), refused)).toBe(false)
    expect(await carriesServiceKey(call(), refused)).toBe(false)
    expect(await carriesServiceKey(call('Bearer short'), refused)).toBe(false)
    expect(refused).toHaveBeenCalledTimes(1)
    const down = vi.fn(async () => { throw new Error('network') })
    expect(await carriesServiceKey(call('Bearer another-key-xxxxxxxxxxxxxxxxxx'), down)).toBe(false)
  })
})
