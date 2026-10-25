// Staff saving stock for many products at once (a bulk stock edit, receiving a purchase order) lock
// the stock rows in one fixed order (by variant id), the order every web order uses: otherwise a
// save listing product B before product A and an order for A and B could each hold one row and wait
// for the other, and Postgres aborts one of them ("deadlock detected"). Like stock-lock-order.test.ts:
// while the lower product is held elsewhere, a save listing [higher, lower] must wait without holding
// the higher row. Real connections, in a database of its own.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asSystem, createTestDatabase, MERCHANT_1, value, type Db } from '../support/db'
import { createProduct } from '../support/fixtures'

const onEngine = Boolean(process.env.CF_DB_TESTS)

let pool: pg.Pool

beforeAll(async () => {
  if (onEngine) return
  pool = new pg.Pool({ connectionString: await createTestDatabase('commerce_staff_stock_locks'), max: 4 })
}, 300_000)
afterAll(async () => { await pool?.end() })

async function committed<T>(db: Db, work: () => Promise<T>): Promise<T> {
  await db.query('begin')
  try {
    await asSystem(db, MERCHANT_1)
    const out = await work()
    await db.query('commit')
    return out
  } catch (e) {
    await db.query('rollback')
    throw e
  }
}

/** Two products with stock; [lower, higher] by variant id. */
async function twoProducts(db: Db): Promise<[string, string]> {
  const ids = await committed(db, async () =>
    [(await createProduct(db, { price: 300, stock: 20 })).variantIds[0], (await createProduct(db, { price: 300, stock: 20 })).variantIds[0]])
  return ids.sort() as [string, string]
}

/** Returns once the connection waits for a lock; fails if its work ends first. */
async function waitUntilBlocked(watcher: Db, pid: number, work: Promise<unknown>): Promise<void> {
  let settled: string | null = null
  work.then(() => { settled = 'it finished without waiting' }, (e: Error) => { settled = `it failed: ${e.message}` })
  for (let i = 0; i < 200; i++) {
    if (await value<boolean>(watcher, `select coalesce((select wait_event_type = 'Lock' from pg_stat_activity where pid = $1), false)`, [pid])) return
    if (settled) throw new Error(settled)
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('it never waited for the held stock row')
}

/**
 * Holds the lower product's stock row, starts `save` (which lists the higher product first) on
 * another connection, and reports whether the higher row stayed free while the save waited.
 */
async function higherStaysFree(low: string, high: string, save: (db: Db) => Promise<unknown>): Promise<string> {
  const holder = (await pool.connect()) as Db
  const staff = (await pool.connect()) as Db
  const prober = (await pool.connect()) as Db
  let pending: Promise<unknown> | null = null
  try {
    await holder.query('begin')
    await asSystem(holder, MERCHANT_1)
    await holder.query(`select 1 from public.inventory where variant_id = $1 for update`, [low])

    await staff.query('begin')
    await asSystem(staff, MERCHANT_1)
    const pid = await value<number>(staff, 'select pg_backend_pid()')
    pending = save(staff)
    pending.catch(() => undefined)
    await waitUntilBlocked(prober, pid, pending)

    await prober.query('begin')
    await asSystem(prober, MERCHANT_1)
    const higher = await prober.query(`select 1 from public.inventory where variant_id = $1 for update nowait`, [high])
      .then(() => 'free', (e: Error) => e.message)
    await prober.query('rollback')

    await holder.query('rollback')
    await pending
    pending = null
    await staff.query('commit')
    return higher
  } finally {
    await holder.query('rollback').catch(() => undefined)
    if (pending) await pending.catch(() => undefined)
    await staff.query('rollback').catch(() => undefined)
    await prober.query('rollback').catch(() => undefined)
    holder.release()
    staff.release()
    prober.release()
  }
}

async function onHand(db: Db, variant: string): Promise<number> {
  return committed(db, () => value<number>(db, `select on_hand from public.inventory where variant_id = $1`, [variant]))
}

describe.skipIf(onEngine)('staff stock saves lock stock rows in one fixed order', () => {
  it('a bulk stock edit waiting for one product does not sit on another', async () => {
    const db = (await pool.connect()) as Db
    try {
      const [low, high] = await twoProducts(db)
      const higher = await higherStaysFree(low, high, (staff) =>
        staff.query(`select public.inventory_bulk_adjust($1, 'Stock count')`, [JSON.stringify([
          { variant_id: high, mode: 'SET', quantity: 25 }, { variant_id: low, mode: 'ADD', quantity: 3 },
        ])]))
      expect(higher).toBe('free')
      expect([await onHand(db, low), await onHand(db, high)]).toEqual([23, 25])
    } finally {
      db.release()
    }
  })

  it('receiving a purchase order waiting for one product does not sit on another', async () => {
    const db = (await pool.connect()) as Db
    try {
      const [low, high] = await twoProducts(db)
      const po = await committed(db, async () => {
        const supplier = await value<string>(db, `insert into public.suppliers(name) values ('Race Fabrics') returning id`)
        return value<{ id: string }>(db, `select to_jsonb(po) from public.admin_save_purchase_order($1) po`, [JSON.stringify({
          supplier_id: supplier, status: 'ORDERED',
          items: [{ variant_id: high, quantity: 5, unit_cost: 200 }, { variant_id: low, quantity: 4, unit_cost: 200 }],
        })])
      })
      const higher = await higherStaysFree(low, high, (staff) => staff.query(`select public.receive_purchase_order($1)`, [po.id]))
      expect(higher).toBe('free')
      expect([await onHand(db, low), await onHand(db, high)]).toEqual([24, 25])
    } finally {
      db.release()
    }
  })
})
