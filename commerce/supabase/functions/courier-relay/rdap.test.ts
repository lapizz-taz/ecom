import { afterEach, describe, expect, it, vi } from 'vitest'

// The relay on Supabase answers the Worker's registry lookups (registries such as .shop's refuse
// Cloudflare Workers). Only our own servers may ask, and the RDAP server comes from IANA's list.
vi.mock('../_shared/cron.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_shared/cron.ts')>()),
  isCronRequest: async (req: Request) => req.headers.get('x-cron-secret') === 'cron-secret-for-tests',
  carriesServiceKey: async () => false,
}))
vi.mock('../_shared/supabase.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_shared/supabase.ts')>()),
  adminClient: () => ({}),
}))

const { default: handler } = await import('./handler.ts')

const realFetch = globalThis.fetch
const asked: string[] = []
afterEach(() => {
  globalThis.fetch = realFetch
  asked.length = 0
})

function registries() {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    asked.push(url)
    if (url === 'https://data.iana.org/rdap/dns.json') return Response.json({ services: [[['shop'], ['https://rdap.gmoregistry.net/rdap/']]] })
    if (url === 'https://rdap.gmoregistry.net/rdap/domain/atheron.shop') {
      return Response.json({ nameservers: [{ ldhName: 'nova.dns-parking.com' }, { ldhName: 'cosmos.dns-parking.com' }], events: [{ eventAction: 'last changed', eventDate: '2026-10-19T18:06:45.0Z' }] })
    }
    return new Response('not found', { status: 404 })
  }) as typeof fetch
}

const post = (body: unknown, secret = 'cron-secret-for-tests') =>
  handler(new Request('https://p.supabase.co/functions/v1/courier-relay', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cron-secret': secret }, body: JSON.stringify(body),
  }))

describe('courier-relay: registry lookups', () => {
  it('answers the registry record of the root domain from IANA\'s RDAP server', async () => {
    registries()
    const res = await post({ action: 'rdap', domain: 'ATHERON.shop' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, record: { nameservers: ['cosmos.dns-parking.com', 'nova.dns-parking.com'], changed_at: '2026-10-19T18:06:45.0Z' } })
    expect(asked).toEqual(['https://data.iana.org/rdap/dns.json', 'https://rdap.gmoregistry.net/rdap/domain/atheron.shop'])
  })

  it('refuses callers without the server credentials', async () => {
    registries()
    expect((await post({ action: 'rdap', domain: 'atheron.shop' }, 'wrong')).status).toBe(401)
    expect(asked).toEqual([])
  })

  it('takes only a domain name: no URL, path or address reaches a fetch', async () => {
    registries()
    for (const domain of ['https://evil.example/x', 'atheron.shop/../admin', '169.254.169.254', 'a b.shop', '']) {
      expect((await post({ action: 'rdap', domain })).status, domain).toBeGreaterThanOrEqual(400)
    }
    expect(asked).toEqual([])
  })
})
