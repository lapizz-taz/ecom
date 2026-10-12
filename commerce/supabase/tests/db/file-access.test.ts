import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asAnon, asSystem, asUser, closePool, inTx, value, type Db } from '../support/db'
import { createStaff } from '../support/fixtures'

afterAll(closePool)

async function createMerchant(db: Db): Promise<string> {
  await asSystem(db, null)
  const id = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Shop ${randomUUID().slice(0, 6)}`])
  await asSystem(db, id)
  await db.query(`select public._merchant_seed_defaults($1)`, [id])
  return id
}

/** The Storage policy each bucket/action had, as permission codes (any one is enough). */
const RULES: Record<string, Record<string, string[] | true>> = {
  'product-images': { read: true, write: ['products.manage'], delete: ['products.manage'] },
  'courier-invoices': { read: ['couriers.view', 'finance.view'], write: ['couriers.manage'], delete: [] },
  'order-files': { read: ['orders.view'], write: ['orders.update'], delete: ['orders.update'] },
  documents: { read: ['finance.view', 'purchases.view'], write: ['finance.manage', 'purchases.manage'], delete: ['finance.manage'] },
}

async function access(db: Db, bucket: string, action: string): Promise<string | 'DENIED'> {
  await db.query('savepoint fa')
  try {
    const merchant = await value<string>(db, `select public.file_access($1, $2)`, [bucket, action])
    await db.query('release savepoint fa')
    return merchant
  } catch (error) {
    await db.query('rollback to savepoint fa')
    expect(String((error as Error).message)).toMatch(/PERMISSION_DENIED|permission denied/)
    return 'DENIED'
  }
}

describe('file access (uploads on R2)', () => {
  it('allows exactly what the old Storage policies allowed, for every role, and names the store\'s folder', () =>
    inTx(async (db) => {
      for (const role of ['OWNER', 'ADMIN', 'ORDER_MANAGER', 'FINANCE_MANAGER', 'VIEWER']) {
        const user = await createStaff(db, role)
        await asUser(db, user)
        for (const [bucket, actions] of Object.entries(RULES)) {
          for (const [action, codes] of Object.entries(actions)) {
            let expected = codes === true
            if (codes !== true) {
              for (const code of codes) if (await value<boolean>(db, `select public.has_permission($1)`, [code])) expected = true
            }
            expect([role, bucket, action, await access(db, bucket, action)]).toEqual([role, bucket, action, expected ? MERCHANT_1 : 'DENIED'])
          }
        }
        expect(await access(db, 'secrets', 'read')).toBe('DENIED')
        expect(await access(db, 'product-images', 'list')).toBe('DENIED')
      }
    }))

  it('never hands out another store\'s folder', () =>
    inTx(async (db) => {
      const other = await createMerchant(db)
      const owner = await createStaff(db, 'OWNER')
      // Signed in to store 1, naming store 2: refused, never store 2's folder.
      await asUser(db, owner, 'owner@example.com', other)
      const answer = await access(db, 'product-images', 'write')
      expect(answer).not.toBe(other)
      // Store 2's owner gets store 2.
      const theirs = await createStaff(db, 'OWNER', undefined, other)
      await asUser(db, theirs, 'theirs@example.com', other)
      expect(await access(db, 'product-images', 'write')).toBe(other)
    }))

  it('is closed to visitors who are not signed in', () =>
    inTx(async (db) => {
      await asAnon(db)
      await expect(db.query(`select public.file_access('product-images', 'read')`)).rejects.toThrow(/permission denied/)
    }))
})
