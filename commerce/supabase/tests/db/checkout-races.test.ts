// Two checkouts at the same moment, as real transactions on two connections, in a database of its
// own (like stock-race.test.ts): a limited coupon is never used past its limit, and a new customer's
// two orders (two tabs, or two orders of a store's webhook burst) both land on one customer record.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asService, asSystem, createTestDatabase, MERCHANT_1, value, type Db } from '../support/db'
import { createProduct, orderPayload } from '../support/fixtures'

const onEngine = Boolean(process.env.CF_DB_TESTS)

let pool: pg.Pool

beforeAll(async () => {
  if (onEngine) return
  pool = new pg.Pool({ connectionString: await createTestDatabase('commerce_checkout_race'), max: 4 })
}, 300_000)
afterAll(async () => { await pool?.end() })

type Result = { ok: true; id: string } | { ok: false; error: string }

/**
 * One storefront checkout as the checkout function makes it: the fraud check and the order are two
 * calls, each its own transaction.
 */
async function checkout(db: Db, variantId: string, phone: string, coupon: string | null = null): Promise<Result> {
  let check: string
  await db.query('begin')
  try {
    await asService(db)
    check = await value<string>(db, `select (public.record_fraud_check($1)).id`, [JSON.stringify({ phone, provider: 'internal', provider_counts: {} })])
    await db.query('commit')
  } catch (e) {
    await db.query('rollback')
    return { ok: false, error: `fraud check: ${(e as Error).message}` }
  }
  await db.query('begin')
  try {
    await asService(db)
    const placed = await value<{ id: string }>(db, `select public.place_storefront_order($1, $2)`,
      [JSON.stringify(orderPayload({ phone, coupon, name: `Shopper ${phone.slice(-3)}`, items: [{ variantId, quantity: 1 }] })), check])
    await db.query('commit')
    return { ok: true, id: placed.id }
  } catch (e) {
    await db.query('rollback')
    return { ok: false, error: (e as Error).message }
  }
}

/** Runs setup in a committed transaction on one connection. */
async function committed<T>(db: Db, work: () => Promise<T>): Promise<T> {
  await db.query('begin')
  try {
    const out = await work()
    await db.query('commit')
    return out
  } catch (e) {
    await db.query('rollback')
    throw e
  }
}

async function withTwo(test: (a: Db, b: Db) => Promise<void>) {
  const a = (await pool.connect()) as Db
  const b = (await pool.connect()) as Db
  try {
    await test(a, b)
  } finally {
    a.release()
    b.release()
  }
}

async function coupon(db: Db, values: Record<string, unknown>) {
  await asSystem(db, MERCHANT_1)
  const cols = Object.keys(values)
  await db.query(`insert into public.coupons(${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values))
}

async function count(db: Db, sql: string, args: unknown[]) {
  return committed(db, async () => {
    await asSystem(db, MERCHANT_1)
    return value<number>(db, sql, args)
  })
}

describe.skipIf(onEngine)('checkouts at the same moment', () => {
  it('a coupon with one use left goes to one of two shoppers', () =>
    withTwo(async (a, b) => {
      const { variantIds: [v] } = await committed(a, async () => {
        const p = await createProduct(a, { name: 'Race Tee A', price: 1000, cost: 300, stock: 10 })
        await coupon(a, { code: 'LASTONE', discount_type: 'FIXED', discount_value: 100, usage_limit: 1 })
        return p
      })
      const results = await Promise.all([checkout(a, v, '01711700001', 'LASTONE'), checkout(b, v, '01811700002', 'LASTONE')])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect((results.find((r) => !r.ok) as { error: string }).error).toMatch(/COUPON_INVALID/)
      expect(await count(a, `select count(*)::int from public.orders where coupon_code ilike 'LASTONE'`, [])).toBe(1)
    }))

  it('a once-per-customer coupon is used once when a known customer checks out twice at once', () =>
    withTwo(async (a, b) => {
      const { variantIds: [v] } = await committed(a, async () => {
        const p = await createProduct(a, { name: 'Race Tee B', price: 1000, cost: 300, stock: 10 })
        await coupon(a, { code: 'ONCEEACH', discount_type: 'PERCENTAGE', discount_value: 10, per_customer_limit: 1 })
        return p
      })
      // The customer exists from an earlier order without the coupon.
      expect((await checkout(a, v, '01711700003')).ok).toBe(true)
      const results = await Promise.all([checkout(a, v, '01711700003', 'ONCEEACH'), checkout(b, v, '01711700003', 'ONCEEACH')])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect((results.find((r) => !r.ok) as { error: string }).error).toMatch(/COUPON_INVALID/)
      expect(await count(a, `select count(*)::int from public.orders where coupon_code ilike 'ONCEEACH'`, [])).toBe(1)
    }))

  it('a once-per-customer coupon is used once by a new customer checking out twice at once', () =>
    withTwo(async (a, b) => {
      const { variantIds: [v] } = await committed(a, async () => {
        const p = await createProduct(a, { name: 'Race Tee C', price: 1000, cost: 300, stock: 10 })
        await coupon(a, { code: 'FIRSTTIME', discount_type: 'PERCENTAGE', discount_value: 10, per_customer_limit: 1 })
        return p
      })
      const results = await Promise.all([checkout(a, v, '01711700004', 'FIRSTTIME'), checkout(b, v, '01711700004', 'FIRSTTIME')])
      // The second waits for the first one's customer, then sees the coupon is used.
      expect(results.filter((r) => r.ok)).toHaveLength(1)
      expect((results.find((r) => !r.ok) as { error: string }).error).toMatch(/COUPON_INVALID/)
      expect(await count(a, `select count(*)::int from public.orders where coupon_code ilike 'FIRSTTIME'`, [])).toBe(1)
      expect(await count(a, `select count(*)::int from public.customers where phone like '%1711700004'`, [])).toBe(1)
    }))

  it("a known customer's two orders at once are both placed", () =>
    withTwo(async (a, b) => {
      const { variantIds: [v] } = await committed(a, () => createProduct(a, { name: 'Race Tee E', price: 800, cost: 200, stock: 10 }))
      expect((await checkout(a, v, '01711700006')).ok).toBe(true)
      const results = await Promise.all([checkout(a, v, '01711700006'), checkout(b, v, '01711700006')])
      expect(results.map((r) => (r.ok ? 'placed' : r.error))).toEqual(['placed', 'placed'])
    }))

  it("a new customer's two orders at once are both placed, on one customer record", () =>
    withTwo(async (a, b) => {
      const { variantIds: [v] } = await committed(a, () => createProduct(a, { name: 'Race Tee D', price: 800, cost: 200, stock: 10 }))
      const results = await Promise.all([checkout(a, v, '01711700005'), checkout(b, v, '01711700005')])
      expect(results.map((r) => (r.ok ? 'placed' : r.error))).toEqual(['placed', 'placed'])
      expect(await count(a, `select count(*)::int from public.customers where phone like '%1711700005'`, [])).toBe(1)
    }))
})
