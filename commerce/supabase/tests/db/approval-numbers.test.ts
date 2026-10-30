import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asService, asSystem, asUser, closePool, expectError, inTx, one, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff, sellOn, setSetting, transition } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

// A web order has no number of ours. It waits under its store number (Shopify #1052) or a web
// reference (W10501); when it is approved it gets the business's next number: 1000, 1001, …

interface Numbers { order_number: string; web_number: string | null }

const numbers = (db: Db, id: string) =>
  one<Numbers>(db, `select order_number, web_number from public.orders where id = $1`, [id])

async function freshCounter(db: Db, merchant = MERCHANT_1) {
  await asSystem(db, merchant)
  await db.query(`delete from public.order_counters where merchant_id = $1`, [merchant])
  // Orders already holding a number from 1000 up (seed data) would be skipped; none should.
  expect(await value<number>(db, `select count(*)::int from public.orders where merchant_id = $1 and order_number ~ '^(\\w+-)?1[0-9]{3}$'`, [merchant])).toBe(0)
}

async function shopifyOrder(db: Db, channel: string, sku: string, number: string, phone: string) {
  await asService(db)
  return value<{ status: string; order_id: string; order_number: string }>(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [channel, JSON.stringify({
    external_id: String(Math.floor(Math.random() * 1e12)), number, cancelled: false,
    customer: { name: 'Riaz Uddin', phone, email: null },
    shipping: { address: 'House 4, Road 7, Uttara', city: 'Dhaka', state: null, postal_code: null, district_hint: 'Dhaka' },
    lines: [{ external_variant_id: `ext-${sku}`, external_product_id: 'p1', sku, title: 'Shirt', variant_title: null, quantity: 1, unit_price: 990, image_url: null }],
    shipping_price: 80, discount_total: 0, total: 1070, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null, attribution: null,
  })])
}

describe('order numbers given on approval', () => {
  it('a web order waits under a web reference; approving gives 1000, 1001, … with no gaps from cancelled orders', () =>
    inTx(async (db) => {
      await freshCounter(db)
      await setSetting(db, 'store', { order_prefix: '' })
      const p = await createProduct(db, { price: 500, stock: 20 })
      const a = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const b = await createOrder(db, { phone: '01811000002', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const c = await createOrder(db, { phone: '01911000003', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(a.order_number).toMatch(/^W\d+$/)

      expect((await transition(db, a.id, 'CONFIRMED')).order_number).toBe('1000')
      expect(await numbers(db, a.id)).toEqual({ order_number: '1000', web_number: a.order_number })
      await transition(db, b.id, 'CANCELLED')
      expect((await numbers(db, b.id)).order_number).toBe(b.order_number)
      expect((await transition(db, c.id, 'CONFIRMED')).order_number).toBe('1001')

      // Once only: moving on keeps the number.
      await transition(db, a.id, 'PROCESSING')
      expect((await numbers(db, a.id)).order_number).toBe('1000')

      // The prefix goes in front of the next number; the count goes on.
      await setSetting(db, 'store', { order_prefix: 'ATH' })
      const d = await createOrder(db, { phone: '01611000004', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect((await transition(db, d.id, 'CONFIRMED')).order_number).toBe('ATH-1002')

      // The customer's web reference still finds the order on the tracking page.
      await asService(db)
      const tracked = await value<Record<string, unknown>>(db, `select public.track_order($1, $2)`, [a.order_number, '01711000001'])
      expect(tracked).toMatchObject({ order_number: '1000' })
    }))

  it('every business counts on its own, and new businesses start without a prefix', () =>
    inTx(async (db) => {
      await freshCounter(db)
      await setSetting(db, 'store', { order_prefix: '' })
      const other = await createMerchant(db)
      expect(await value(db, `select value ->> 'order_prefix' from public.settings where merchant_id = $1 and key = 'store'`, [other])).toBe('')

      const p1 = await createProduct(db, { price: 500, stock: 5 })
      const p2 = await createProduct(db, { price: 500, stock: 5, merchantId: other })
      const mine = await createOrder(db, { items: [{ variantId: p1.variantIds[0], quantity: 1 }] })
      const theirs = await createOrder(db, { merchantId: other, items: [{ variantId: p2.variantIds[0], quantity: 1 }] })
      expect((await transition(db, mine.id, 'CONFIRMED')).order_number).toBe('1000')
      await asSystem(db, other)
      const approved = await one<{ order_number: string }>(db, `select * from public._transition_order($1, 'CONFIRMED', 'test')`, [theirs.id])
      expect(approved.order_number).toBe('1000')
    }))

  it('a Shopify order keeps its store number while it waits, then gets ours; a number already in use is skipped', () =>
    inTx(async (db) => {
      await freshCounter(db)
      await setSetting(db, 'store', { order_prefix: '' })
      const sku = `APN-${Math.floor(Math.random() * 1e6)}`
      await createProduct(db, { price: 990, stock: 20, variants: [{ sku, title: 'Default', stock: 20 }] })
      await asService(db)
      const channel = await value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform: 'SHOPIFY', shop_domain: `n${Math.floor(Math.random() * 1e6)}.myshopify.com`, auth_mode: 'TOKEN' })])
      await asSystem(db)
      await db.query(`update public.sales_channels set status = 'CONNECTED' where id = $1`, [channel])
      await sellOn(db, 'SHOPIFY')

      // Two Shopify orders wait as #1001 and #1052.
      const s1 = await shopifyOrder(db, channel, sku, '#1001', '01711222331')
      const s2 = await shopifyOrder(db, channel, sku, '#1052', '01711222332')
      expect([s1.order_number, s2.order_number]).toEqual(['1001', '1052'])

      // Our count starts at 1000; 1001 is the waiting Shopify order's, so the next approval skips it.
      const variantId = await value<string>(db, `select id from public.product_variants where sku = $1`, [sku])
      const own = await createOrder(db, { items: [{ variantId, quantity: 1 }] })
      const other = await createOrder(db, { phone: '01811000009', items: [{ variantId, quantity: 1 }] })
      expect((await transition(db, own.id, 'CONFIRMED')).order_number).toBe('1000')
      expect((await transition(db, other.id, 'CONFIRMED')).order_number).toBe('1002')

      // Approving the Shopify order gives it our next number; its Shopify number stays on it.
      expect((await transition(db, s2.order_id, 'CONFIRMED')).order_number).toBe('1003')
      expect(await one(db, `select order_number, web_number, external_order_number from public.orders where id = $1`, [s2.order_id]))
        .toEqual({ order_number: '1003', web_number: '1052', external_order_number: '#1052' })

      // A waiting order may keep its own store number when that is the next one.
      await db.query(`update public.order_counters set last_number = 1000 where merchant_id = $1`, [MERCHANT_1])
      expect((await transition(db, s1.order_id, 'CONFIRMED')).order_number).toBe('1001')
    }))

  it('staff can leave the prefix empty; anything but up to 8 capitals or digits is refused', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await asSystem(db)
      const store = await value<Record<string, unknown>>(db, `select value from public.settings where merchant_id = $1 and key = 'store'`, [MERCHANT_1])
      await asUser(db, owner)
      await db.query(`select public.admin_update_setting('store', $1::jsonb)`, [JSON.stringify({ ...store, order_prefix: '' })])
      await db.query(`select public.admin_update_setting('store', $1::jsonb)`, [JSON.stringify({ ...store, order_prefix: 'ATH' })])
      await expectError(db, `select public.admin_update_setting('store', $1::jsonb)`, [JSON.stringify({ ...store, order_prefix: 'at-h' })], /order prefix/)
    }))
})
