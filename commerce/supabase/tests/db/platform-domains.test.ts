import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createPlatformStaff, createStaff } from '../support/fixtures'

afterAll(closePool)

// Super Admin → Domains: every store's custom domains, for the employees who may see those stores.

interface Store { m: string; owner: string; email: string; name: string }

async function store(db: Db): Promise<Store> {
  const name = `Shop ${randomUUID().slice(0, 6)}`
  await asSystem(db, null)
  await db.query(`update public.features set globally_enabled = true where code = 'custom_domains'`)
  const m = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [name])
  await asSystem(db, m)
  await db.query(`select public._merchant_seed_defaults($1)`, [m])
  await asSystem(db, null)
  await db.query(`insert into public.merchant_features (merchant_id, feature_code, enabled) values ($1, 'custom_domains', true) on conflict do nothing`, [m])
  const email = `owner-${randomUUID().slice(0, 8)}@example.com`
  return { m, owner: await createStaff(db, 'OWNER', email, m), email, name }
}

/** Added by the store, then saved by the domains function as it found it. */
async function domain(db: Db, s: Store, d: string, p: Record<string, unknown>) {
  await asUser(db, s.owner, s.email, s.m)
  await db.query(`select public.store_domain_guard($1, 'add')`, [d])
  await asService(db, s.m)
  await db.query(`select public.store_domain_save($1, $2, $3)`, [d, JSON.stringify(p), s.owner])
}

type Listed = {
  domains: Array<{ domain: string; status: string; bucket: string; issues: number; can_manage: boolean; verify_code?: string; merchant: { id: string; name: string } }>
  counts: Record<string, number>; stores: number; can_manage: boolean
}
const list = async (db: Db, staff: string, search: string | null = null, bucket: string | null = null) => {
  await asUser(db, staff, 'staff@platform.example', null)
  return value<Listed>(db, `select public.platform_store_domains_list($1, $2)`, [search, bucket])
}

describe('Super Admin domain management', () => {
  it('lists every store\'s domains with the store, the state and issues first, filtered and searched', () =>
    inTx(async (db) => {
      const n = randomUUID().slice(0, 6)
      const a = await store(db)
      const b = await store(db)
      await domain(db, a, `shop-${n}.com`, { status: 'ACTIVE', verified: true, detail: 'Live' })
      await domain(db, a, `www.wait-${n}.com`, { status: 'VERIFYING', detail: 'Waiting for DNS' })
      await domain(db, b, `broken-${n}.com`, {
        status: 'ACTIVE', verified: true, detail: 'Live',
        diagnostics: { pointed: false, regions: [], tls: { ok: false }, issues: [{ code: 'WRONG_TARGET', severity: 'error', title: 'Points elsewhere' }] },
      })
      await domain(db, b, `gone-${n}.com`, { status: 'ACTIVE', verified: true })
      await asService(db, b.m)
      await db.query(`select public.store_domain_save($1, $2, null)`, [`gone-${n}.com`, JSON.stringify({ status: 'REMOVED', records: [] })])

      const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
      const all = await list(db, superId, n)
      expect(all.domains.map((d) => [d.domain, d.bucket])).toEqual([
        [`broken-${n}.com`, 'ISSUES'], [`www.wait-${n}.com`, 'WAITING'], [`shop-${n}.com`, 'LIVE'],
      ])
      expect(all.counts).toMatchObject({ ALL: 3, LIVE: 1, WAITING: 1, ISSUES: 1, REMOVED: 1 })
      expect(all.domains[0]).toMatchObject({ merchant: { id: b.m, name: b.name }, issues: 1, can_manage: true })
      // The ownership code stays the store's.
      expect(all.domains.every((d) => d.verify_code === undefined)).toBe(true)
      expect(all.can_manage).toBe(true)

      expect((await list(db, superId, n, 'REMOVED')).domains.map((d) => d.domain)).toEqual([`gone-${n}.com`])
      expect((await list(db, superId, a.name.toLowerCase())).domains.map((d) => d.domain).sort()).toEqual([`shop-${n}.com`, `www.wait-${n}.com`])
      await expectError(db, `select public.platform_store_domains_list(null, 'NOPE')`, [], /unknown filter/)
    }))

  it('shows an employee only the stores they are assigned, read-only without merchants.manage; merchants never', () =>
    inTx(async (db) => {
      const n = randomUUID().slice(0, 6)
      const a = await store(db)
      const b = await store(db)
      await domain(db, a, `mine-${n}.com`, { status: 'ACTIVE', verified: true })
      await domain(db, b, `theirs-${n}.com`, { status: 'ACTIVE', verified: true })

      const agent = await createPlatformStaff(db, 'SUPPORT_AGENT', { scope: 'ASSIGNED', merchants: [a.m] })
      const seen = await list(db, agent, n)
      expect(seen.domains.map((d) => d.domain)).toEqual([`mine-${n}.com`])
      expect(seen.domains[0].can_manage).toBe(false)
      expect(seen.can_manage).toBe(false)

      await asUser(db, a.owner, a.email, a.m)
      await expectError(db, `select public.platform_store_domains_list(null, null)`, [], /PERMISSION_DENIED|permission denied/)
    }))
})
