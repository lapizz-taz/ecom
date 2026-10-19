import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

async function createMerchant(db: Db): Promise<string> {
  await asSystem(db, null)
  const id = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Shop ${randomUUID().slice(0, 6)}`])
  await asSystem(db, id)
  await db.query(`select public._merchant_seed_defaults($1)`, [id])
  return id
}

/** Custom domains ship switched off (Super Admin → Features & Access); these tests switch it on. */
const domainsOn = (db: Db, on = true) => db.query(`update public.features set globally_enabled = $1 where code = 'custom_domains'`, [on])

const status = (db: Db, d: string) => value<string>(db, `select status || ':' || merchant_id from public.store_domains where domain = $1`, [d])

describe('custom domains: adding one again', () => {
  it('a removed domain can be added again by the store', () =>
    inTx(async (db) => {
      await domainsOn(db)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await db.query(`select public.store_domain_guard('atheron.shop', 'add')`)
      await asService(db)
      await db.query(`select public.store_domain_save('atheron.shop', '{"status":"REMOVED","records":[]}', $1)`, [owner])

      await asUser(db, owner)
      // Same store, after removing it: allowed (this used to say "no permission").
      await db.query(`select public.store_domain_guard('Atheron.shop', 'add')`)
      await asSystem(db, null)
      expect(await status(db, 'atheron.shop')).toMatch(/^PENDING:/)
    }))

  it('a domain added again is the primary one when the store has no other', () =>
    inTx(async (db) => {
      await domainsOn(db)
      const owner = await createStaff(db, 'OWNER')
      const primary = () => value<boolean>(db, `select is_primary from public.store_domains where domain = 'atheron.shop'`)
      await asUser(db, owner)
      await db.query(`select public.store_domain_guard('atheron.shop', 'add')`)
      await asService(db)
      await db.query(`select public.store_domain_save('atheron.shop', '{"status":"ACTIVE"}', $1)`, [owner])
      expect(await primary()).toBe(true)
      await db.query(`select public.store_domain_save('atheron.shop', '{"status":"REMOVED","records":[]}', $1)`, [owner])
      expect(await primary()).toBe(false)

      // Added back: the guard marks it pending first, then the check saves it.
      await asUser(db, owner)
      await db.query(`select public.store_domain_guard('atheron.shop', 'add')`)
      await asService(db)
      await db.query(`select public.store_domain_save('atheron.shop', '{"status":"ACTIVE"}', $1)`, [owner])
      expect(await primary()).toBe(true)

      // With another primary in place, a returning domain stays secondary.
      await asUser(db, owner)
      await db.query(`select public.store_domain_guard('two.shop', 'add')`)
      await asService(db)
      await db.query(`select public.store_domain_save('two.shop', '{"status":"ACTIVE"}', $1)`, [owner])
      expect(await value(db, `select is_primary from public.store_domains where domain = 'two.shop'`)).toBe(false)
    }))

  it('a domain another store uses is refused with the real reason, not "no permission"', () =>
    inTx(async (db) => {
      await domainsOn(db)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await db.query(`select public.store_domain_guard('busy.shop', 'add')`)
      const m2 = await createMerchant(db)
      // The second store has no plan: give it custom domains directly.
      await db.query(`insert into public.merchant_features (merchant_id, feature_code, enabled) values ($1, 'custom_domains', true)`, [m2])
      const other = await createStaff(db, 'OWNER', `o-${randomUUID().slice(0, 6)}@example.com`, m2)
      await asUser(db, other)
      await expectError(db, `select public.store_domain_guard('busy.shop', 'add')`, [], /DUPLICATE: That domain is already connected to another store/)
      await expectError(db, `select public.store_domain_guard('busy.shop', 'remove')`, [], /NOT_FOUND: That domain is not on this store/)
    }))

  it('while Custom domains is switched off nobody can add one, but a connected one can still be removed', () =>
    inTx(async (db) => {
      await domainsOn(db)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await db.query(`select public.store_domain_guard('kept.shop', 'add')`)
      await asSystem(db, null)
      await domainsOn(db, false)
      await asUser(db, owner)
      await expectError(db, `select public.store_domain_guard('new.shop', 'add')`, [], /FEATURE_OFF: Custom domains is switched off/)
      await db.query(`select public.store_domain_guard('kept.shop', 'remove')`)
    }))
})
