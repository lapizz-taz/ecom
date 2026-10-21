import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: 'user-jwt' } } })) } },
}))
vi.mock('@/lib/merchant', () => ({
  merchantFetch: (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('x-merchant-id', 'm-1')
    return fetch(input, { ...init, headers })
  },
}))

const { invokeFunction, setSessionRenewer } = await import('./functions')
const { functionsUrl } = await import('./env')

afterEach(() => vi.unstubAllGlobals())

describe('invokeFunction', () => {
  it('posts JSON with the session, the key and the store, and returns the answer', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Response.json({ ok: true, n: 2 })
    }))
    expect(await invokeFunction('checkout', { action: 'quote' })).toEqual({ ok: true, n: 2 })
    expect(calls[0].url).toBe(functionsUrl('checkout'))
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.body).toBe('{"action":"quote"}')
    const headers = new Headers(calls[0].init.headers)
    expect(headers.get('authorization')).toBe('Bearer user-jwt')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('x-merchant-id')).toBe('m-1')
    expect(headers.has('apikey')).toBe(true)
  })

  it('turns the function\'s error body into an AppError with its code and message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'INSUFFICIENT_STOCK', message: 'Only 2 left', details: { left: 2 } } }, { status: 409 })))
    await expect(invokeFunction('checkout', {})).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK', message: 'Only 2 left', details: { left: 2 } })
  })

  it('reports a network failure as NETWORK and a non-JSON failure as a plain error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    await expect(invokeFunction('checkout', {})).rejects.toMatchObject({ code: 'NETWORK' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Bad gateway', { status: 502 })))
    await expect(invokeFunction('checkout', {})).rejects.toMatchObject({ code: 'ERROR', message: 'Request failed' })
  })

  it('returns text answers as text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('done', { headers: { 'Content-Type': 'text/plain' } })))
    expect(await invokeFunction('sms', {})).toBe('done')
  })

  it('renews an ended session once and tries again', async () => {
    let n = 0
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1
      ? Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in' } }, { status: 401 })
      : Response.json({ ok: true }))))
    const renew = vi.fn(async () => true)
    setSessionRenewer(renew)
    try {
      expect(await invokeFunction('channels', { action: 'ad_tracking_get' })).toEqual({ ok: true })
      expect(renew).toHaveBeenCalledTimes(1)
      expect(n).toBe(2)
    } finally {
      setSessionRenewer(null)
    }
  })

  it('says "please sign in" when the session cannot be renewed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'UNAUTHENTICATED', message: 'Please sign in' } }, { status: 401 })))
    setSessionRenewer(async () => false)
    try {
      await expect(invokeFunction('channels', {})).rejects.toMatchObject({ code: 'UNAUTHENTICATED' })
    } finally {
      setSessionRenewer(null)
    }
  })
})
