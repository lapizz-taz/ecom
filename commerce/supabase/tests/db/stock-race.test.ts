// Two shoppers buying the last unit at the same moment: exactly one order may take it. This runs as
// real transactions on two connections, in a database of its own (so nothing it commits can touch
// the counts other tests read), built from every migration like the shared one.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asService, asSystem, createTestDatabase, MERCHANT_1, value, type Db } from '../support/db'
import { createProduct, inventory, orderPayload } from '../support/fixtures'

/** The Cloudflare engine runs one statement at a time in one process: there is no race to test there. */
const onEngine = Boolean(process.env.CF_DB_TESTS)

let pool: pg.Pool

beforeAll(async () => {
  if (onEngine) return
  pool = new pg.Pool({ connectionString: await createTestDatabase('commerce_stock_race'), max: 4 })
}, 300_000)
afterAll(async () => { await pool?.end() })

/** One storefront checkout in its own transaction, as the checkout function runs it. */
async function checkout(db: Db, variantId: string, phone: string): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  await db.query('begin')
  try {
    await asService(db)
    const check = await value<string>(db, `select (public.record_fraud_check($1)).id`, [JSON.stringify({ phone, provider: 'internal', provider_counts: {} })])
    const placed = await value<{ id: string }>(db, `select public.place_storefront_order($1, $2)`,
      [JSON.stringify(orderPayload({ phone, name: `Shopper ${phone.slice(-3)}`, items: [{ variantId, quantity: 1 }] })), check])
    await db.query('commit')
    return { ok: true, id: placed.id }
  } catch (e) {
    await db.query('rollback')
    return { ok: false, error: (e as Error).message }
  }
}

describe.skipIf(onEngine)('the last unit, bought twice at once', () => {
  it('goes to one shopper; the other is told it is out of stock; stock never goes below zero', async () => {
    const a = (await pool.connect()) as Db
    const b = (await pool.connect()) as Db
    try {
      await a.query('begin')
      const { variantIds: [variantId] } = await createProduct(a, { name: 'Last One', price: 900, cost: 300, stock: 1 })
      await a.query('commit')

      const [ra, rb] = await Promise.all([checkout(a, variantId, '01711000101'), checkout(b, variantId, '01811000102')])
      const won = [ra, rb].filter((r) => r.ok)
      const lost = [ra, rb].filter((r) => !r.ok) as Array<{ ok: false; error: string }>
      expect(won).toHaveLength(1)
      expect(lost).toHaveLength(1)
      expect(lost[0].error).toMatch(/INSUFFICIENT_STOCK|stock/i)

      await a.query('begin')
      await asSystem(a, MERCHANT_1)
      expect(await inventory(a, variantId)).toMatchObject({ on_hand: 1, reserved: 1, available: 0 })
      expect(await value<number>(a, `select count(*)::int from public.order_items where variant_id = $1`, [variantId])).toBe(1)
      await a.query('commit')
    } finally {
      a.release()
      b.release()
    }
  })
})
