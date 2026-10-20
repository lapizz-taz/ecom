import { afterEach, describe, expect, it, vi } from 'vitest'
import { registryRecord, setRegistryRelay } from './domain-check.ts'
import { httpPanelRelay } from './fraud/courier-relay.ts'

// Registries such as .shop's refuse Cloudflare Workers, so on the Worker the domain check asks
// them through the relay on Supabase; elsewhere (and with a stand-in fetch) it asks them directly.
const record = { nameservers: ['cosmos.dns-parking.com', 'nova.dns-parking.com'], changed_at: '2026-10-19T18:06:45.0Z' }
const realFetch = globalThis.fetch

/** IANA's list and the .shop registry, as they answer. */
const registry = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url === 'https://data.iana.org/rdap/dns.json') return Response.json({ services: [[['shop'], ['https://rdap.gmoregistry.net/rdap/']]] })
  if (url === 'https://rdap.gmoregistry.net/rdap/domain/atheron.shop') {
    return Response.json({ nameservers: record.nameservers.map((ldhName) => ({ ldhName })), events: [{ eventAction: 'last changed', eventDate: record.changed_at }] })
  }
  return new Response('not found', { status: 404 })
}) as unknown as typeof fetch

afterEach(() => {
  setRegistryRelay(null)
  globalThis.fetch = realFetch
  vi.clearAllMocks()
})

describe('registry lookups through the relay', () => {
  it('on the Worker the registry is asked through the relay, for the root domain', async () => {
    const relay = vi.fn(async () => record)
    setRegistryRelay(relay)
    globalThis.fetch = vi.fn(async () => { throw new Error('the Worker never asks the registry itself') }) as unknown as typeof fetch
    expect(await registryRecord('www.atheron.shop')).toEqual(record)
    expect(relay).toHaveBeenCalledWith('atheron.shop')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('the relay down: the registry is asked directly', async () => {
    setRegistryRelay(vi.fn(async () => { throw new Error('Courier check service answered HTTP 503') }))
    globalThis.fetch = registry
    expect(await registryRecord('atheron.shop')).toEqual(record)
  })

  it('a stand-in fetch (tests, fakes) never goes through the relay', async () => {
    const relay = vi.fn(async () => null)
    setRegistryRelay(relay)
    expect(await registryRecord('atheron.shop', registry)).toEqual(record)
    expect(relay).not.toHaveBeenCalled()
  })

  it('the relay client posts the domain and returns the record (or null when the registry does not say)', async () => {
    const fetchFn = vi.fn(async () => Response.json({ ok: true, record }))
    const relay = httpPanelRelay({ url: 'https://p.supabase.co/functions/v1/courier-relay', cronSecret: 'cron-s', serviceKey: 'svc', fetchFn })
    expect(await relay.rdap('atheron.shop')).toEqual(record)
    const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://p.supabase.co/functions/v1/courier-relay')
    expect(init.headers).toMatchObject({ 'x-cron-secret': 'cron-s', Authorization: 'Bearer svc' })
    expect(JSON.parse(String(init.body))).toEqual({ action: 'rdap', domain: 'atheron.shop' })
    fetchFn.mockResolvedValueOnce(Response.json({ ok: true, record: null }))
    expect(await relay.rdap('no-rdap.bd')).toBeNull()
  })
})
