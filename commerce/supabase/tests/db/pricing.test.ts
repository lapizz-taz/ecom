import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, closePool, expectError, inTx, num, value } from '../support/db'
import { createOrder, createProduct, setSetting } from '../support/fixtures'

afterAll(closePool)

type Quote = {
  subtotal: number
  coupon_discount: number
  delivery_charge: number
  delivery_discount: number
  total: number
  cost_total: number
  lines: Array<{ line_subtotal: number; discount_amount: number; line_total: number; unit_price: number }>
  delivery_zone: { name: string } | null
  stock_errors: unknown[]
  coupon: { valid: boolean; message: string } | null
}

async function quote(db: Parameters<typeof asSystem>[0], items: unknown[], district: string, extra: Record<string, unknown> = {}): Promise<Quote> {
  await asSystem(db)
  return value<Quote>(db, `select public.calculate_order_quote($1, $2, $3, $4, $5, $6)`, [
    JSON.stringify(items),
    district,
    extra.area ?? null,
    extra.method ?? 'standard',
    extra.coupon ?? null,
    extra.phone ?? null,
  ])
}

describe('order total calculation', () => {
  it('computes subtotal, zone delivery charge and total from database prices', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 500, cost: 200 })
      const b = await createProduct(db, { price: 300, cost: 100 })
      const q = await quote(db, [
        { variant_id: a.variantIds[0], quantity: 2 },
        { variant_id: b.variantIds[0], quantity: 1 },
      ], 'Dhaka')
      expect(num(q.subtotal)).toBe(1300)
      expect(num(q.delivery_charge)).toBe(80)
      expect(num(q.total)).toBe(1380)
      expect(num(q.cost_total)).toBe(500)
      expect(q.delivery_zone?.name).toBe('Inside Dhaka')
    }))

  it('merges duplicate lines of the same variant', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 250 })
      const q = await quote(db, [
        { variant_id: a.variantIds[0], quantity: 1 },
        { variant_id: a.variantIds[0], quantity: 2 },
      ], 'Dhaka')
      expect(q.lines).toHaveLength(1)
      expect(num(q.subtotal)).toBe(750)
    }))

  it('uses variant price over product price', () =>
    inTx(async (db) => {
      const p = await createProduct(db, {
        price: 1000,
        variants: [
          { sku: 'VAR-S-' + Date.now(), title: 'S' },
          { sku: 'VAR-XL-' + Date.now(), title: 'XL', price: 1200 },
        ],
      })
      const q = await quote(db, [{ variant_id: p.variantIds[1], quantity: 1 }], 'Dhaka')
      expect(num(q.subtotal)).toBe(1200)
    }))

  it('rejects quantities above the configured maximum', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 100, stock: 100 })
      await setSetting(db, 'orders', { max_quantity_per_item: 3 })
      await expectError(db, `select public.calculate_order_quote($1, 'Dhaka')`,
        [JSON.stringify([{ variant_id: a.variantIds[0], quantity: 4 }])], /at most 3/)
    }))

  it('reports stock shortfalls without failing the quote', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 100, stock: 1 })
      const q = await quote(db, [{ variant_id: a.variantIds[0], quantity: 2 }], 'Dhaka')
      expect(q.stock_errors).toHaveLength(1)
    }))
})

describe('delivery charge calculation', () => {
  it('resolves area, district and default zones', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 100 })
      await asSystem(db)
      await db.query(`insert into public.delivery_zones(name, districts, areas, charge, return_charge, sort_order)
                      values ('Savar area', '{}', '{Savar}', 95, 40, 0)`)
      const items = [{ variant_id: a.variantIds[0], quantity: 1 }]
      expect(num((await quote(db, items, 'Gazipur')).delivery_charge)).toBe(110)
      expect(num((await quote(db, items, 'Rajshahi')).delivery_charge)).toBe(130)
      expect(num((await quote(db, items, 'Dhaka', { area: 'savar' })).delivery_charge)).toBe(95)
    }))

  it('adds the delivery method surcharge and rejects inactive methods', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 100 })
      const items = [{ variant_id: a.variantIds[0], quantity: 1 }]
      await expectError(db, `select public.calculate_order_quote($1, 'Dhaka', null, 'express')`, [JSON.stringify(items)], /not available/)
      await setSetting(db, 'delivery', {
        methods: [
          { code: 'standard', name: 'Standard', extra_charge: 0, active: true },
          { code: 'express', name: 'Express', extra_charge: 60, active: true },
        ],
      })
      expect(num((await quote(db, items, 'Dhaka', { method: 'express' })).delivery_charge)).toBe(140)
    }))

  it('applies the free delivery threshold', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 600 })
      await setSetting(db, 'delivery', { free_delivery_threshold: 1000 })
      const q = await quote(db, [{ variant_id: a.variantIds[0], quantity: 2 }], 'Dhaka')
      expect(num(q.delivery_charge)).toBe(80)
      expect(num(q.delivery_discount)).toBe(80)
      expect(num(q.total)).toBe(1200)
    }))
})

describe('discount calculation', () => {
  it('allocates a coupon discount across lines so line totals add up', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 333 })
      const b = await createProduct(db, { price: 667 })
      const c = await createProduct(db, { price: 100 })
      await asSystem(db)
      await db.query(`insert into public.coupons(code, discount_type, discount_value) values ('TENOFF', 'PERCENTAGE', 10)`)
      const q = await quote(db, [
        { variant_id: a.variantIds[0], quantity: 1 },
        { variant_id: b.variantIds[0], quantity: 1 },
        { variant_id: c.variantIds[0], quantity: 1 },
      ], 'Dhaka', { coupon: 'tenoff' })
      expect(num(q.coupon_discount)).toBe(110)
      const allocated = q.lines.reduce((s, l) => s + num(l.discount_amount), 0)
      expect(allocated).toBeCloseTo(110, 2)
      for (const l of q.lines) expect(num(l.line_total)).toBeCloseTo(num(l.line_subtotal) - num(l.discount_amount), 2)
      expect(num(q.total)).toBe(1100 - 110 + 80)
    }))

  it('stores totals on the order and ignores client-supplied prices', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 900, cost: 300 })
      const order = await createOrder(db, { items: [{ variantId: a.variantIds[0], quantity: 2, unitPrice: 1 }] })
      expect(num(order.subtotal)).toBe(1800)
      expect(num(order.total_amount)).toBe(1880)
      expect(num(order.cod_amount)).toBe(1880)
      expect(num(order.cost_total)).toBe(600)
      expect(order.order_number).toMatch(/^ISO-\d{5,}$/)
    }))

  it('honours a staff manual discount and delivery override, capped at the subtotal', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 500 })
      await asSystem(db)
      const order = await value<Record<string, string>>(db, `select to_jsonb(o) from public._create_order($1, 'ADMIN') o`, [
        JSON.stringify({
          customer: { full_name: 'Phone Order', phone: '01811000001' },
          shipping: { address: 'Road 5, Uttara', district: 'Dhaka' },
          items: [{ variant_id: a.variantIds[0], quantity: 1, unit_price: 450 }],
          manual_discount: 50,
          delivery_charge: 60,
        }),
      ])
      expect(num(order.subtotal)).toBe(450)
      expect(num(order.discount_total)).toBe(50)
      expect(num(order.delivery_charge)).toBe(60)
      expect(num(order.total_amount)).toBe(460)
    }))

  it('is idempotent for the same checkout key', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 100, stock: 5 })
      const key = 'checkout-' + Date.now()
      const first = await createOrder(db, { items: [{ variantId: a.variantIds[0], quantity: 1 }], idempotencyKey: key })
      const second = await createOrder(db, { items: [{ variantId: a.variantIds[0], quantity: 1 }], idempotencyKey: key })
      expect(second.id).toBe(first.id)
      expect(await value(db, `select reserved from public.inventory where variant_id = $1`, [a.variantIds[0]])).toBe(1)
    }))

  it('validates phone numbers with the configured pattern', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 100 })
      await expectError(db, `select public._create_order($1, 'STOREFRONT')`, [
        JSON.stringify({
          customer: { full_name: 'X Y', phone: '12345' },
          shipping: { address: 'Somewhere 1', district: 'Dhaka' },
          items: [{ variant_id: a.variantIds[0], quantity: 1 }],
        }),
      ], /valid mobile number/)
      // +880 international format is normalised.
      const order = await createOrder(db, { phone: '+880 1711-000222', items: [{ variantId: a.variantIds[0], quantity: 1 }] })
      expect(await value(db, `select customer_phone from public.orders where id = $1`, [order.id])).toBe('01711000222')
    }))
})
