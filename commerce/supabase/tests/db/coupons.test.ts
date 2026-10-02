import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff, orderPayload, transition } from '../support/fixtures'

afterAll(closePool)

async function coupon(db: Db, values: Record<string, unknown>): Promise<void> {
  await asSystem(db)
  const cols = Object.keys(values)
  await db.query(
    `insert into public.coupons(${cols.join(', ')}) values (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    Object.values(values),
  )
}

async function evaluate(db: Db, code: string, subtotal: number, phone: string | null = null, delivery = 80) {
  await asSystem(db)
  return value<Record<string, unknown>>(db, `select public.evaluate_coupon($1, $2, $3, $4)`, [code, subtotal, phone, delivery])
}

describe('coupon validation', () => {
  it('caps percentage discounts at max_discount', () =>
    inTx(async (db) => {
      await coupon(db, { code: 'BIG20', discount_type: 'PERCENTAGE', discount_value: 20, max_discount: 150 })
      const r = await evaluate(db, 'big20', 2000)
      expect(r.valid).toBe(true)
      expect(num(r.discount_amount)).toBe(150)
    }))

  it('never discounts more than the subtotal for fixed coupons', () =>
    inTx(async (db) => {
      await coupon(db, { code: 'FLAT500', discount_type: 'FIXED', discount_value: 500 })
      expect(num((await evaluate(db, 'FLAT500', 300)).discount_amount)).toBe(300)
    }))

  it('turns free-delivery coupons into a delivery discount', () =>
    inTx(async (db) => {
      await coupon(db, { code: 'SHIPFREE', discount_type: 'FREE_DELIVERY', discount_value: 0 })
      const r = await evaluate(db, 'shipfree', 500, null, 130)
      expect(num(r.discount_amount)).toBe(0)
      expect(num(r.delivery_discount)).toBe(130)
    }))

  it('rejects coupons below the minimum order value, expired or not started', () =>
    inTx(async (db) => {
      await coupon(db, { code: 'MIN1000', discount_type: 'FIXED', discount_value: 100, min_order_value: 1000 })
      await coupon(db, { code: 'OLD', discount_type: 'FIXED', discount_value: 100, ends_at: '2020-01-01' })
      await coupon(db, { code: 'SOON', discount_type: 'FIXED', discount_value: 100, starts_at: '2999-01-01' })
      await coupon(db, { code: 'OFF', discount_type: 'FIXED', discount_value: 100, is_active: false })
      expect((await evaluate(db, 'MIN1000', 999)).reason).toBe('MIN_ORDER')
      expect((await evaluate(db, 'OLD', 5000)).reason).toBe('EXPIRED')
      expect((await evaluate(db, 'SOON', 5000)).reason).toBe('NOT_STARTED')
      expect((await evaluate(db, 'OFF', 5000)).reason).toBe('NOT_FOUND')
      expect((await evaluate(db, 'NOPE', 5000)).reason).toBe('NOT_FOUND')
    }))

  it('enforces the total usage limit and frees a use when the order is cancelled', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, stock: 10 })
      await coupon(db, { code: 'ONCE', discount_type: 'FIXED', discount_value: 100, usage_limit: 1 })
      const first = await createOrder(db, { phone: '01711000101', coupon: 'ONCE', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(num(first.discount_total)).toBe(100)
      await expectError(db, `select public._create_order($1, 'STOREFRONT')`,
        [JSON.stringify(orderPayload({ phone: '01711000102', coupon: 'ONCE', items: [{ variantId: p.variantIds[0], quantity: 1 }] }))],
        /usage limit/)
      await transition(db, first.id, 'CANCELLED', 'customer changed mind')
      expect(await value(db, `select usage_count from public.coupons where code = 'ONCE'`)).toBe(0)
      const again = await createOrder(db, { phone: '01711000102', coupon: 'ONCE', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(num(again.discount_total)).toBe(100)
    }))

  it('lets staff edit a coupon but never its usage counter', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, stock: 10 })
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await db.query(`insert into public.coupons(code, discount_type, discount_value, usage_limit, usage_count) values ('STAFF1', 'FIXED', 50, 1, 99)`)
      expect(await value(db, `select usage_count from public.coupons where code = 'STAFF1'`)).toBe(0)
      expect(await value(db, `select created_by from public.coupons where code = 'STAFF1'`)).toBe(admin)
      await db.query(`update public.coupons set description = 'Staff discount' where code = 'STAFF1'`)
      await createOrder(db, { coupon: 'STAFF1', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(await value(db, `select usage_count from public.coupons where code = 'STAFF1'`)).toBe(1)
      await asUser(db, admin)
      await expectError(db, `update public.coupons set usage_count = 0 where code = 'STAFF1'`, [], /counted automatically/)
    }))

  it('enforces the per-customer limit by phone', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, stock: 10 })
      await coupon(db, { code: 'WELCOME', discount_type: 'PERCENTAGE', discount_value: 10, per_customer_limit: 1 })
      await createOrder(db, { phone: '01711000201', coupon: 'welcome', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect((await evaluate(db, 'WELCOME', 1000, '+8801711000201')).reason).toBe('CUSTOMER_LIMIT')
      expect((await evaluate(db, 'WELCOME', 1000, '01711000202')).valid).toBe(true)
    }))

  it('rejects an invalid coupon at order creation instead of silently dropping it', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, stock: 10 })
      await expectError(db, `select public._create_order($1, 'STOREFRONT')`,
        [JSON.stringify(orderPayload({ coupon: 'DOESNOTEXIST', items: [{ variantId: p.variantIds[0], quantity: 1 }] }))],
        /COUPON_INVALID/)
    }))

  it('recalculates a percentage coupon when staff change items', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, stock: 10 })
      await coupon(db, { code: 'PCT10', discount_type: 'PERCENTAGE', discount_value: 10 })
      const order = await createOrder(db, { coupon: 'PCT10', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(num(order.discount_total)).toBe(100)
      await asSystem(db)
      const updated = await value<Record<string, string>>(db, `select to_jsonb(o) from public.admin_set_order_items($1, $2) o`,
        [order.id, JSON.stringify([{ variant_id: p.variantIds[0], quantity: 3 }])])
      expect(num(updated.subtotal)).toBe(3000)
      expect(num(updated.discount_total)).toBe(300)
      expect(num(updated.total_amount)).toBe(3000 - 300 + 80)
    }))
})
