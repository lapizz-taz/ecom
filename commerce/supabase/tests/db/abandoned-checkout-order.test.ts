import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

type Draft = {
  id: string; customer_name: string; phone: string; email: string; address: string; district: string | null; order_id: string | null
  items: Array<{ title: string; variant: string | null; quantity: number; variant_id: string | null }>
}

/** A Shopify store with Sunset I (M linked to Shopify variant 111, L found by its SKU) and one abandoned checkout. */
async function setup(db: Db) {
  const sku = `SUN-L-${randomUUID().slice(0, 6)}`
  const p = await createProduct(db, { price: 1860, variants: [{ sku: `SUN-M-${randomUUID().slice(0, 6)}`, title: 'M', stock: 5 }, { sku, title: 'L', stock: 5 }] })
  const [m, l] = p.variantIds
  await asSystem(db)
  const channel = await value<string>(db, `insert into public.sales_channels(platform, name, shop_domain, status) values ('SHOPIFY', 'Atheron', $1, 'CONNECTED') returning id`,
    [`t${randomUUID().slice(0, 8)}.myshopify.com`])
  await db.query(`insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id) values ($1, '111', '900', $2)`, [channel, m])
  const legacy = String(Math.floor(Math.random() * 1e12))
  await db.query(`select public.channel_abandoned_upsert($1, $2)`, [channel, JSON.stringify([{
    id: `gid://shopify/AbandonedCheckout/${legacy}`, legacy_id: legacy, name: `#${legacy}`, recovery_url: 'https://shop/recover',
    customer_name: 'Nuraz bin Ahmed', phone: '01322048489', email: 'nuraz@example.com', address: 'House 12, Road 4, Dhanmondi', city: 'Dhaka', country: 'Bangladesh',
    items: [
      { title: 'Sunset I', variant: 'M', sku: null, quantity: 1, price: 1860, external_variant_id: '111' },
      { title: 'Sunset I', variant: 'L', sku, quantity: 2, price: 1860, external_variant_id: '222' },
      { title: 'Gift wrap', variant: null, sku: null, quantity: 1, price: 50, external_variant_id: '333' },
    ],
    item_count: 4, subtotal: 5630, total: 5710, currency: 'BDT', created_at: new Date(Date.now() - 3_600_000).toISOString(), completed_at: null,
  }])])
  const id = await value<string>(db, `select id from public.shopify_abandoned_checkouts where channel_id = $1`, [channel])
  return { id, m, l, channel }
}

describe('Creating the order from a Shopify or WooCommerce abandoned checkout', () => {
  it('fills New order: customer, address, district, and the items matched by variant link or SKU', () =>
    inTx(async (db) => {
      const s = await setup(db)
      await asUser(db, await createStaff(db, 'ORDER_MANAGER'))
      const d = await value<Draft>(db, `select public.admin_abandoned_checkout_draft($1)`, [s.id])
      expect(d).toMatchObject({ customer_name: 'Nuraz bin Ahmed', phone: '01322048489', email: 'nuraz@example.com', address: 'House 12, Road 4, Dhanmondi', order_id: null })
      expect(d.district).toBe('Dhaka')
      expect(d.items.map((i) => [i.variant, i.quantity, i.variant_id])).toEqual([['M', 1, s.m], ['L', 2, s.l], [null, 1, null]])
    }))

  it('once the order is created, the checkout counts as recovered, remembers the order and stays recovered after the next fetch', () =>
    inTx(async (db) => {
      const s = await setup(db)
      const staff = await createStaff(db, 'ORDER_MANAGER')
      const order = await createOrder(db, { phone: '01322048489', items: [{ variantId: s.m, quantity: 1 }] })
      await asUser(db, staff)
      await db.query(`select public.admin_link_abandoned_checkout($1, $2)`, [s.id, order.id])
      let list = await value<Record<string, any>>(db, `select public.admin_shopify_abandoned('recovered')`)
      expect(list.items.find((x: any) => x.id === s.id)).toMatchObject({ status: 'RECOVERED', order_id: order.id })
      // Another order cannot take the same checkout.
      const other = await createOrder(db, { phone: '01322048489', items: [{ variantId: s.l, quantity: 1 }] })
      await asUser(db, staff)
      await expectError(db, `select public.admin_link_abandoned_checkout($1, $2)`, [s.id, other.id], /already became another order/)
      // Shopify still calls it abandoned: the next fetch keeps it recovered.
      await asSystem(db)
      const legacy = await value<string>(db, `select legacy_id from public.shopify_abandoned_checkouts where id = $1`, [s.id])
      await db.query(`select public.channel_abandoned_upsert($1, $2)`, [s.channel, JSON.stringify([{ id: `gid://shopify/AbandonedCheckout/${legacy}`, legacy_id: legacy, total: 5710, items: [], completed_at: null }])])
      await asUser(db, staff)
      list = await value<Record<string, any>>(db, `select public.admin_shopify_abandoned('recovered')`)
      expect(list.items.find((x: any) => x.id === s.id)).toMatchObject({ status: 'RECOVERED', order_id: order.id })
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.order_status_history where order_id = $1 and event = 'FROM_ABANDONED_CHECKOUT'`, [order.id])).toBe(1)
    }))

  it('needs orders.create, and another business cannot see the checkout', () =>
    inTx(async (db) => {
      const s = await setup(db)
      await asUser(db, await createStaff(db, 'VIEWER'))
      await expectError(db, `select public.admin_abandoned_checkout_draft($1)`, [s.id], /PERMISSION_DENIED|permission/i)
      const otherShop = await createMerchant(db)
      await asUser(db, await createStaff(db, 'OWNER', undefined, otherShop), 'user@example.com', otherShop)
      await expectError(db, `select public.admin_abandoned_checkout_draft($1)`, [s.id], /not found/)
    }))
})
