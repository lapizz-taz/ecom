// The gateway's own notice and the shopper's browser coming back usually confirm an advance payment
// at the same moment. They run here as real transactions on two connections, in a database of their
// own (like stock-race.test.ts): one payment is counted once on the order, however the two meet, and
// the job that cancels orders whose advance never came does not cancel one that was just paid.
import pg from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { asService, asSystem, createTestDatabase, MERCHANT_1, num, one, value, type Db } from '../support/db'
import { createOrder, createProduct, transition } from '../support/fixtures'

const onEngine = Boolean(process.env.CF_DB_TESTS)

let pool: pg.Pool

beforeAll(async () => {
  if (onEngine) return
  pool = new pg.Pool({ connectionString: await createTestDatabase('commerce_payment_race'), max: 4 })
}, 300_000)
afterAll(async () => { await pool?.end() })

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

/** An order waiting for a ৳55 advance, and the payment the checkout started for it. */
async function waitingForAdvance(db: Db, phone: string) {
  return committed(db, async () => {
    const p = await createProduct(db, { price: 600, stock: 5 })
    const order = await createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
    await asSystem(db)
    await db.query(`update public.orders set advance_required = 55, advance_type = 'FIXED' where id = $1`, [order.id])
    await transition(db, order.id, 'ADVANCE_REQUIRED')
    await asService(db)
    const payment = await one<{ id: string; reference: string }>(db,
      `select id, reference from public.start_order_payment($1, $2, 'ADVANCE', 'bkash', 'BKASH')`, [order.order_number, phone])
    return { order, payment }
  })
}

/** One confirmation in its own transaction, as the payment webhook or the return page makes it. */
async function confirm(db: Db, reference: string, trx: string, event: string): Promise<string> {
  await db.query('begin')
  try {
    await asService(db)
    const r = await value<{ status: string }>(db, `select public.confirm_payment($1, 'bkash', $2, 55, $3, 'test', '{}'::jsonb, true)`, [reference, trx, event])
    await db.query('commit')
    return r.status
  } catch (e) {
    await db.query('rollback')
    return `error: ${(e as Error).message}`
  }
}

async function paidOnOrder(db: Db, orderId: string) {
  return committed(db, async () => {
    await asSystem(db, MERCHANT_1)
    const o = await one<Record<string, unknown>>(db, `select status, amount_paid from public.orders where id = $1`, [orderId])
    const lines = await value<number>(db, `select count(*)::int from public.order_payments where order_id = $1`, [orderId])
    return { status: String(o.status), paid: num(o.amount_paid), lines }
  })
}

/** Returns once the connection waits for a lock, or its work has ended (whichever is first). */
async function waitingOrDone(watcher: Db, pid: number, work: Promise<unknown>): Promise<void> {
  let done = false
  work.then(() => { done = true }, () => { done = true })
  for (let i = 0; i < 100 && !done; i++) {
    if (await value<boolean>(watcher, `select coalesce((select wait_event_type = 'Lock' from pg_stat_activity where pid = $1), false)`, [pid])) return
    await new Promise((r) => setTimeout(r, 50))
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

describe.skipIf(onEngine)('an advance payment confirmed twice at the same moment', () => {
  it('the same notice twice (gateway retry): counted once', () =>
    withTwo(async (a, b) => {
      const { order, payment } = await waitingForAdvance(a, '01711800001')
      const results = await Promise.all([
        confirm(a, payment.reference, 'TRX-R1', 'bkash:trx:TRX-R1'),
        confirm(b, payment.reference, 'TRX-R1', 'bkash:trx:TRX-R1'),
      ])
      expect(results.filter((r) => r === 'succeeded')).toHaveLength(1)
      expect(results.some((r) => r.startsWith('error'))).toBe(false)
      expect(await paidOnOrder(a, order.id)).toEqual({ status: 'CONFIRMED', paid: 55, lines: 1 })
    }))

  it('a payment confirmed while the unpaid-advance job runs: the paid order is not cancelled', () =>
    withTwo(async (a, b) => {
      const { order, payment } = await waitingForAdvance(a, '01711800003')
      await committed(a, async () => {
        await asSystem(a, MERCHANT_1)
        await a.query(`update public.orders set advance_due_at = now() - interval '1 minute' where id = $1`, [order.id])
      })
      // The payment is being confirmed (the order is locked, not yet saved) when the job reads its list.
      await a.query('begin')
      await asService(a)
      await a.query(`select public.confirm_payment($1, 'bkash', 'TRX-R3', 55, 'bkash:trx:TRX-R3', 'test', '{}'::jsonb, true)`, [payment.reference])
      await b.query('begin')
      await asService(b)
      const pid = await value<number>(b, 'select pg_backend_pid()')
      const job = b.query(`select public.expire_unpaid_advance_orders() as n`)
      job.catch(() => undefined)
      const watcher = (await pool.connect()) as Db
      try {
        await waitingOrDone(watcher, pid, job)
      } finally {
        watcher.release()
      }
      await a.query('commit')
      const expired = (await job).rows[0].n
      await b.query('commit')
      expect(expired).toBe(0)
      expect(await paidOnOrder(a, order.id)).toEqual({ status: 'CONFIRMED', paid: 55, lines: 1 })
    }))

  it('the gateway notice and the return page, for one transaction: counted once', () =>
    withTwo(async (a, b) => {
      const { order, payment } = await waitingForAdvance(a, '01711800002')
      const results = await Promise.all([
        confirm(a, payment.reference, 'TRX-R2', 'bkash:trx:TRX-R2'),
        confirm(b, payment.reference, 'TRX-R2', 'bkash:callback:TRX-R2'),
      ])
      expect(results.filter((r) => r === 'succeeded')).toHaveLength(1)
      expect(results.some((r) => r.startsWith('error'))).toBe(false)
      expect(await paidOnOrder(a, order.id)).toEqual({ status: 'CONFIRMED', paid: 55, lines: 1 })
    }))
})
