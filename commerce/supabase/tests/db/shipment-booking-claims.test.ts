// Booking an order with a courier's API: the order is claimed in the database before the courier is
// asked, so two bookings of one order (two staff, two tabs, a bulk booking started twice) can never
// both create a parcel at the courier. The race itself runs as real transactions on two connections,
// in a database of its own, like stock-race.test.ts.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asSystem, asUser, closePool, createTestDatabase, expectError, inTx, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

const onEngine = Boolean(process.env.CF_DB_TESTS)

let pool: pg.Pool | undefined
beforeAll(async () => {
  if (onEngine) return
  pool = new pg.Pool({ connectionString: await createTestDatabase('commerce_booking_race'), max: 4 })
}, 300_000)
afterAll(async () => {
  await pool?.end()
  await closePool()
})

/** A confirmed order ready to book, a courier, and a manager who may book. */
async function ready(db: Db) {
  const p = await createProduct(db, { price: 900, stock: 5 })
  const order = await createOrder(db, { phone: '01711500001', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
  await advanceOrder(db, order.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  const courier = await value<string>(db, `insert into public.couriers (name, provider) values ('Pathao (claims test)', 'pathao') returning id`)
  const manager = await createStaff(db, 'ORDER_MANAGER')
  return { order, courier, manager }
}

const claim = (db: Db, order: string, courier: string) => db.query(`select public.shipment_booking_claim($1, $2)`, [order, courier])
const assign = (db: Db, order: string, courier: string, tracking: string) =>
  db.query(`select public.assign_courier($1, $2, $3, null, null, $3, '{}'::jsonb)`, [order, courier, tracking])

describe('courier booking claims', () => {
  it('a second booking of an order waits for the first: refused while it runs, refused once it is booked', () =>
    inTx(async (db) => {
      const { order, courier, manager } = await ready(db)
      await asUser(db, manager)
      await claim(db, order.id, courier)
      await expectError(db, `select public.shipment_booking_claim($1, $2)`, [order.id, courier], /BOOKING_IN_PROGRESS/)
      // Another courier at the same moment: refused too.
      await asSystem(db)
      const other = await value<string>(db, `insert into public.couriers (name, provider) values ('Steadfast (claims test)', 'steadfast') returning id`)
      await asUser(db, manager)
      await expectError(db, `select public.shipment_booking_claim($1, $2)`, [order.id, other], /BOOKING_IN_PROGRESS/)

      // The parcel is saved: the claim ends, and the order counts as booked.
      await assign(db, order.id, courier, 'DT-CLAIM-1')
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.shipment_booking_claims where order_id = $1`, [order.id])).toBe(0)
      await asUser(db, manager)
      await expectError(db, `select public.shipment_booking_claim($1, $2)`, [order.id, courier], /ALREADY_BOOKED/)
    }))

  it('a refused booking releases the order at once; a booking that died lapses after 3 minutes', () =>
    inTx(async (db) => {
      const { order, courier, manager } = await ready(db)
      await asUser(db, manager)
      await claim(db, order.id, courier)
      await db.query(`select public.shipment_booking_release($1)`, [order.id])
      await claim(db, order.id, courier)
      // Another staff member cannot release someone else's booking.
      const second = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, second)
      await db.query(`select public.shipment_booking_release($1)`, [order.id])
      await expectError(db, `select public.shipment_booking_claim($1, $2)`, [order.id, courier], /BOOKING_IN_PROGRESS/)
      // Three minutes later the claim no longer holds.
      await asSystem(db)
      await db.query(`update public.shipment_booking_claims set claimed_at = now() - interval '4 minutes' where order_id = $1`, [order.id])
      await asUser(db, second)
      await claim(db, order.id, courier)
    }))

  it('needs shipments.manage, and finds only an order of the caller\'s store', () =>
    inTx(async (db) => {
      const { order, courier } = await ready(db)
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.shipment_booking_claim($1, $2)`, [order.id, courier], /PERMISSION_DENIED|shipments\.manage/)
      const store = await createMerchant(db)
      const outsider = await createStaff(db, 'OWNER', undefined, store)
      await asUser(db, outsider, 'owner@example.com', store)
      await expectError(db, `select public.shipment_booking_claim($1, $2)`, [order.id, courier], /NOT_FOUND/)
      await asSystem(db, null)
      expect(await value<number>(db, `select count(*)::int from public.shipment_booking_claims where order_id = $1`, [order.id])).toBe(0)
      await asSystem(db, MERCHANT_1)
    }))

  it.skipIf(onEngine)('two bookings of one order at the same moment: exactly one may ask the courier', async () => {
    const a = (await pool!.connect()) as Db
    const b = (await pool!.connect()) as Db
    try {
      await a.query('begin')
      const { order, courier, manager } = await ready(a)
      await a.query('commit')
      const attempt = async (db: Db) => {
        await db.query('begin')
        try {
          await asUser(db, manager)
          await claim(db, order.id, courier)
          // Holding the claim open a moment, as a real booking holds the order while it is saved.
          await db.query(`select pg_sleep(0.2)`)
          await db.query('commit')
          return 'claimed'
        } catch (e) {
          await db.query('rollback')
          return (e as Error).message
        }
      }
      const results = await Promise.all([attempt(a), attempt(b)])
      expect(results.filter((r) => r === 'claimed')).toHaveLength(1)
      expect(results.find((r) => r !== 'claimed')).toMatch(/BOOKING_IN_PROGRESS/)
    } finally {
      a.release()
      b.release()
    }
  })
})
