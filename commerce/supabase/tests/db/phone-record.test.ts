import { afterAll, describe, expect, it } from 'vitest'
import { asService, asUser, closePool, expectError, inTx, one, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const PHONE = '01712444555'

async function record(db: Db, phone: string, counts = { total: 10, delivered: 8, returned: 2 }): Promise<string> {
  await asService(db)
  return (await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [JSON.stringify({
    phone, provider: 'courier_history', providers: ['internal', 'courier_history'], status: 'SUCCESS', provider_counts: counts,
    provider_response: { courier_history: { couriers: [{ courier: 'pathao', orders: counts.total, delivered: counts.delivered, cancelled: counts.returned }] } },
  })])).id
}

describe('delivery record by phone (New Order, incomplete checkouts)', () => {
  it('gives the record of a typed phone to staff who create orders, before any order exists', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 10 })
      await createOrder(db, { phone: PHONE, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const check = await record(db, PHONE)

      await asUser(db, await createStaff(db, 'ORDER_MANAGER'))
      const r = await one<{ r: any }>(db, `select public.admin_phone_customer_record($1) as r`, ['+8801712444555'])
      expect(r.r.phone).toBe(PHONE)
      expect(r.r.check.id).toBe(check)
      expect(r.r.check.delivered).toBe(8)
      expect(r.r.ours.total).toBe(1)
      expect(r.r.policy.good_min).toBe(80)
      expect(r.r).not.toHaveProperty('shipment')
    }))

  it('is refused without order access, and for a number that is not complete', () =>
    inTx(async (db) => {
      const stock = await createStaff(db, 'INVENTORY_MANAGER')
      const orders = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, stock)
      await expectError(db, `select public.admin_phone_customer_record($1)`, [PHONE], /PERMISSION_DENIED/)
      await expectError(db, `select public.admin_phone_courier_summaries($1)`, [[PHONE]], /PERMISSION_DENIED|orders.view/)
      await asUser(db, orders)
      await expectError(db, `select public.admin_phone_customer_record($1)`, ['0171'], /VALIDATION/)
    }))

  it('summarises the latest rate per phone for a page of incomplete checkouts, null when never checked', () =>
    inTx(async (db) => {
      await record(db, PHONE)
      await record(db, '01712444556', { total: 4, delivered: 1, returned: 3 })
      await asUser(db, await createStaff(db, 'CALL'))
      const r = await one<{ r: any }>(db, `select public.admin_phone_courier_summaries($1) as r`, [[PHONE, '01712444556', '01712444557']])
      expect(r.r[PHONE].delivered).toBe(8)
      expect(r.r[PHONE].completed).toBe(10)
      expect(r.r['01712444556'].delivered).toBe(1)
      expect(r.r['01712444557']).toBeNull()
    }))

  it('keeps the order page record the same (with its parcel) on top of the phone record', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 10 })
      const order = await createOrder(db, { phone: PHONE, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const check = await record(db, PHONE)
      await asUser(db, await createStaff(db, 'CALL'))
      const r = await one<{ r: any }>(db, `select public.admin_order_customer_record($1) as r`, [order.id])
      expect(r.r.check.id).toBe(check)
      expect(r.r.ours.total).toBe(1)
      expect(r.r).toHaveProperty('shipment')
    }))
})
