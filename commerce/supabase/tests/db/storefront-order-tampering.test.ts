import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asService, asSystem, closePool, inTx, value, type Db } from '../support/db'
import { createProduct, inventory, orderPayload } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

/**
 * A shopper controls everything the checkout sends. The order is priced, stocked and charged by the
 * database from the store's own catalog and settings: whatever else the request carries (prices,
 * totals, statuses, another store's products, odd quantities, made-up coupons) changes nothing or is
 * refused, and a refused order leaves no order, reservation or customer behind.
 */

const num = (v: unknown) => Number(v)

async function place(db: Db, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  await asService(db, MERCHANT_1)
  return value<Record<string, unknown>>(db, `select public.place_storefront_order($1, null)`, [JSON.stringify({ idempotency_key: randomUUID(), ...payload })])
}

/** Runs a checkout that must be refused; returns the error, with every write it made rolled back. */
async function refused(db: Db, payload: Record<string, unknown>): Promise<string> {
  await db.query('savepoint t')
  try {
    await place(db, payload)
  } catch (e) {
    await db.query('rollback to savepoint t')
    return String((e as Error).message)
  }
  await db.query('rollback to savepoint t')
  return ''
}

async function order(db: Db, id: unknown) {
  await asSystem(db)
  return (await db.query(`select status, payment_status, subtotal, discount_total, delivery_charge, total_amount, amount_paid, cod_amount,
      advance_required, fraud_decision, merchant_id from public.orders where id = $1`, [id])).rows[0]
}

async function quote(db: Db, variantId: string, quantity: number) {
  await asService(db, MERCHANT_1)
  return value<Record<string, unknown>>(db, `select public.storefront_quote($1, 'Dhaka', null, 'standard', null, '01711000001')`,
    [JSON.stringify([{ variant_id: variantId, quantity }])])
}

describe('storefront checkout tampering', () => {
  it('prices the order from the catalog, whatever prices, totals or statuses the request carries', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1500, stock: 10 })
      const fair = await quote(db, p.variantIds[0], 2)
      const placed = await place(db, {
        ...orderPayload({ phone: '01711300001', items: [{ variantId: p.variantIds[0], quantity: 2, unitPrice: 1 }] }),
        subtotal: 2, total_amount: 2, discount_total: 2998, delivery_charge: 0, delivery_discount: 500,
        amount_paid: 3000, payment_status: 'PAID', status: 'DELIVERED', fraud_decision: 'ALLOW', advance_required: 0,
        merchant_id: randomUUID(),
      })
      const o = await order(db, placed.id)
      expect(num(o.subtotal)).toBe(3000)
      expect(num(o.subtotal)).toBe(num(fair.subtotal))
      expect(num(o.delivery_charge)).toBe(num(fair.delivery_charge))
      expect(num(o.total_amount)).toBe(num(fair.total))
      expect(num(o.discount_total)).toBe(0)
      expect(num(o.amount_paid)).toBe(0)
      expect(o.payment_status).not.toBe('PAID')
      expect(o.status).not.toBe('DELIVERED')
      expect(o.merchant_id).toBe(MERCHANT_1)
      // A price sent per line is ignored too.
      const lines = await db.query(`select unit_price, quantity from public.order_items where order_id = $1`, [placed.id])
      expect(lines.rows.map((r) => [num(r.unit_price), r.quantity])).toEqual([[1500, 2]])
    }))

  it("refuses another store's product, and leaves that store's stock alone", () =>
    inTx(async (db) => {
      const other = await createMerchant(db)
      const theirs = await createProduct(db, { price: 10, stock: 5, merchantId: other })
      await asSystem(db, other)
      const before = await inventory(db, theirs.variantIds[0])
      const err = await refused(db, orderPayload({ phone: '01711300002', items: [{ variantId: theirs.variantIds[0], quantity: 1 }] }))
      expect(err).toMatch(/no longer exists/)
      await asSystem(db, other)
      expect(await inventory(db, theirs.variantIds[0])).toEqual(before)
      await asSystem(db, null)
      expect(await value<number>(db, `select count(*)::int from public.orders where customer_phone = '01711300002'`)).toBe(0)
    }))

  it('refuses hidden products: draft, archived, or a switched-off variant', () =>
    inTx(async (db) => {
      for (const change of [
        `update public.products set status = 'DRAFT' where id = $1`,
        `update public.products set status = 'ARCHIVED' where id = $1`,
        `update public.product_variants set is_active = false where product_id = $1`,
      ]) {
        const p = await createProduct(db, { price: 700, stock: 5 })
        await asSystem(db)
        await db.query(change, [p.productId])
        const err = await refused(db, orderPayload({ phone: '01711300003', items: [{ variantId: p.variantIds[0], quantity: 1 }] }))
        expect(err, change).toMatch(/no longer available/)
      }
      await asSystem(db, null)
      expect(await value<number>(db, `select count(*)::int from public.orders where customer_phone = '01711300003'`)).toBe(0)
    }))

  it('refuses quantities that are zero, negative, fractional, absurd or beyond the stock', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 3 })
      for (const [quantity, why] of [[0, /at least 1/], [-1, /at least 1/], [-100, /at least 1/], [1.5, /integer/], [1e9, /at most 20/], [4, /INSUFFICIENT_STOCK/]] as const) {
        const err = await refused(db, orderPayload({ phone: '01711300004', items: [{ variantId: p.variantIds[0], quantity }] }))
        expect(err, `quantity ${quantity}`).toMatch(why)
      }
      // No order, and the stock is as it was.
      await asSystem(db)
      expect(await inventory(db, p.variantIds[0])).toMatchObject({ on_hand: 3, reserved: 0, available: 3 })
      expect(await value<number>(db, `select count(*)::int from public.orders where customer_phone = '01711300004'`)).toBe(0)
    }))

  it('never totals below zero: a mix of a real line and a negative one is refused', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 2000, stock: 5 })
      const b = await createProduct(db, { price: 1900, stock: 5 })
      const err = await refused(db, orderPayload({ phone: '01711300005', items: [{ variantId: a.variantIds[0], quantity: 1 }, { variantId: b.variantIds[0], quantity: -1 }] }))
      expect(err).toMatch(/at least 1/)
    }))

  it('gives no discount for a made-up coupon', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1200, stock: 5 })
      const err = await refused(db, orderPayload({ phone: '01711300006', coupon: 'FREE100', items: [{ variantId: p.variantIds[0], quantity: 1 }] }))
      expect(err).toMatch(/COUPON_INVALID/)
    }))

  it('the same line twice is priced and stocked as its sum', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 800, stock: 3 })
      const err = await refused(db, orderPayload({ phone: '01711300007', items: [{ variantId: p.variantIds[0], quantity: 2 }, { variantId: p.variantIds[0], quantity: 2 }] }))
      // Four of three in stock: refused (never two lines of two that each "fit").
      expect(err).toMatch(/INSUFFICIENT_STOCK/)
      const ok = await place(db, orderPayload({ phone: '01711300008', items: [{ variantId: p.variantIds[0], quantity: 1 }, { variantId: p.variantIds[0], quantity: 2 }] }))
      expect(num((await order(db, ok.id)).subtotal)).toBe(2400)
      await asSystem(db)
      expect((await inventory(db, p.variantIds[0])).available).toBe(0)
    }))
})
