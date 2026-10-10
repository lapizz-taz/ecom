import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const visitor = () => randomUUID().replace(/-/g, '')
/** Moves a cart's last activity back in time (as if the visitor left). */
async function age(db: Db, cartId: string, minutes: number) {
  await asSystem(db)
  await db.query(`update public.store_carts set last_activity_at = now() - make_interval(mins => $2) where id = $1`, [cartId, minutes])
}

describe('our store: abandoned carts', () => {
  it('keeps the cart with catalog prices, lists it once abandoned, links the checkout and counts the order as recovered', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ORDER_MANAGER')
      const viewer = await createStaff(db, 'VIEWER')
      const p = await createProduct(db, { price: 450, stock: 10 })
      const v = visitor()

      // The browser says the price is 1; the server uses the catalog. Unknown ids are dropped.
      await asAnon(db)
      const id = await value<string>(db, `select public.storefront_cart_sync($1, 'sess-12345678', $2, $3)`, [v,
        JSON.stringify([{ variant_id: p.variantIds[0], quantity: 2, price: 1 }, { variant_id: randomUUID(), quantity: 1 }, { variant_id: 'nope', quantity: 1 }]),
        JSON.stringify({ visitor_id: v, last_touch: { at: new Date().toISOString(), landing: '/', params: { utm_source: 'facebook', utm_medium: 'paid' } } })])
      expect(id).toBeTruthy()
      await asSystem(db)
      const cart = await value<Record<string, any>>(db, `select to_jsonb(c) from public.store_carts c where id = $1`, [id])
      expect(cart).toMatchObject({ status: 'ACTIVE', item_count: 2, subtotal: 900, reached_checkout: false })
      expect(cart.items).toHaveLength(1)
      expect(cart.items[0]).toMatchObject({ quantity: 2, unit_price: 450 })

      // Same visitor again: the same cart is updated (not a second one).
      await age(db, id, 1)
      await asAnon(db)
      expect(await value<string>(db, `select public.storefront_cart_sync($1, 'sess-12345678', $2)`, [v, JSON.stringify([{ variant_id: p.variantIds[0], quantity: 3 }])])).toBe(id)

      // Still fresh: active, not abandoned. After the wait: abandoned.
      await asUser(db, staff)
      expect((await value<Record<string, any>>(db, `select public.admin_store_carts('abandoned')`)).items.find((c: any) => c.id === id)).toBeUndefined()
      await age(db, id, 120)
      await asUser(db, staff)
      const list = await value<Record<string, any>>(db, `select public.admin_store_carts('abandoned')`)
      expect(list.items.find((c: any) => c.id === id)).toMatchObject({ item_count: 3, subtotal: 1350, phone: null })
      expect(list.stats.abandoned).toBeGreaterThanOrEqual(1)
      expect(list.top_products.find((t: any) => t.product_id === p.productId)).toMatchObject({ carts: 1, quantity: 3 })

      // The recovery link restores the same items, with stock as the limit.
      await asAnon(db)
      const restored = await value<any[]>(db, `select public.storefront_cart_restore($1)`, [id])
      expect(restored).toEqual([expect.objectContaining({ variantId: p.variantIds[0], quantity: 3, price: 450, maxQuantity: 10 })])

      // Staff log a call; viewers can't.
      await asUser(db, viewer)
      await expectError(db, `select public.admin_update_store_cart($1, 'CONTACTED', 'x')`, [id], /orders.update/)
      await asUser(db, staff)
      const called = await value<Record<string, any>>(db, `select to_jsonb(public.admin_update_store_cart($1, 'CONTACTED', 'No answer'))`, [id])
      expect(called).toMatchObject({ contacted: true, contact_count: 1, status: 'ACTIVE' })

      // Reaching checkout gives us the phone.
      await asSystem(db)
      await db.query(`select public.capture_checkout_lead($1)`, [JSON.stringify({ visitor_id: v, phone: '01733000111', customer_name: 'Rafi',
        items: [{ variant_id: p.variantIds[0], quantity: 3 }], subtotal: 1350, total: 1410 })])
      const atCheckout = await value<Record<string, any>>(db, `select to_jsonb(c) from public.store_carts c where id = $1`, [id])
      expect(atCheckout).toMatchObject({ reached_checkout: true, phone: '01733000111', customer_name: 'Rafi' })
      expect(atCheckout.lead_id).toBeTruthy()

      // The order arrives (any route): the cart is converted and, as it had been abandoned, recovered.
      await age(db, id, 90)
      const o = await createOrder(db, { phone: '01733000111', items: [{ variantId: p.variantIds[0], quantity: 3 }] })
      const done = await value<Record<string, any>>(db, `select to_jsonb(c) from public.store_carts c where id = $1`, [id])
      expect(done).toMatchObject({ status: 'CONVERTED', order_id: o.id, recovered: true })
      await asAnon(db)
      expect(await value<any[]>(db, `select public.storefront_cart_restore($1)`, [id])).toEqual([])

      // The anonymous role can't read the table directly.
      await expectError(db, `select count(*) from public.store_carts`, [], /permission denied/)
    }))

  it('an emptied cart is closed; tracking can be switched off', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100, stock: 5 })
      const v = visitor()
      await asAnon(db)
      const id = await value<string>(db, `select public.storefront_cart_sync($1, null, $2)`, [v, JSON.stringify([{ variant_id: p.variantIds[0], quantity: 1 }])])
      await age(db, id, 1)
      await asAnon(db)
      expect(await value<string | null>(db, `select public.storefront_cart_sync($1, null, '[]')`, [v])).toBeNull()
      await asSystem(db)
      expect(await value<string>(db, `select status from public.store_carts where id = $1`, [id])).toBe('EMPTIED')
      await db.query(`update public.settings set value = value || '{"track_carts": false}' where key = 'orders'`)
      await asAnon(db)
      expect(await value<string | null>(db, `select public.storefront_cart_sync($1, null, $2)`, [visitor(), JSON.stringify([{ variant_id: p.variantIds[0], quantity: 1 }])])).toBeNull()
    }))

  it('staff create the order from a cart: linked, with the cart\'s ad source', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ORDER_MANAGER')
      const p = await createProduct(db, { price: 300, stock: 5 })
      const v = visitor()
      await asAnon(db)
      const id = await value<string>(db, `select public.storefront_cart_sync($1, null, $2, $3)`, [v, JSON.stringify([{ variant_id: p.variantIds[0], quantity: 1 }]),
        JSON.stringify({ visitor_id: v, last_touch: { at: new Date().toISOString(), landing: '/', params: { utm_source: 'facebook', utm_medium: 'paid' } } })])
      await age(db, id, 300)
      const o = await createOrder(db, { phone: '01744000222', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, staff)
      const linked = await value<Record<string, any>>(db, `select to_jsonb(public.admin_link_store_cart($1, $2))`, [id, o.id])
      expect(linked).toMatchObject({ status: 'CONVERTED', recovered: true, order_id: o.id })
      await asSystem(db)
      expect(await value<string>(db, `select channel from public.order_attributions where order_id = $1`, [o.id])).toBeTruthy()
    }))
})

describe('Shopify abandoned checkouts', () => {
  it('stores fetched checkouts once, marks completed ones recovered and keeps staff follow-up', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asSystem(db)
      const channel = await value<string>(db, `insert into public.sales_channels(platform, name, shop_domain, status) values ('SHOPIFY', 'Test shop', $1, 'CONNECTED') returning id`,
        [`t${randomUUID().slice(0, 8)}.myshopify.com`])
      const row = (id: string, extra: Record<string, unknown> = {}) => ({
        id: `gid://shopify/AbandonedCheckout/${id}`, legacy_id: id, name: `#${id}`, recovery_url: `https://shop/checkouts/${id}/recover`,
        customer_name: 'Mina', phone: '+8801755000333', email: 'mina@example.com', city: 'Dhaka', country: 'Bangladesh',
        items: [{ title: 'Belt', quantity: 1, price: 900 }], item_count: 1, subtotal: 900, total: 960, currency: 'BDT',
        created_at: new Date(Date.now() - 3_600_000).toISOString(), updated_at: new Date().toISOString(), completed_at: null, ...extra,
      })
      expect(await value<number>(db, `select public.channel_abandoned_upsert($1, $2)`, [channel, JSON.stringify([row('1'), row('2')])])).toBe(2)

      await asUser(db, staff)
      await expectError(db, `select public.channel_abandoned_upsert($1, '[]')`, [channel], /permission denied|PERMISSION_DENIED/i)
      let list = await value<Record<string, any>>(db, `select public.admin_shopify_abandoned('open')`)
      const first = list.items.find((x: any) => x.legacy_id === '1')
      expect(first).toMatchObject({ phone: '01755000333', total: 960, status: 'OPEN', store_name: 'Test shop', country: 'Bangladesh' })
      // Bulk: dismiss #2 from the list (and only that one).
      const second = list.items.find((x: any) => x.legacy_id === '2')
      expect(await value<number>(db, `select public.admin_bulk_shopify_abandoned($1, 'DISMISSED')`, [[second.id]])).toBe(1)
      expect((await value<Record<string, any>>(db, `select public.admin_shopify_abandoned('dismissed')`)).items.map((x: any) => x.legacy_id)).toContain('2')
      await db.query(`select public.admin_bulk_shopify_abandoned($1, 'OPEN')`, [[second.id]])
      expect(list.channels.find((c: any) => c.id === channel).synced_at).toBeTruthy()
      await db.query(`select public.admin_update_shopify_abandoned($1, 'CONTACTED', 'Will order tomorrow')`, [first.id])

      // Next fetch: #1 completed on Shopify, #2 unchanged. No duplicates; the call log stays.
      await asSystem(db)
      await db.query(`select public.channel_abandoned_upsert($1, $2)`, [channel, JSON.stringify([row('1', { completed_at: new Date().toISOString() }), row('2')])])
      expect(await value<number>(db, `select count(*)::int from public.shopify_abandoned_checkouts where channel_id = $1`, [channel])).toBe(2)
      await asUser(db, staff)
      list = await value<Record<string, any>>(db, `select public.admin_shopify_abandoned('recovered')`)
      expect(list.items.find((x: any) => x.legacy_id === '1')).toMatchObject({ status: 'RECOVERED', follow_up: 'CONTACTED', contact_count: 1 })
      expect(list.stats.recovered_30d).toBeGreaterThanOrEqual(1)

      // A failed fetch is recorded on the store, not hidden.
      await asSystem(db)
      await db.query(`select public.channel_abandoned_upsert($1, null, 'Shopify refused: read_orders')`, [channel])
      await asUser(db, staff)
      list = await value<Record<string, any>>(db, `select public.admin_shopify_abandoned('all')`)
      expect(list.channels.find((c: any) => c.id === channel).error).toMatch(/read_orders/)
      expect((await value<Record<string, any>>(db, `select public.abandoned_counts()`)).shopify).toBeGreaterThanOrEqual(0)
    }))
})
