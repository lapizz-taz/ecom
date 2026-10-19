import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

// Round 2 of the adversarial review of domain ownership proof (store_domains.verify_code /
// verified_at, migrations 20261121000500 and 20261121000600). Every test asserts the CORRECT
// behaviour: a failing test marks a defect, the passing ones are regression coverage.

const ROOT = 'fullfilio.shop'

interface Store { m: string; owner: string; email: string }

async function platform(db: Db): Promise<void> {
  await asSystem(db, null)
  await db.query(`update public.features set globally_enabled = true where code = 'custom_domains'`)
  await db.query(`update public.platform_settings set value = $1 where key = 'store_domains'`, [JSON.stringify({ root_domain: ROOT, main_site: 'marketing' })])
}

async function store(db: Db): Promise<Store> {
  await asSystem(db, null)
  const m = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Shop ${randomUUID().slice(0, 6)}`])
  await asSystem(db, m)
  await db.query(`select public._merchant_seed_defaults($1)`, [m])
  await asSystem(db, null)
  await db.query(`insert into public.merchant_features (merchant_id, feature_code, enabled) values ($1, 'custom_domains', true) on conflict do nothing`, [m])
  const email = `owner-${randomUUID().slice(0, 8)}@example.com`
  const owner = await createStaff(db, 'OWNER', email, m)
  return { m, owner, email }
}

const as = (db: Db, s: Store) => asUser(db, s.owner, s.email, s.m)

async function guard(db: Db, s: Store, d: string, action = 'add'): Promise<void> {
  await as(db, s)
  await db.query(`select public.store_domain_guard($1, $2)`, [d, action])
}

/** What the domains function saves (service role, x-merchant-id of the store). */
async function save(db: Db, s: Store, d: string, p: Record<string, unknown>, actor: string | null = null) {
  await asService(db, s.m)
  return value<Record<string, any> | null>(db, `select public.store_domain_save($1, $2, $3)`, [d, JSON.stringify(p), actor])
}

async function remove(db: Db, s: Store, d: string): Promise<void> {
  await guard(db, s, d, 'remove')
  await save(db, s, d, { status: 'REMOVED', records: [], detail: 'Removed from the store' }, s.owner)
}

async function resolve(db: Db, host: string): Promise<Record<string, any> | null> {
  await asAnon(db, null)
  return value<Record<string, any> | null>(db, `select public.storefront_resolve($1)`, [host])
}

async function known(db: Db, d: string): Promise<boolean | null> {
  await asService(db, null)
  return value<boolean | null>(db, `select public.store_domain_known($1)`, [d])
}

async function row(db: Db, d: string): Promise<{ merchant_id: string; status: string; verify_code: string | null; verified_at: Date | null } | null> {
  await asSystem(db, null)
  return (await db.query(`select merchant_id, status, verify_code, verified_at from public.store_domains where domain = $1`, [d])).rows[0] ?? null
}

/** Moves a claim back in time (as if it was made that many days ago and never proven). */
async function age(db: Db, d: string, days: number): Promise<void> {
  await asSystem(db, null)
  await db.query(`update public.store_domains set created_at = now() - make_interval(days => $2), checked_at = now() - make_interval(days => $2) where domain = $1`, [d, days])
}

// ---------------------------------------------------------------------------
// 1. Reading another store's code
// ---------------------------------------------------------------------------
describe('r2: another store\'s verify_code stays private', () => {
  it('B cannot read A\'s code: the list (staff and service for B), the table, the storefront, the audit log', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await guard(db, A, 'r2-secret.test')
      await save(db, A, 'r2-secret.test', { status: 'VERIFYING', verified: false }, A.owner)
      const code = (await row(db, 'r2-secret.test'))!.verify_code!
      expect(code).toMatch(/^[0-9a-f]{32}$/)

      await as(db, B)
      expect(JSON.stringify(await value(db, `select public.store_domains_list()`))).not.toContain(code)
      await expectError(db, `select verify_code from public.store_domains`, [], /permission denied/)
      await asService(db, B.m)
      expect(JSON.stringify(await value(db, `select public.store_domains_list()`))).not.toContain(code)
      await asAnon(db, null)
      await expectError(db, `select verify_code from public.store_domains`, [], /permission denied/)
      expect(JSON.stringify(await resolve(db, 'r2-secret.test'))).not.toContain(code)
      await asSystem(db, null)
      expect(await value<number>(db, `select count(*)::int from public.audit_logs where (coalesce(old_values, '{}')::text || coalesce(new_values, '{}')::text || coalesce(metadata, '{}')::text) like '%' || $1 || '%'`, [code])).toBe(0)
    }))

  it('the release helper and the twin helper are not callable by staff', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await as(db, A)
      await expectError(db, `select public._store_domain_release('x.test', $1)`, [A.m], /permission denied/)
      await expectError(db, `select public._store_domain_taken('x.test', $1)`, [A.m], /permission denied/)
      await expectError(db, `select public.store_domain_save('x.test', '{"verified":true}', null)`, [], /permission denied/)
    }))
})

// ---------------------------------------------------------------------------
// 2. verified_at without the TXT record
// ---------------------------------------------------------------------------
describe('r2: no path sets verified_at for a store that did not prove the name', () => {
  it('staff cannot write verified_at (no table grant, save is system-only)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await guard(db, A, 'r2-staff.test')
      await as(db, A)
      await expectError(db, `update public.store_domains set verified_at = now() where domain = 'r2-staff.test'`, [], /permission denied/)
      await expectError(db, `select public.store_domain_save('r2-staff.test', '{"status":"ACTIVE","verified":true}', null)`, [], /permission denied/)
      expect((await row(db, 'r2-staff.test'))!.verified_at).toBeNull()
      expect(await known(db, 'r2-staff.test')).toBe(false)
    }))

  it('the function acting for B cannot mark A\'s claim verified (row security), in any spelling', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await guard(db, A, 'r2-cross.test')
      await asService(db, B.m)
      for (const d of ['r2-cross.test', 'R2-CROSS.TEST', ' r2-cross.test ']) {
        await expectError(db, `select public.store_domain_save($1, '{"verified":true}', null)`, [d], /row-level security|row level security|DUPLICATE/)
      }
      // The twin of A's claim is refused for B as well.
      await expectError(db, `select public.store_domain_save('www.r2-cross.test', '{"verified":true}', null)`, [], /DUPLICATE/)
      expect((await row(db, 'r2-cross.test'))!.verified_at).toBeNull()
      expect(await row(db, 'www.r2-cross.test')).toBeNull()
    }))

  it('a re-check that found the TXT lands after the store removed it: nothing is proven', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      await guard(db, A, 'r2-late.test')
      await remove(db, A, 'r2-late.test')
      expect(await save(db, A, 'r2-late.test', { verified: true })).toBeNull()
      expect(await save(db, A, 'r2-late.test', { status: 'ACTIVE', verified: true })).toBeNull()
      expect(await row(db, 'r2-late.test')).toMatchObject({ status: 'REMOVED', verified_at: null })
      expect(await known(db, 'r2-late.test')).toBe(false)
    }))

  it('A\'s in-flight re-check (A removed, B claimed meanwhile) cannot prove B\'s claim or take it back', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await guard(db, A, 'r2-race.test')
      const codeA = (await row(db, 'r2-race.test'))!.verify_code
      await remove(db, A, 'r2-race.test')
      await guard(db, B, 'r2-race.test')
      const fresh = (await row(db, 'r2-race.test'))!
      expect(fresh.merchant_id).toBe(B.m)
      expect(fresh.verify_code).not.toBe(codeA)
      // markVerified and the result save of A's run land now.
      await asService(db, A.m)
      await expectError(db, `select public.store_domain_save('r2-race.test', '{"verified":true}', null)`, [], /row-level security|row level security/)
      await expectError(db, `select public.store_domain_save('r2-race.test', '{"status":"ACTIVE","verified":true}', null)`, [], /row-level security|row level security/)
      expect(await row(db, 'r2-race.test')).toMatchObject({ merchant_id: B.m, status: 'PENDING', verified_at: null })
      expect(await known(db, 'r2-race.test')).toBe(false)
      expect(await resolve(db, 'r2-race.test')).toEqual({ kind: 'missing' })
    }))

  it('B cannot ride on A\'s proven root through a www row, a www.www row or a removed twin', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await guard(db, A, 'r2-root.test')
      await save(db, A, 'r2-root.test', { status: 'ACTIVE', verified: true })
      await as(db, B)
      await expectError(db, `select public.store_domain_guard('www.r2-root.test', 'add')`, [], /DUPLICATE/)
      // www.www.<root>: B may claim it, but it never opens B's store or gets a certificate.
      await guard(db, B, 'www.www.r2-root.test')
      expect(await known(db, 'www.www.r2-root.test')).toBe(false)
      expect(await resolve(db, 'www.www.r2-root.test')).toEqual({ kind: 'missing' })
      // A's www twin still opens A's store.
      expect(await resolve(db, 'www.r2-root.test')).toMatchObject({ kind: 'store', merchant_id: A.m })
    }))
})

// ---------------------------------------------------------------------------
// 3. Codes
// ---------------------------------------------------------------------------
describe('r2: codes are never reused across stores', () => {
  it('after a release the new store gets a new code; the old store coming back after that gets a new one too', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await guard(db, A, 'r2-codes.test')
      const a1 = (await row(db, 'r2-codes.test'))!.verify_code
      await remove(db, A, 'r2-codes.test')
      await guard(db, B, 'r2-codes.test')
      const b1 = (await row(db, 'r2-codes.test'))!.verify_code
      await remove(db, B, 'r2-codes.test')
      await guard(db, A, 'r2-codes.test')
      const a2 = (await row(db, 'r2-codes.test'))!.verify_code
      expect(new Set([a1, b1, a2]).size).toBe(3)
    }))
})

// ---------------------------------------------------------------------------
// 4. Blocking an honest merchant
// ---------------------------------------------------------------------------
describe('r2: an unproven claim cannot block the real owner forever', () => {
  it('a claim on brand.test never proven in 30 days does not stop the real owner\'s store connecting it', () =>
    inTx(async (db) => {
      await platform(db)
      const squatter = await store(db)
      const owner = await store(db)
      await guard(db, squatter, 'r2-brand.test')
      await save(db, squatter, 'r2-brand.test', { status: 'VERIFYING', verified: false })
      await age(db, 'r2-brand.test', 30)
      await guard(db, owner, 'r2-brand.test')
      expect(await row(db, 'r2-brand.test')).toMatchObject({ merchant_id: owner.m, verified_at: null })
    }))

  it('an unproven www twin held for 30 days does not stop the real owner connecting the root', () =>
    inTx(async (db) => {
      await platform(db)
      const squatter = await store(db)
      const owner = await store(db)
      await guard(db, squatter, 'www.r2-twin.test')
      await age(db, 'www.r2-twin.test', 30)
      await guard(db, owner, 'r2-twin.test')
      expect((await row(db, 'r2-twin.test'))?.merchant_id).toBe(owner.m)
    }))

  it('a proven claim still blocks every other store (control)', () =>
    inTx(async (db) => {
      await platform(db)
      const A = await store(db)
      const B = await store(db)
      await guard(db, A, 'r2-proven.test')
      await save(db, A, 'r2-proven.test', { status: 'ACTIVE', verified: true })
      await age(db, 'r2-proven.test', 30)
      await as(db, B)
      await expectError(db, `select public.store_domain_guard('r2-proven.test', 'add')`, [], /DUPLICATE/)
      await expectError(db, `select public.store_domain_guard('www.r2-proven.test', 'add')`, [], /DUPLICATE/)
    }))
})
