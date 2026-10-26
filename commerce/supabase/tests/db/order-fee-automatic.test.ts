// The fee for each approved order, when nobody approves the order by hand. A store whose balance is
// empty cannot approve orders in the admin (the "refuse" policy), but an order the system approves by
// itself must still go through: a shopper's checkout, a ৳55 advance the gateway reports, a customer's
// Confirm tap. Those are recorded as owed (UNPAID), as with the "let it through" policy, instead of
// failing the checkout, losing the payment, or ignoring the customer. Also: two orders approved at the
// same moment use the month's free orders once, and "orders this month" starts at midnight in the
// store's time zone.
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asService, asSystem, asUser, closePool, createTestDatabase, inTx, one, value, type Db } from '../support/db'
import { createOrder, createPlatformStaff, createProduct, createStaff, placeOrder, setSetting, transition } from '../support/fixtures'

afterAll(closePool)

const onEngine = Boolean(process.env.CF_DB_TESTS)

async function feeOn(db: Db, over: Record<string, unknown> = {}) {
  const superId = await createPlatformStaff(db, 'SUPER_ADMIN')
  await asUser(db, superId, 'staff@platform.example', null)
  await db.query(`select public.platform_order_fee_settings_save($1, 'Charging approved orders')`,
    [JSON.stringify({ enabled: true, fee: 1.5, on_empty: 'BLOCK', free_per_month: 0, ...over })])
  return superId
}

async function charge(db: Db, orderId: string) {
  await asSystem(db)
  return (await db.query<{ charge: string; fee: string }>(`select charge, fee::text from public.order_fee_charges where order_id = $1`, [orderId])).rows[0]
}

describe('order fee: orders approved by the system with an empty balance', () => {
  it('a shopper\'s checkout that is approved at once still goes through; the fee is owed', () =>
    inTx(async (db) => {
      await feeOn(db)
      await asSystem(db)
      await setSetting(db, 'orders', { require_confirmation: false })
      const p = await createProduct(db, { price: 500, stock: 10 })

      const o = await placeOrder(db, { phone: '01711000951', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(o.status).toBe('CONFIRMED')
      expect(await charge(db, o.id)).toEqual({ charge: 'UNPAID', fee: '1.50' })

      // Staff approving by hand are still refused until the balance is topped up.
      await setSetting(db, 'orders', { require_confirmation: true })
      const waiting = await placeOrder(db, { phone: '01711000952', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const agent = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, agent)
      const refused = await value<{ approved: number; failed: Array<{ error: string }> }>(db, `select public.approve_orders($1)`, [[waiting.id]])
      expect(refused.approved).toBe(0)
      expect(refused.failed[0].error).toMatch(/costs 1\.50 Tk and the balance is 0\.00 Tk/)
    }))

  it('a ৳55 advance the gateway reports is recorded and the order confirmed; the fee is owed', () =>
    inTx(async (db) => {
      await feeOn(db)
      const p = await createProduct(db, { price: 600, stock: 5 })
      const order = await createOrder(db, { phone: '01711000953', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`update public.orders set advance_required = 55, advance_type = 'FIXED' where id = $1`, [order.id])
      await transition(db, order.id, 'ADVANCE_REQUIRED')
      await asService(db)
      const payment = await one<{ reference: string }>(db,
        `select reference from public.start_order_payment($1, $2, 'ADVANCE', 'bkash', 'BKASH')`, [order.order_number, '01711000953'])

      const r = await value<{ status: string }>(db,
        `select public.confirm_payment($1, 'bkash', 'TRX-FEE1', 55, 'bkash:trx:TRX-FEE1', 'test', '{}'::jsonb, true)`, [payment.reference])
      expect(r.status).toBe('succeeded')
      await asSystem(db)
      expect(await one(db, `select status::text, amount_paid::text from public.orders where id = $1`, [order.id])).toEqual({ status: 'CONFIRMED', amount_paid: '55.00' })
      expect(await value(db, `select status::text from public.payments where reference = $1`, [payment.reference])).toBe('SUCCEEDED')
      expect(await charge(db, order.id)).toEqual({ charge: 'UNPAID', fee: '1.50' })
    }))

  it('a customer\'s Confirm tap approves the order when the store asks for that; the fee is owed', () =>
    inTx(async (db) => {
      await feeOn(db)
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await db.query(`select public.messaging_settings_save('{"confirm": {"auto_approve": true}}')`)
      const p = await createProduct(db, { price: 600, stock: 5 })
      const o = await createOrder(db, { phone: '01711000954', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asService(db)
      const token = await value<string>(db, `select public._order_reply_token($1)`, [o.id])

      expect(await value(db, `select public.order_reply_apply($1, 'confirm', 'EMAIL', null)`, [token])).toMatchObject({ result: 'confirmed' })
      await asSystem(db)
      expect(await value(db, `select status::text from public.orders where id = $1`, [o.id])).toBe('CONFIRMED')
      expect(await charge(db, o.id)).toEqual({ charge: 'UNPAID', fee: '1.50' })
    }))

  it('"orders this month" starts at midnight in the store\'s time zone, not in UTC', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 300, stock: 10 })
      const after = await createOrder(db, { phone: '01711000955', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const before = await createOrder(db, { phone: '01711000956', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`update public.orders set created_at = (date_trunc('month', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka') + make_interval(hours => $2) where id = $1`, [after.id, 1])
      await db.query(`update public.orders set created_at = (date_trunc('month', now() at time zone 'Asia/Dhaka') at time zone 'Asia/Dhaka') + make_interval(hours => $2) where id = $1`, [before.id, -1])
      await db.query(`update public.orders set created_at = now() - interval '400 days' where merchant_id = $1 and id not in ($2, $3)`, [MERCHANT_1, after.id, before.id])
      expect(await value<Record<string, number>>(db, `select public.merchant_usage($1)`, [MERCHANT_1])).toMatchObject({ orders_per_month: 1 })
    }))
})

let pool: pg.Pool
beforeAll(async () => {
  if (onEngine) return
  pool = new pg.Pool({ connectionString: await createTestDatabase('commerce_order_fee_race'), max: 4 })
}, 300_000)
afterAll(async () => { await pool?.end() })

describe.skipIf(onEngine)('order fee: two approvals at the same moment', () => {
  it('the month\'s one free order is used once', async () => {
    const setup = (await pool.connect()) as Db
    const a = (await pool.connect()) as Db
    const b = (await pool.connect()) as Db
    const watcher = (await pool.connect()) as Db
    try {
      await setup.query('begin')
      const superId = await feeOn(setup, { free_per_month: 1 })
      await asUser(setup, superId, 'staff@platform.example', null)
      await setup.query(`select public.platform_credit_adjust($1, 'BALANCE', 300, 'ADJUSTMENT', 'Paid in cash at the office', null, $2)`, [MERCHANT_1, randomUUID()])
      const agent = await createStaff(setup, 'ORDER_MANAGER')
      const p = await createProduct(setup, { price: 500, stock: 10 })
      const [x, y] = [
        await placeOrder(setup, { phone: '01711000961', items: [{ variantId: p.variantIds[0], quantity: 1 }] }),
        await placeOrder(setup, { phone: '01711000962', items: [{ variantId: p.variantIds[0], quantity: 1 }] }),
      ]
      await setup.query('commit')

      // One manager's approval is being saved when another approves a second order.
      await a.query('begin')
      await asUser(a, agent)
      expect(await value(a, `select (public.approve_orders($1)) ->> 'approved'`, [[x.id]])).toBe('1')
      await b.query('begin')
      await asUser(b, agent)
      const pid = await value<number>(b, 'select pg_backend_pid()')
      const second = b.query(`select public.approve_orders($1) as r`, [[y.id]])
      second.catch(() => undefined)
      for (let i = 0; i < 100; i++) {
        if (await value<boolean>(watcher, `select coalesce((select wait_event_type = 'Lock' from pg_stat_activity where pid = $1), false)`, [pid])) break
        await new Promise((r) => setTimeout(r, 50))
      }
      await a.query('commit')
      expect((await second).rows[0].r).toMatchObject({ approved: 1 })
      await b.query('commit')

      await asSystem(watcher)
      const charges = (await watcher.query<{ charge: string }>(`select charge from public.order_fee_charges where order_id = any($1) order by charge`, [[x.id, y.id]])).rows
      expect(charges.map((c) => c.charge)).toEqual(['CHARGED', 'FREE'])
    } finally {
      for (const c of [setup, a, b]) await c.query('rollback').catch(() => undefined)
      for (const c of [setup, a, b, watcher]) c.release()
    }
  })
})
