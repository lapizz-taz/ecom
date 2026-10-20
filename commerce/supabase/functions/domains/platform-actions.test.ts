// Super Admin → Domains: "Check again" and "Remove" on a store's domain go through the domains
// function for a platform employee. Only an employee who may manage that store gets through, only
// for a domain that store holds, and every attempt lands in the platform audit log. No real network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Client = { merchant: string | null; as: 'user' | 'admin' | 'platform' }

const H = vi.hoisted(() => ({
  user: null as { id: string } | null,
  canManage: new Set<string>(),
  domains: new Map<string, Array<{ domain: string; status: string; checked_at: string | null; created_at: string; verify_code: string; verified_at: string | null }>>(),
  calls: [] as Array<{ client: Client; fn: string; args: Record<string, unknown> }>,
}))

vi.mock('../_shared/env.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_shared/env.ts')>()),
  // No hosting API: the check is the diagnosis alone (MANUAL).
  env: () => undefined,
}))
vi.mock('../_shared/monitoring.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../_shared/monitoring.ts')>()),
  logEvent: () => Promise.resolve(),
}))
vi.mock('../_shared/supabase.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../_shared/supabase.ts')>()
  return {
    ...real,
    adminClient: (merchant?: string | null): Client => ({ merchant: merchant ?? null, as: merchant ? 'admin' : 'platform' }),
    userClient: (): Client => ({ merchant: null, as: 'user' }),
    optionalUser: async () => H.user,
    rpc: async (client: Client, fn: string, args: Record<string, unknown> = {}) => {
      H.calls.push({ client, fn, args })
      if (fn === 'platform_can') return client.as === 'user' && H.canManage.has(String(args.p_merchant))
      if (fn === 'store_domains_list') return H.domains.get(client.merchant ?? '') ?? []
      if (fn === 'store_domain_save') return { domain: args.p_domain, ...(args.p as object) }
      return null
    },
  }
})

import handler from './handler.ts'

const STORE = '6f1d2c3b-4a5e-4f60-9a7b-8c9d0e1f2a3b'
const OTHER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'

const post = (body: unknown) => handler(new Request('https://fullfilio.com/functions/v1/domains', {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test' }, body: JSON.stringify(body),
}))
const saves = () => H.calls.filter((c) => c.fn === 'store_domain_save')
const audits = () => H.calls.filter((c) => c.fn === 'platform_record_action').map((c) => c.args)

beforeEach(() => {
  H.user = { id: 'employee-1' }
  H.canManage = new Set([STORE])
  H.domains = new Map([[STORE, [{ domain: 'shop.example.com', status: 'VERIFYING', checked_at: null, created_at: new Date().toISOString(), verify_code: 'abc', verified_at: null }]]])
  H.calls = []
  vi.stubGlobal('fetch', async () => { throw new Error('no network in tests') })
})
afterEach(() => vi.unstubAllGlobals())

describe('Super Admin domain actions', () => {
  it('needs a signed-in employee', async () => {
    H.user = null
    expect((await post({ action: 'platform_check', merchant_id: STORE, domain: 'shop.example.com' })).status).toBe(401)
    expect(saves()).toHaveLength(0)
  })

  it('refuses an employee who may not manage that store, before touching the domain', async () => {
    const res = await post({ action: 'platform_remove', merchant_id: OTHER, domain: 'shop.example.com', reason: 'Claimed by mistake' })
    expect(res.status).toBe(403)
    expect(H.calls.map((c) => c.fn)).toEqual(['platform_can'])
    // Asked as the employee, for that store.
    expect(H.calls[0]).toMatchObject({ client: { as: 'user' }, args: { p_module: 'merchants', p_action: 'manage', p_merchant: OTHER } })
  })

  it('only acts on a domain the store holds', async () => {
    const res = await post({ action: 'platform_remove', merchant_id: STORE, domain: 'someone-else.com', reason: 'Claimed by mistake' })
    expect(res.status).toBe(404)
    expect(saves()).toHaveLength(0)
  })

  it('checks the domain again inside that store and records who did it', async () => {
    const res = await post({ action: 'platform_check', merchant_id: STORE, domain: 'Shop.Example.com' })
    expect(res.status).toBe(200)
    expect(saves()).toHaveLength(1)
    expect(saves()[0]).toMatchObject({ client: { merchant: STORE, as: 'admin' }, args: { p_domain: 'shop.example.com', p_actor: null } })
    expect(audits()).toEqual([expect.objectContaining({ p_actor: 'employee-1', p_action: 'domain.checked', p_entity_id: 'shop.example.com', p_result: 'SUCCESS',
      p_metadata: expect.objectContaining({ merchant_id: STORE }) })])
  })

  it('removes the domain from that store and records it', async () => {
    const res = await post({ action: 'platform_remove', merchant_id: STORE, domain: 'shop.example.com', reason: 'The owner asked by phone' })
    expect(res.status).toBe(200)
    expect(saves()[0]).toMatchObject({ client: { merchant: STORE }, args: { p_domain: 'shop.example.com', p: { status: 'REMOVED' } } })
    expect(audits()).toEqual([expect.objectContaining({ p_action: 'domain.removed', p_result: 'SUCCESS',
      p_metadata: expect.objectContaining({ merchant_id: STORE, reason: 'The owner asked by phone' }) })])
  })

  it('rejects a malformed request', async () => {
    expect((await post({ action: 'platform_check', merchant_id: 'not-an-id', domain: 'shop.example.com' })).status).toBe(422)
    // A removal says why.
    expect((await post({ action: 'platform_remove', merchant_id: STORE, domain: 'shop.example.com' })).status).toBe(422)
    expect(H.calls).toHaveLength(0)
  })
})
