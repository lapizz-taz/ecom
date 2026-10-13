import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, inTx, one, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const PHONE = '01712555666'

/** Records a check the way the edge functions do (service role). */
async function record(db: Db, input: Record<string, unknown>): Promise<string> {
  await asService(db)
  return (await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [JSON.stringify({ phone: PHONE, ...input })])).id
}
const courier = (extra: Record<string, unknown> = {}) => ({
  provider: 'courier_history', providers: ['internal', 'courier_history'], status: 'SUCCESS',
  provider_counts: { total: 10, delivered: 9, returned: 1 },
  provider_response: { courier_history: { couriers: [{ courier: 'pathao', orders: 10, delivered: 9, cancelled: 1 }], ...extra } },
})
async function checkOf(db: Db, orderId: string): Promise<string | null> {
  await asSystem(db)
  return value<string | null>(db, `select fraud_check_id from public.orders where id = $1`, [orderId])
}
/** Back-dates a check (append-only table: triggers paused for the test). */
async function age(db: Db, id: string, minutes: number) {
  await asSystem(db)
  await db.query(`set local session_replication_role = replica`)
  await db.query(`update public.fraud_checks set created_at = now() - make_interval(mins => $2) where id = $1`, [id, minutes])
  await db.query(`set local session_replication_role = origin`)
}

describe('a fresh courier check becomes the record of the customer\'s open orders', () => {
  it('links open orders, leaves finished ones, ignores internal-only and failed checks', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 20 })
      const open = await createOrder(db, { phone: PHONE, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const done = await createOrder(db, { phone: PHONE, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const other = await createOrder(db, { phone: '01712555667', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`set local session_replication_role = replica`)
      await db.query(`update public.orders set status = 'DELIVERED' where id = $1`, [done.id])
      await db.query(`set local session_replication_role = origin`)
      const doneBefore = await checkOf(db, done.id)

      await record(db, { provider: 'internal', providers: ['internal'] })
      await record(db, { provider: 'courier_history', providers: ['courier_history'], status: 'ERROR', error: 'BD Courier did not answer in time' })
      expect(await checkOf(db, open.id)).toBe(open.fraud_check_id ?? null)

      const good = await record(db, courier())
      expect(await checkOf(db, open.id)).toBe(good)
      expect(await checkOf(db, done.id)).toBe(doneBefore)
      expect(await checkOf(db, other.id)).toBe(other.fraud_check_id ?? null)
    }))

  it('keeps a complete record rather than take a partial one, moves to a newer complete one, never goes back', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 20 })
      const order = await createOrder(db, { phone: PHONE, items: [{ variantId: p.variantIds[0], quantity: 1 }] })

      const complete = await record(db, courier())
      expect(await checkOf(db, order.id)).toBe(complete)

      // A recheck that could not reach BD Courier does not replace it.
      const partial = await record(db, courier({ source_notes: ['BD Courier: Could not reach BD Courier'] }))
      expect(await checkOf(db, order.id)).toBe(complete)

      // A newer complete check does.
      await age(db, complete, 5)
      await age(db, partial, 3)
      const newer = await record(db, courier())
      expect(await checkOf(db, order.id)).toBe(newer)

      // A partial check is still better than none or an internal-only one.
      const later = await createOrder(db, { phone: '01712555668', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asService(db)
      const onlyPathao = (await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [JSON.stringify({
        phone: '01712555668', ...courier({ source_notes: ['BD Courier: Could not reach BD Courier'] }),
      })])).id
      expect(await checkOf(db, later.id)).toBe(onlyPathao)
    }))

  it('the order page shows the complete record from the last day over a newer partial one', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'OWNER')
      const p = await createProduct(db, { price: 500, stock: 20 })
      const order = await createOrder(db, { phone: PHONE, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const complete = await record(db, courier())
      await age(db, complete, 2)
      await record(db, courier({ source_notes: ['BD Courier: Could not reach BD Courier'] }))

      await asUser(db, staff)
      const shown = await value<{ check: { id: string } }>(db, `select public.admin_order_customer_record($1)`, [order.id])
      expect(shown.check.id).toBe(complete)

      // A day later the newest one is shown again, whatever it holds.
      await age(db, complete, 26 * 60)
      await asUser(db, staff)
      const later = await value<{ check: { id: string } }>(db, `select public.admin_order_customer_record($1)`, [order.id])
      expect(later.check.id).not.toBe(complete)
    }))
})
