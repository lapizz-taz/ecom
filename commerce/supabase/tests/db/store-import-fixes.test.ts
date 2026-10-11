import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, closePool, inTx, num, value, type Db } from '../support/db'
import { createProduct, createStaff, inventory } from '../support/fixtures'
import { asUser } from '../support/db'

afterAll(closePool)

type Result = { status: string; order_id?: string; error?: string; import_id?: string }

async function channel(db: Db, domain: string): Promise<string> {
  await asService(db)
  return value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform: 'SHOPIFY', shop_domain: domain, auth_mode: 'TOKEN' })])
}
async function ingest(db: Db, c: string, order: Record<string, unknown>, via = 'WEBHOOK'): Promise<Result> {
  await asService(db)
  return value<Result>(db, `select public.channel_ingest_order($1, $2, $3)`, [c, JSON.stringify(order), via])
}
const order = (over: Record<string, unknown> = {}) => ({
  external_id: '7001', number: '#2001', cancelled: false, created_at: new Date().toISOString(),
  customer: { name: 'Rina Akter', phone: '01712000801', email: null },
  shipping: { address: 'House 9, Road 2, Mirpur 10', city: 'Dhaka', state: null, postal_code: '1216', district_hint: 'Dhaka' },
  lines: [{ external_variant_id: 'v-1', external_product_id: 'p-1', sku: null, title: 'Necklace', variant_title: null, quantity: 1, unit_price: 1899, image_url: null }],
  shipping_price: 0, discount_total: 0, total: 1899, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null, attribution: null,
  fulfillment_status: 'UNFULFILLED',
  ...over,
})

/** A store with two-way stock on, a first sync 10 minutes ago, and our product linked with 5 in stock on both sides. */
async function syncedStore(db: Db, domain: string) {
  const p = await createProduct(db, { price: 1899, stock: 5 })
  const v = p.variantIds[0]
  const c = await channel(db, domain)
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED', first_sync_at = now() - interval '10 minutes',
    settings = settings || '{"inventory_sync": true, "external_changes": "TWO_WAY", "location_id": "gid://shopify/Location/1"}' where id = $1`, [c])
  await db.query(`insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, last_pushed_qty, shopify_available, sync_status)
    values ($1, 'v-1', 'p-1', $2, 'gid://shopify/InventoryItem/1', 5, 5, 'OK')`, [c, v])
  const marker = () => value<number>(db, `select last_pushed_qty from public.sales_channel_variants where channel_id = $1 and variant_id = $2`, [c, v])
  return { c, v, marker }
}

describe('store order import fixes', () => {
  it('imports only orders still to be shipped; a person can still import one by hand', () =>
    inTx(async (db) => {
      const { c, v } = await syncedStore(db, 'fulfilled.myshopify.com')
      for (const [ext, status, reason] of [['7101', 'FULFILLED', /Already fulfilled in Shopify/], ['7102', 'PARTIALLY_FULFILLED', /Partly fulfilled/], ['7103', 'RESTOCKED', /Restocked/]] as const) {
        const r = await ingest(db, c, order({ external_id: ext, number: `#${ext}`, fulfillment_status: status }), 'SYNC')
        expect(r.status).toBe('SKIPPED')
        await asSystem(db)
        expect(await value<string>(db, `select error from public.channel_order_imports where id = $1`, [r.import_id])).toMatch(reason)
      }
      // Nothing reserved for orders that already left.
      expect(await inventory(db, v)).toMatchObject({ on_hand: 5, reserved: 0, available: 5 })
      // Unfulfilled (and stores that do not say) are imported.
      expect((await ingest(db, c, order({ external_id: '7104', number: '#7104' }))).status).toBe('IMPORTED')
      expect((await ingest(db, c, order({ external_id: '7105', number: '#7105', fulfillment_status: undefined }))).status).toBe('IMPORTED')
      // "Import again" by hand takes a skipped one.
      expect((await ingest(db, c, order({ external_id: '7101', number: '#7101', fulfillment_status: 'FULFILLED' }), 'RETRY')).status).toBe('IMPORTED')
    }))

  it('reads the fulfilment state from the fulfilments the store reports (as stores send it today)', () =>
    inTx(async (db) => {
      const { c } = await syncedStore(db, 'derived.myshopify.com')
      const f = (status: string, all: boolean) => ({ id: `gid://shopify/Fulfillment/${status}`, status, display_status: 'DELIVERED', all_fulfilled: all,
        tracking_company: 'Steadfast', tracking_number: '307017011', tracking_url: null, created_at: '2026-10-10T14:46:02Z' })
      const full = await ingest(db, c, order({ external_id: '7111', number: '#7111', fulfillment_status: undefined, fulfillments: [f('SUCCESS', true)] }), 'SYNC')
      const part = await ingest(db, c, order({ external_id: '7112', number: '#7112', fulfillment_status: undefined, fulfillments: [f('SUCCESS', false)] }), 'SYNC')
      const gone = await ingest(db, c, order({ external_id: '7113', number: '#7113', fulfillment_status: undefined, fulfillments: [f('CANCELLED', true)] }), 'SYNC')
      expect([full.status, part.status, gone.status]).toEqual(['SKIPPED', 'SKIPPED', 'IMPORTED'])
      await asSystem(db)
      expect(await value<string>(db, `select error from public.channel_order_imports where id = $1`, [part.import_id])).toMatch(/Partly fulfilled/)
    }))

  it('takes the tax from the store total when the store does not name it (Shopify 2,099 + 5% = 2,203.85)', () =>
    inTx(async (db) => {
      const { c } = await syncedStore(db, 'derivedtax.myshopify.com')
      const r = await ingest(db, c, order({ external_id: '7411', number: '#7411', lines: [
        { external_variant_id: 'v-1', external_product_id: 'p-1', sku: null, title: 'Necklace', variant_title: null, quantity: 1, unit_price: 699, image_url: null }],
      shipping_price: 1400, discount_total: 0, total: 2203.85 }))
      expect(r.status).toBe('IMPORTED')
      await asSystem(db)
      const o = await value<Record<string, any>>(db, `select to_jsonb(o) from public.orders o where id = $1`, [r.order_id])
      expect([num(o.subtotal), num(o.delivery_charge), num(o.tax_amount), num(o.total_amount), num(o.cod_amount)]).toEqual([699, 1400, 104.85, 2203.85, 2203.85])
      // A store discount is still a discount, not negative tax.
      const d = await ingest(db, c, order({ external_id: '7412', number: '#7412', lines: [
        { external_variant_id: 'v-1', external_product_id: 'p-1', sku: null, title: 'Necklace', variant_title: null, quantity: 1, unit_price: 1000, image_url: null }],
      shipping_price: 100, discount_total: 200, total: 900 }))
      await asSystem(db)
      const od = await value<Record<string, any>>(db, `select to_jsonb(o) from public.orders o where id = $1`, [d.order_id])
      expect([num(od.tax_amount), num(od.discount_total), num(od.total_amount)]).toEqual([0, 200, 900])
    }))

  it('an order placed before the first sync and then cancelled here leaves stock right (no phantom +1 / +2)', () =>
    inTx(async (db) => {
      const { c, v, marker } = await syncedStore(db, 'presync.myshopify.com')
      // Placed an hour ago: the 5 copied at the first sync had already subtracted it.
      const r = await ingest(db, c, order({ external_id: '7201', number: '#7201', created_at: new Date(Date.now() - 3600e3).toISOString() }), 'SYNC')
      expect(r.status).toBe('IMPORTED')
      expect(await inventory(db, v)).toMatchObject({ on_hand: 6, reserved: 1, available: 5 })
      // The store still has 5, as expected: the marker stays at 5 (it went to 4 before, which looked like +1 made in Shopify).
      expect(await marker()).toBe(5)
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.channel_inventory_context($1, $2)`, [c, v])).toMatchObject({ desired: 5, last_pushed_qty: 5 })

      // Cancelled here: the goods are back on the shelf, 6, and the store is told 6. Shopify's 5 is not "a change made there".
      await asSystem(db)
      await db.query(`select public._transition_order($1, 'CANCELLED', 'test')`, [r.order_id])
      expect(await inventory(db, v)).toMatchObject({ on_hand: 6, reserved: 0, available: 6 })
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.channel_inventory_context($1, $2)`, [c, v])).toMatchObject({ desired: 6, last_pushed_qty: 5 })
      // If the job still adopted Shopify's 5 against the marker, nothing would change (5 - 5 = 0).
      expect(await value<Record<string, any>>(db, `select public.channel_inventory_adopt_change($1, $2, 5)`, [c, v])).toMatchObject({ change: 0 })
      expect(await inventory(db, v)).toMatchObject({ on_hand: 6, available: 6 })
    }))

  it('an order placed after the first sync still moves the marker with the store', () =>
    inTx(async (db) => {
      const { c, v, marker } = await syncedStore(db, 'after.myshopify.com')
      expect((await ingest(db, c, order({ external_id: '7301', number: '#7301' }))).status).toBe('IMPORTED')
      expect(await inventory(db, v)).toMatchObject({ on_hand: 5, reserved: 1, available: 4 })
      // Shopify went to 4 when it sold it: the marker follows, so that is not a change made in Shopify.
      expect(await marker()).toBe(4)
      // The same order again (webhook retry, sync): nothing moves twice.
      expect((await ingest(db, c, order({ external_id: '7301', number: '#7301' }), 'SYNC')).status).toBe('DUPLICATE')
      expect(await inventory(db, v)).toMatchObject({ on_hand: 5, reserved: 1, available: 4 })
      expect(await marker()).toBe(4)
    }))

  it('says why an order without a usable phone cannot come in, and imports it once a phone is added', () =>
    inTx(async (db) => {
      const { c, v } = await syncedStore(db, 'phone.myshopify.com')
      const none = await ingest(db, c, order({ external_id: '7501', number: '#7501', customer: { name: 'Tazul Islam', phone: null, email: 'x@example.com' } }))
      expect(none.status).toBe('FAILED')
      expect(none.error).toMatch(/has no phone number/)
      const bad = await ingest(db, c, order({ external_id: '7502', number: '#7502', customer: { name: 'Tazul Islam', phone: '12345', email: null } }))
      expect(bad.error).toMatch(/"12345" is not a valid Bangladesh mobile number/)
      expect(await inventory(db, v)).toMatchObject({ reserved: 0 })
      // Fixed by hand: the phone is added and the order comes in.
      await asSystem(db)
      await db.query(`update public.channel_order_imports set overrides = '{"phone": "01712000801"}' where id = $1`, [none.import_id])
      expect((await ingest(db, c, order({ external_id: '7501', number: '#7501', customer: { name: 'Tazul Islam', phone: null, email: 'x@example.com' } }), 'RETRY')).status).toBe('IMPORTED')
    }))

  it('keeps the store\'s tax in the total and the cash to collect', () =>
    inTx(async (db) => {
      const { c } = await syncedStore(db, 'tax.myshopify.com')
      const r = await ingest(db, c, order({ external_id: '7401', number: '#7401', lines: [
        { external_variant_id: 'v-1', external_product_id: 'p-1', sku: null, title: 'Necklace', variant_title: null, quantity: 1, unit_price: 2099, image_url: null }],
      total: 2203.85, tax_total: 104.85 }))
      expect(r.status).toBe('IMPORTED')
      await asSystem(db)
      const o = await value<Record<string, any>>(db, `select to_jsonb(o) from public.orders o where id = $1`, [r.order_id])
      expect(num(o.subtotal)).toBe(2099)
      expect(num(o.tax_amount)).toBe(104.85)
      expect(num(o.discount_total)).toBe(0)
      expect(num(o.total_amount)).toBe(2203.85)
      expect(num(o.cod_amount)).toBe(2203.85)
      expect(await value<string[]>(db, `select warnings from public.channel_order_imports where id = $1`, [r.import_id])).toEqual([])
      // Recalculated later (e.g. an edit): the tax stays in.
      await db.query(`select public.recalculate_order_totals($1)`, [r.order_id])
      expect(num(await value(db, `select total_amount from public.orders where id = $1`, [r.order_id]))).toBe(2203.85)
    }))

  it('a store order through edits and cancels moves stock exactly once at each step', () =>
    inTx(async (db) => {
      const { c, v, marker } = await syncedStore(db, 'lifecycle.myshopify.com')
      const second = await createProduct(db, { price: 500, stock: 4 })
      const v2 = second.variantIds[0]
      await asSystem(db)
      await db.query(`insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, last_pushed_qty, shopify_available, sync_status)
        values ($1, 'v-2', 'p-2', $2, 'gid://shopify/InventoryItem/2', 4, 4, 'OK')`, [c, v2])
      const releases = () => value<number>(db, `select count(*)::int from public.inventory_movements where variant_id in ($1, $2) and movement_type = 'RELEASE'`, [v, v2])
      // One order, two products, the first one twice in the cart.
      const r = await ingest(db, c, order({ external_id: '7601', number: '#7601', lines: [
        { external_variant_id: 'v-1', external_product_id: 'p-1', sku: null, title: 'Necklace', variant_title: null, quantity: 1, unit_price: 1899, image_url: null },
        { external_variant_id: 'v-1', external_product_id: 'p-1', sku: null, title: 'Necklace', variant_title: null, quantity: 1, unit_price: 1899, image_url: null },
        { external_variant_id: 'v-2', external_product_id: 'p-2', sku: null, title: 'Belt', variant_title: null, quantity: 3, unit_price: 500, image_url: null }],
      total: 5298 }))
      expect(r.status).toBe('IMPORTED')
      expect(await inventory(db, v)).toMatchObject({ on_hand: 5, reserved: 2, available: 3 })
      expect(await inventory(db, v2)).toMatchObject({ on_hand: 4, reserved: 3, available: 1 })
      expect(await marker()).toBe(3)

      // Staff take one belt off and drop the second necklace: only those come back.
      await asUser(db, await createStaff(db, 'ADMIN'))
      await db.query(`select public.admin_set_order_items($1, $2)`, [r.order_id, JSON.stringify([{ variant_id: v, quantity: 1 }, { variant_id: v2, quantity: 2 }])])
      expect(await inventory(db, v)).toMatchObject({ reserved: 1, available: 4 })
      expect(await inventory(db, v2)).toMatchObject({ reserved: 2, available: 2 })

      // Cancelled here: everything still reserved comes back, once.
      await asSystem(db)
      await db.query(`select public._transition_order($1, 'CANCELLED', 'test')`, [r.order_id])
      expect(await inventory(db, v)).toMatchObject({ on_hand: 5, reserved: 0, available: 5 })
      expect(await inventory(db, v2)).toMatchObject({ on_hand: 4, reserved: 0, available: 4 })
      const after = await releases()
      // Cancelled again here, and Shopify's cancel webhook twice: nothing more.
      await db.query(`savepoint again`)
      await db.query(`select public._transition_order($1, 'CANCELLED', 'again')`, [r.order_id]).catch(() => db.query(`rollback to savepoint again`))
      await asService(db)
      for (let i = 0; i < 2; i++) {
        expect(await value<Record<string, any>>(db, `select public.channel_order_cancelled($1, '7601', 'customer')`, [c])).toMatchObject({ status: 'ALREADY' })
      }
      expect(await releases()).toBe(after)
      expect(await inventory(db, v)).toMatchObject({ on_hand: 5, available: 5 })
      expect(await inventory(db, v2)).toMatchObject({ on_hand: 4, available: 4 })
      // Shopify's own restock of the same cancel (orders/cancelled with restock): expected, not counted here.
      expect(await value(db, `select public.channel_store_restock_seen($1, '7601', $2)`, [c, JSON.stringify([
        { line_id: '901', refund_id: '91', created_at: new Date(Date.now() + 1000).toISOString(), external_variant_id: 'v-1', quantity: 2, location_id: '1' }])])).toMatchObject({ status: 'OK' })
      expect(await inventory(db, v)).toMatchObject({ on_hand: 5, available: 5 })
    }))
})
