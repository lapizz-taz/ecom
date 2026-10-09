import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asService, asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { createProduct, createStaff, inventory } from '../support/fixtures'

afterAll(closePool)

type Result = { status: string; order_id?: string; order_number?: string; error?: string; import_id?: string }

async function channel(db: Db, platform = 'SHOPIFY', domain = 'mystore.myshopify.com'): Promise<string> {
  await asService(db)
  return value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform, shop_domain: domain, auth_mode: 'TOKEN' })])
}

async function ingest(db: Db, channelId: string, order: Record<string, unknown>, via = 'WEBHOOK'): Promise<Result> {
  await asService(db)
  return value<Result>(db, `select public.channel_ingest_order($1, $2, $3)`, [channelId, JSON.stringify(order), via])
}

const order = (over: Record<string, unknown> = {}) => ({
  external_id: '5001', number: '#1001', cancelled: false,
  customer: { name: 'Rina Akter', phone: '+880 1712-000801', email: null },
  shipping: { address: 'House 9, Road 2, Mirpur 10', city: 'Dhaka', state: null, postal_code: '1216', district_hint: 'Dhaka' },
  lines: [{ external_variant_id: 'v-777', external_product_id: 'p-70', sku: null, title: 'Canvas Tote', variant_title: 'Black', quantity: 2, unit_price: 750, image_url: null }],
  shipping_price: 120, discount_total: 100, total: 1520, paid_amount: 0, currency: 'BDT', gateway: 'Cash on Delivery (COD)', note: 'Call first',
  attribution: { first_touch: null, last_touch: { at: '2026-10-08T09:55:00Z', landing: '/products/tote?utm_source=facebook&utm_medium=paid&utm_campaign=Eid&fbclid=abc', referrer: 'https://m.facebook.com/', params: { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'Eid', fbclid: 'abc' } } },
  ...over,
})

describe('sales channels: importing orders', () => {
  it('imports a Shopify order once, with its prices, delivery, discount and ad source', () =>
    inTx(async (db) => {
      const c = await channel(db)
      const r = await ingest(db, c, order())
      expect(r.status).toBe('IMPORTED')
      await asSystem(db)
      const o = await value<Record<string, unknown>>(db, `select to_jsonb(o) from public.orders o where id = $1`, [r.order_id])
      expect(o).toMatchObject({ source: 'API', status: 'PENDING', payment_method: 'COD', customer_phone: '01712000801', shipping_district: 'Dhaka',
        sales_channel_id: c, external_order_id: '5001', external_order_number: '#1001', customer_note: 'Call first' })
      expect(num(o.subtotal)).toBe(1500)
      expect(num(o.delivery_charge)).toBe(120)
      expect(num(o.discount_total)).toBe(100)
      expect(num(o.total_amount)).toBe(1520)
      // Their product became a draft here that tracks no stock (the store keeps it), linked for next time.
      const p = await value<Record<string, unknown>>(db, `select jsonb_build_object('status', p.status, 'track', p.track_inventory, 'sku', v.sku)
        from public.order_items i join public.products p on p.id = i.product_id join public.product_variants v on v.id = i.variant_id where i.order_id = $1`, [r.order_id])
      expect(p).toEqual({ status: 'DRAFT', track: false, sku: 'SHOP-v777' })
      expect(await value(db, `select source from public.order_attributions where order_id = $1`, [r.order_id])).toBe('Facebook Ads')
      expect(await value(db, `select body from public.order_notes where order_id = $1 and kind = 'NOTE'`, [r.order_id])).toContain('Imported from Shopify #1001')

      // The same order again (webhook retry, or a sync) changes nothing.
      expect((await ingest(db, c, order(), 'SYNC')).status).toBe('DUPLICATE')
      await asSystem(db)
      expect(num(await value(db, `select count(*) from public.orders where sales_channel_id = $1`, [c]))).toBe(1)
      expect(num(await value(db, `select orders_imported from public.sales_channels where id = $1`, [c]))).toBe(1)
    }))

  it('matches our product by SKU and reserves its stock', () =>
    inTx(async (db) => {
      const ours = await createProduct(db, { price: 900, stock: 10 })
      const sku = await value<string>(db, `select sku from public.product_variants where id = $1`, [ours.variantIds[0]])
      const c = await channel(db, 'WOOCOMMERCE', 'https://shop.example.com')
      const r = await ingest(db, c, order({ external_id: '812', number: '#812', lines: [{ external_variant_id: '41', sku, title: 'Belt', quantity: 3, unit_price: 950 }], total: 2970, discount_total: 0, shipping_price: 120 }))
      expect(r.status).toBe('IMPORTED')
      await asSystem(db)
      expect(await value(db, `select variant_id from public.order_items where order_id = $1`, [r.order_id])).toBe(ours.variantIds[0])
      expect(num(await value(db, `select unit_price from public.order_items where order_id = $1`, [r.order_id]))).toBe(950)
      expect((await inventory(db, ours.variantIds[0])).reserved).toBe(3)
    }))

  it('keeps an order it cannot place, says why, and imports it once staff fix it', () =>
    inTx(async (db) => {
      const c = await channel(db)
      const bad = order({ external_id: '5002', number: '#1002', customer: { name: 'Sumon', phone: '12345', email: null },
        shipping: { address: 'Ward 4, Bazar Road', city: 'Kalampur', state: null, postal_code: null, district_hint: null } })
      const r = await ingest(db, c, bad)
      expect(r).toMatchObject({ status: 'FAILED', error: expect.stringContaining('district') })
      await asSystem(db)
      expect(num(await value(db, `select count(*) from public.orders where external_order_id = '5002'`))).toBe(0)
      expect(num(await value(db, `select count(*) from public.products where 'shopify' = any(tags) and name = 'Canvas Tote'`))).toBe(0)

      // Staff see it in the list…
      await asUser(db, await createStaff(db, 'ORDER_MANAGER'))
      const list = await value<{ items: Array<{ id: string; status: string; error: string }> }>(db, `select public.channel_imports_list('{"status":"FAILED"}')`)
      expect(list.items.find((i) => i.id === r.import_id)).toMatchObject({ status: 'FAILED' })

      // …choose the district; the phone is still wrong, so it fails again with that reason.
      await asService(db)
      await db.query(`select public.channel_import_for_retry($1, '{"district":"Gazipur"}', null)`, [r.import_id])
      expect(await ingest(db, c, bad, 'RETRY')).toMatchObject({ status: 'FAILED', error: expect.stringContaining('mobile number') })
      await db.query(`select public.channel_import_for_retry($1, '{"phone":"01712000802"}', null)`, [r.import_id])
      const ok = await ingest(db, c, bad, 'RETRY')
      expect(ok.status).toBe('IMPORTED')
      await asSystem(db)
      expect(await value(db, `select shipping_district || ' ' || customer_phone from public.orders where id = $1`, [ok.order_id])).toBe('Gazipur 01712000802')
      expect(num(await value(db, `select attempts from public.channel_order_imports where id = $1`, [r.import_id]))).toBe(3)
    }))

  it('records what was paid in the store, and cancels a waiting order when the store cancels it', () =>
    inTx(async (db) => {
      const c = await channel(db)
      const r = await ingest(db, c, order({ external_id: '5003', number: '#1003', paid_amount: 1520, gateway: 'bKash' }))
      await asSystem(db)
      const o = await value<Record<string, unknown>>(db, `select jsonb_build_object('method', payment_method, 'paid', amount_paid, 'total', total_amount) from public.orders where id = $1`, [r.order_id])
      expect(o.method).toBe('FULL_PAYMENT')
      expect(num(o.paid)).toBe(1520)
      expect(await value(db, `select channel from public.order_payments where order_id = $1`, [r.order_id])).toBe('GATEWAY')

      await asService(db)
      expect(await value(db, `select public.channel_order_cancelled($1, '5003', 'customer')`, [c])).toMatchObject({ status: 'CANCELLED' })
      await asSystem(db)
      expect(await value(db, `select status from public.orders where id = $1`, [r.order_id])).toBe('CANCELLED')

      // Cancelled before it ever arrived: skipped, not imported.
      expect((await ingest(db, c, order({ external_id: '5004', cancelled: true }))).status).toBe('SKIPPED')
    }))

  it('flags store totals that include taxes we did not import', () =>
    inTx(async (db) => {
      const c = await channel(db)
      const r = await ingest(db, c, order({ external_id: '5005', discount_total: 0, total: 1700 }))
      await asSystem(db)
      expect(await value(db, `select array_to_string(warnings, ' ') from public.channel_order_imports where id = $1`, [r.import_id])).toContain('taxes or fees')
    }))

  it('keeps import functions away from browsers and channel details away from non-staff', () =>
    inTx(async (db) => {
      const c = await channel(db)
      await asUser(db, await createStaff(db, 'ORDER_MANAGER'))
      await expectError(db, `select public.channel_ingest_order($1, $2)`, [c, JSON.stringify(order())], /permission denied/)
      await expectError(db, `select public.channel_upsert('{}', null)`, [], /permission denied/)
      await expectError(db, `select public.sales_channel_settings_save($1, '{"import_orders": false}')`, [c], /settings\.manage/)
      await asAnon(db)
      await expectError(db, `select public.sales_channels_list()`, [], /permission/i)
      await asUser(db, await createStaff(db, 'ADMIN'))
      const list = await value<Array<Record<string, unknown>>>(db, `select public.sales_channels_list()`)
      expect(list.find((x) => x.id === c)).toMatchObject({ platform: 'SHOPIFY', status: 'PENDING' })
      expect(JSON.stringify(list)).not.toMatch(/shpat_|secret|access_token|consumer_key/i)
      await db.query(`select public.sales_channel_settings_save($1, '{"import_orders": false}')`, [c])
      expect((await ingest(db, c, order({ external_id: '5006' }))).status).toBe('SKIPPED')
    }))
})
