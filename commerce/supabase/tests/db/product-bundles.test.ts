import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, closePool, inTx, num, one, value, type Db } from '../support/db'
import { createOrder, createProduct } from '../support/fixtures'

// Bundles / quantity breaks (the product page block): the price the customer sees is the price charged.

afterAll(closePool)

const TIERS = [
  { quantity: '1', title: '1 piece', percent: '0' },
  { quantity: '2', title: '2 pieces', badge: 'Most popular', percent: '10' },
  { quantity: '3', title: '3 pieces', percent: '15' },
]

/** Publishes the theme's product page blocks (what Publish in the theme builder saves). */
async function publishBlocks(db: Db, blocks: unknown[]) {
  await asSystem(db)
  await db.query(`update public.settings set value = jsonb_set(value, '{theme}', coalesce(value -> 'theme', '{}') || jsonb_build_object('product_page', jsonb_build_object('blocks', $1::jsonb)))
    where key = 'storefront' and merchant_id = public.current_merchant_id()`, [JSON.stringify(blocks)])
}
const bundles = (settings: Record<string, unknown> = {}, enabled = true) => ({ id: 'b1', type: 'bundles', enabled, settings: { scope: 'all', tiers: TIERS, ...settings } })

async function quote(db: Db, items: Array<{ variant_id: string; quantity: number }>) {
  await asAnon(db)
  return value<Record<string, any>>(db, `select public.storefront_quote($1, 'Dhaka')`, [JSON.stringify(items)])
}

describe('bundles / quantity breaks', () => {
  it('buying 2 or 3 lowers the unit price by the option’s percent, all options of a product counted together', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, variants: [{ sku: 'BX-S', title: 'S' }, { sku: 'BX-M', title: 'M' }] })
      await publishBlocks(db, [{ id: 'buttons', type: 'buttons', enabled: true, settings: {} }, bundles()])
      const one1 = await quote(db, [{ variant_id: p.variantIds[0], quantity: 1 }])
      expect(num(one1.subtotal)).toBe(1000)
      expect(num(one1.bundle_savings)).toBe(0)
      const two = await quote(db, [{ variant_id: p.variantIds[0], quantity: 2 }])
      expect(num(two.lines[0].unit_price)).toBe(900)
      expect(num(two.lines[0].regular_unit_price)).toBe(1000)
      expect(num(two.lines[0].bundle_percent)).toBe(10)
      expect(num(two.subtotal)).toBe(1800)
      expect(num(two.bundle_savings)).toBe(200)
      // One S and two M: three of the product, so the 3-piece price for both lines.
      const mixed = await quote(db, [{ variant_id: p.variantIds[0], quantity: 1 }, { variant_id: p.variantIds[1], quantity: 2 }])
      expect(mixed.lines.map((l: any) => num(l.unit_price))).toEqual([850, 850])
      expect(num(mixed.subtotal)).toBe(2550)
      // More than the largest option keeps its price.
      expect(num((await quote(db, [{ variant_id: p.variantIds[0], quantity: 5 }])).lines[0].unit_price)).toBe(850)
    }))

  it('the order is charged the bundle price (items, subtotal and total)', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000, stock: 10 })
      await publishBlocks(db, [bundles()])
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      expect(num(order.subtotal)).toBe(1800)
      expect(num(order.total_amount)).toBe(1800 + num(order.delivery_charge) - num(order.delivery_discount))
      await asSystem(db)
      const item = await one<{ unit_price: string; line_total: string }>(db, `select unit_price, line_total from public.order_items where order_id = $1`, [order.id])
      expect(num(item.unit_price)).toBe(900)
      expect(num(item.line_total)).toBe(1800)
    }))

  it('nothing changes when the block is off, in a draft only, for another category, or for staff', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000 })
      const line = [{ variant_id: p.variantIds[0], quantity: 3 }]
      await publishBlocks(db, [bundles({}, false)])
      expect(num((await quote(db, line)).subtotal)).toBe(3000)
      // Saved as a draft (storefront_draft) but not published.
      await publishBlocks(db, [])
      await asSystem(db)
      await db.query(`insert into public.settings(key, value) values ('storefront_draft', $1::jsonb)
        on conflict (merchant_id, key) do update set value = excluded.value`, [JSON.stringify({ theme: { product_page: { blocks: [bundles()] } } })])
      expect(num((await quote(db, line)).subtotal)).toBe(3000)
      // A block for one category only.
      await publishBlocks(db, [bundles({ scope: 'category', category: 'no-such-category' })])
      expect(num((await quote(db, line)).subtotal)).toBe(3000)
      // Staff quotes keep the regular price.
      await publishBlocks(db, [bundles()])
      expect(num((await quote(db, line)).subtotal)).toBe(2550)
      await asSystem(db)
      expect(num((await value<Record<string, any>>(db, `select public.calculate_order_quote($1, 'Dhaka', null, 'standard', null, null, true, false)`, [JSON.stringify(line)])).subtotal)).toBe(3000)
    }))

  it('odd options are ignored and the discount never goes past 90%', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 1000 })
      await publishBlocks(db, [bundles({ tiers: [{ quantity: 'two', percent: '50' }, { quantity: '2', percent: '95' }, { quantity: '2', percent: '5' }, { quantity: '60', percent: '20' }] })])
      expect(num((await quote(db, [{ variant_id: p.variantIds[0], quantity: 2 }])).lines[0].unit_price)).toBe(100)
      await publishBlocks(db, [bundles({ tiers: [{ quantity: '2', percent: '10%' }] })])
      expect(num((await quote(db, [{ variant_id: p.variantIds[0], quantity: 2 }])).lines[0].unit_price)).toBe(1000)
    }))
})
