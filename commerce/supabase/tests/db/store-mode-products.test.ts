import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, expectError, inTx, num, value } from '../support/db'
import { createOrder, createProduct, createStaff, orderPayload } from '../support/fixtures'

afterAll(closePool)

describe('store mode', () => {
  it('owners switch the hosted store off and storefront orders are refused, staff orders still work', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const owner = await createStaff(db, 'OWNER')
      const support = await createStaff(db, 'VIEWER')

      await asUser(db, support)
      await expectError(db, `select public.admin_set_store_mode('SHOPIFY', null)`, [], /PERMISSION_DENIED/)
      await asUser(db, owner)
      await expectError(db, `select public.admin_set_store_mode('AMAZON', null)`, [], /VALIDATION/)
      await expectError(db, `select public.admin_set_store_mode('SHOPIFY', 'http://shop.example.com')`, [], /https/)
      const r = await value<Record<string, unknown>>(db, `select public.admin_set_store_mode('shopify', 'https://shop.example.com')`)
      expect(r).toEqual({ mode: 'SHOPIFY', redirect_url: 'https://shop.example.com' })

      // Visitors see the mode (to show the closed page), and the rest of the setting is kept.
      await asAnon(db)
      const cfg = await value<Record<string, any>>(db, `select public.storefront_config()`)
      expect(cfg.storefront).toMatchObject({ mode: 'SHOPIFY', redirect_url: 'https://shop.example.com' })
      expect(cfg.storefront.hero_title).toBeTruthy()

      await expectError(db, `select public._create_order($1, 'STOREFRONT')`, [JSON.stringify({})], /permission denied|PERMISSION_DENIED/)
      await asSystem(db)
      await expectError(db, `select public._create_order($1, 'STOREFRONT')`,
        [JSON.stringify(orderPayload({ items: [{ variantId: p.variantIds[0], quantity: 1 }] }))], /ORDER_BLOCKED: The online store is closed/)
      const staffOrder = await value<string>(db, `select (public._create_order($1, 'ADMIN')).status::text`, [JSON.stringify({
        customer: { full_name: 'Phone Order', phone: '01711000002' },
        shipping: { address: 'House 1, Road 2, Dhanmondi', district: 'Dhaka' },
        items: [{ variant_id: p.variantIds[0], quantity: 1 }], payment_method: 'COD',
      })])
      expect(staffOrder).toBeTruthy()

      await asUser(db, owner)
      await value(db, `select public.admin_set_store_mode('OWN', null)`)
      const placed = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(placed.status).toBe('PENDING')
      await asSystem(db)
      expect(num(await value(db, `select count(*) from public.audit_logs where action = 'store.mode'`))).toBe(2)
    }))
})

describe('product details', () => {
  it('saves extra details and categories together; the store sees everything but the internal note', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await asSystem(db)
      const [a, b] = await Promise.all(['Gifts', 'Sale'].map((n) =>
        value<string>(db, `insert into public.categories(name, slug) values ($1, lower($1) || '-' || substr(md5(random()::text), 1, 5)) returning id`, [n])))
      await asUser(db, owner)
      const id = await value<string>(db, `select (public.admin_save_product_full($1)).id`, [JSON.stringify({
        name: 'Leather Wallet', status: 'ACTIVE', price: 1200, cost_price: 450, category_id: a,
        extra_category_ids: [a, b, b, '00000000-0000-0000-0000-000000000000'],
        short_description: '  Slim bifold  ', shipping_note: 'Ships in 2 days', warranty: '6 months', admin_note: 'Supplier: Rahim',
        variants: [{ sku: 'WAL-1', title: 'Default', initial_stock: 4 }],
      })])
      await asSystem(db)
      const row = await value<Record<string, any>>(db, `select to_jsonb(p) from public.products p where id = $1`, [id])
      expect(row).toMatchObject({ short_description: 'Slim bifold', shipping_note: 'Ships in 2 days', warranty: '6 months', admin_note: 'Supplier: Rahim' })
      // The main category and unknown ids are not repeated as extras.
      expect(row.extra_category_ids).toEqual([b])

      const saleSlug = await value<string>(db, `select slug from public.categories where id = $1`, [b])
      await asAnon(db)
      const slug = row.slug
      const page = await value<Record<string, any>>(db, `select public.storefront_get_product($1)`, [slug])
      expect(page).toMatchObject({ short_description: 'Slim bifold', shipping_note: 'Ships in 2 days', warranty: '6 months' })
      expect(JSON.stringify(page)).not.toContain('Rahim')
      const list = await value<Record<string, any>>(db, `select public.storefront_list_products($1)`, [saleSlug])
      expect(list.items.map((i: any) => i.id)).toContain(id)
      await expectError(db, `select public.admin_save_product_full($1)`, [JSON.stringify({ name: 'x', price: 1 })], /PERMISSION_DENIED|permission denied/)
    }))

  it('quick edits from the list: cost, price, active toggle; stats add up', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const p = await createProduct(db, { price: 800, cost: 300, stock: 10 })
      await asSystem(db)
      await db.query(`update public.product_variants set price = 850, cost_price = 320 where id = $1`, [p.variantIds[0]])
      await asUser(db, owner)
      const before = await value<Record<string, number>>(db, `select public.admin_product_stats()`)
      const r = await value<Record<string, unknown>>(db, `select public.admin_product_quick_update($1, $2)`, [p.productId, JSON.stringify({ cost_price: 350, price: 990 })])
      expect(num(r.cost_price)).toBe(350)
      expect(num(r.price)).toBe(990)
      await asSystem(db)
      // The single variant follows the product now.
      expect(await value(db, `select public.variant_price($1)::numeric`, [p.variantIds[0]])).toBe('990.00')
      await asUser(db, owner)
      const after = await value<Record<string, number>>(db, `select public.admin_product_stats()`)
      expect(num(after.sell_value) - num(before.sell_value)).toBeCloseTo(10 * (990 - 850))
      expect(num(after.cost_value) - num(before.cost_value)).toBeCloseTo(10 * (350 - 320))

      await expectError(db, `select public.admin_product_quick_update($1, '{"price": -1}')`, [p.productId], /VALIDATION/)
      const off = await value<Record<string, unknown>>(db, `select public.admin_product_quick_update($1, '{"active": false}')`, [p.productId])
      expect(off.status).toBe('ARCHIVED')
      const on = await value<Record<string, unknown>>(db, `select public.admin_product_quick_update($1, '{"active": true}')`, [p.productId])
      expect(on.status).toBe('ACTIVE')
      const support = await createStaff(db, 'VIEWER')
      await asUser(db, support)
      await expectError(db, `select public.admin_product_quick_update($1, '{"price": 1}')`, [p.productId], /PERMISSION_DENIED/)
    }))
})
