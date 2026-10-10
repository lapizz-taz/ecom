import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, inTx, value, type Db } from '../support/db'
import { advanceOrder, createProduct, createStaff, inventory } from '../support/fixtures'

afterAll(closePool)

const LOC = 'gid://shopify/Location/1'

async function shopify(db: Db, settings: Record<string, unknown> = {}) {
  await asService(db)
  const id = await value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform: 'SHOPIFY', shop_domain: `s${Math.floor(Math.random() * 1e6)}.myshopify.com`, auth_mode: 'TOKEN' })])
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED', settings = settings || $2::jsonb where id = $1`, [id, JSON.stringify(settings)])
  return id
}
const phone = () => `0171${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

/** A Shopify order imported like the webhook does. */
async function imported(db: Db, channel: string, o: { sku: string; qty?: number; phone: string; total?: number; attribution?: unknown }) {
  await asService(db)
  const ext = String(Math.floor(Math.random() * 1e9))
  const qty = o.qty ?? 1
  const r = await value<{ status: string; order_id: string; merged_into: string | null }>(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [channel, JSON.stringify({
    external_id: ext, number: `#${ext.slice(0, 5)}`, cancelled: false,
    customer: { name: 'Tazul Islam', phone: o.phone, email: null },
    shipping: { address: 'House 9, Road 2, Mirpur 10', city: 'Dhaka', state: null, postal_code: '1216', district_hint: 'Dhaka' },
    lines: [{ external_variant_id: `ext-${o.sku}`, external_product_id: 'p1', sku: o.sku, title: 'Belt', variant_title: null, quantity: qty, unit_price: 500, image_url: null }],
    shipping_price: 80, discount_total: 0, total: o.total ?? 500 * qty + 80, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null,
    attribution: o.attribution ?? null,
  })])
  expect(r.status).toBe('IMPORTED')
  return { ...r, ext }
}
const order = (db: Db, id: string) => value<Record<string, any>>(db, `select to_jsonb(o) from public.orders o where id = $1`, [id])
const sync = (db: Db, id: string) => value<Record<string, any> | null>(db, `select (select to_jsonb(s) from public.channel_order_sync s where order_id = $1)`, [id])

async function ship(db: Db, id: string, consignment: string) {
  await advanceOrder(db, id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  const courier = await value<string>(db, `insert into public.couriers(name, provider, api_enabled, tracking_url_template)
    values ('Steadfast ' || substr(md5(random()::text), 1, 5), 'steadfast', true, 'https://steadfast.com.bd/t/{tracking}') returning id`)
  await db.query(`select public.assign_courier($1, $2, $3, 70, null, $3)`, [id, courier, consignment])
  await advanceOrder(db, id, ['SHIPPED'])
}

describe('Merging Shopify orders (root cause: store imports skipped the merge check)', () => {
  it('a second Shopify order from the same phone merges into the first; stock moves once; the merged order is never cancelled on Shopify', () =>
    inTx(async (db) => {
      const sku = `MG-${Math.floor(Math.random() * 1e6)}`
      const p = await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const c = await shopify(db)
      const ph = phone()
      const a = await imported(db, c, { sku, phone: ph })
      const b = await imported(db, c, { sku, phone: ph, qty: 2 })
      expect(b.merged_into).not.toBeNull()
      await asSystem(db)
      const src = await order(db, b.order_id)
      expect(src).toMatchObject({ merged_into: a.order_id, status: 'CANCELLED', duplicate_status: 'MERGED' })
      const tgt = await order(db, a.order_id)
      expect(tgt.merged_count).toBe(1)
      expect(await value<number>(db, `select sum(quantity)::int from public.order_items where order_id = $1`, [a.order_id])).toBe(3)
      // 3 reserved in total, not 5.
      expect(await inventory(db, p.variantIds[0])).toMatchObject({ on_hand: 10, reserved: 3, available: 7 })
      // The merged (cancelled) Shopify order is not cancelled on Shopify.
      expect((await sync(db, b.order_id))?.cancel_status ?? null).toBeNull()
      // History explains it.
      expect(await value<number>(db, `select count(*)::int from public.order_merges where order_id = $1 and source_order_id = $2`, [a.order_id, b.order_id])).toBe(1)
    }))

  it('merges into an approved order before packing; never into cancelled or shipped ones; a discounted new order is not merged', () =>
    inTx(async (db) => {
      const sku = `MG2-${Math.floor(Math.random() * 1e6)}`
      await createProduct(db, { price: 500, stock: 50, variants: [{ sku, title: 'Default', stock: 50 }] })
      const c = await shopify(db)
      const ph = phone()
      const a = await imported(db, c, { sku, phone: ph })
      await advanceOrder(db, a.order_id, ['CONFIRMED'])
      const b = await imported(db, c, { sku, phone: ph })
      expect(b.merged_into).not.toBeNull()

      const ph2 = phone()
      const x = await imported(db, c, { sku, phone: ph2 })
      await ship(db, x.order_id, `SF${Math.floor(Math.random() * 1e6)}`)
      const y = await imported(db, c, { sku, phone: ph2 })
      expect(y.merged_into).toBeNull()

      const ph3 = phone()
      const m = await imported(db, c, { sku, phone: ph3 })
      await asSystem(db)
      await db.query(`select public._transition_order($1, 'CANCELLED', 'test')`, [m.order_id])
      const n = await imported(db, c, { sku, phone: ph3 })
      expect(n.merged_into).toBeNull()
      expect((await order(db, m.order_id)).status).toBe('CANCELLED')

      const ph4 = phone()
      await imported(db, c, { sku, phone: ph4 })
      const disc = await imported(db, c, { sku, phone: ph4, total: 400 })
      expect(disc.merged_into).toBeNull()
    }))

  it('a merged group: shipping fulfils every Shopify order in it with the group tracking; delivering marks each delivered', () =>
    inTx(async (db) => {
      const sku = `MG3-${Math.floor(Math.random() * 1e6)}`
      await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const c = await shopify(db)
      const ph = phone()
      const a = await imported(db, c, { sku, phone: ph })
      const b = await imported(db, c, { sku, phone: ph })
      await ship(db, a.order_id, 'SFG1')
      await asSystem(db)
      const jobs = await value<number>(db, `select count(*)::int from public.channel_sync_jobs where kind = 'FULFILL' and ref_id = any($1) and status = 'PENDING'`, [[a.order_id, b.order_id]])
      expect(jobs).toBe(2)
      await asService(db)
      const ctx = await value<Record<string, any>>(db, `select public.channel_fulfillment_context($1)`, [b.order_id])
      expect(ctx.order).toMatchObject({ status: 'SHIPPED', own_status: 'CANCELLED' })
      expect(ctx.shipment).toMatchObject({ tracking: 'SFG1' })
      expect(ctx.lines).toEqual([expect.objectContaining({ sku, quantity: 1 })])
      expect(ctx.merged_tag).toMatch(/^Merged: /)
      // Fulfilled on Shopify (by the worker) → delivered here → both queued for Delivered.
      for (const id of [a.order_id, b.order_id]) {
        await db.query(`select public.channel_fulfillment_update($1, $2)`, [id, JSON.stringify({ status: 'FULFILLED', fulfillment_id: `gid://shopify/Fulfillment/${id.slice(0, 8)}` })])
      }
      await advanceOrder(db, a.order_id, ['DELIVERED'])
      await asSystem(db)
      expect(await value<string[]>(db, `select array_agg(delivered_status) from public.channel_fulfillments where order_id = any($1) and source = 'APP'`, [[a.order_id, b.order_id]]))
        .toEqual(['PENDING', 'PENDING'])
    }))
})

describe('Order status → Shopify', () => {
  it('cancelling here (either list) queues one cancel; a cancel that came from Shopify is not sent back; Shopify confirms ours; stock comes back once', () =>
    inTx(async (db) => {
      const sku = `CX-${Math.floor(Math.random() * 1e6)}`
      const p = await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const c = await shopify(db)
      const a = await imported(db, c, { sku, phone: phone(), qty: 2 })
      expect(await inventory(db, p.variantIds[0])).toMatchObject({ reserved: 2 })
      await asSystem(db)
      await db.query(`select public._transition_order($1, 'CANCELLED', 'customer changed mind')`, [a.order_id])
      expect(await sync(db, a.order_id)).toMatchObject({ cancel_status: 'PENDING' })
      expect(await inventory(db, p.variantIds[0])).toMatchObject({ on_hand: 10, reserved: 0, available: 10 })
      expect(await value<number>(db, `select count(*)::int from public.channel_sync_jobs where ref_id = $1 and status = 'PENDING'`, [a.order_id])).toBe(1)
      // The worker sent it; Shopify's orders/cancelled webhook confirms (and does not cancel or restock again).
      await asService(db)
      await db.query(`select public.channel_order_sync_update($1, '{"cancel_status":"REQUESTED","restocked_in_store":false}')`, [a.order_id])
      expect(await value<Record<string, any>>(db, `select public.channel_order_cancelled($1, $2, 'customer')`, [c, a.ext])).toMatchObject({ status: 'ALREADY' })
      expect(await sync(db, a.order_id)).toMatchObject({ cancel_status: 'CONFIRMED' })
      expect(await inventory(db, p.variantIds[0])).toMatchObject({ on_hand: 10, reserved: 0, available: 10 })

      // Cancelled in Shopify first: cancelled here, nothing sent back.
      const b = await imported(db, c, { sku, phone: phone() })
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.channel_order_cancelled($1, $2, 'customer')`, [c, b.ext])).toMatchObject({ status: 'CANCELLED' })
      await asSystem(db)
      expect((await order(db, b.order_id)).status).toBe('CANCELLED')
      expect((await sync(db, b.order_id))?.cancel_status ?? null).toBeNull()
      expect(await inventory(db, p.variantIds[0])).toMatchObject({ reserved: 0, available: 10 })
    }))

  it('every status change queues the store update with the right tag; "cancel on Shopify" off keeps Shopify untouched', () =>
    inTx(async (db) => {
      const sku = `ST-${Math.floor(Math.random() * 1e6)}`
      await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const c = await shopify(db, { cancel_on_shopify: false })
      const a = await imported(db, c, { sku, phone: phone() })
      await advanceOrder(db, a.order_id, ['CONFIRMED'])
      await asService(db)
      expect((await value<Record<string, any>>(db, `select public.channel_fulfillment_context($1)`, [a.order_id])).status_tag).toBe('Status: Confirmed')
      await asSystem(db)
      await db.query(`select public._transition_order($1, 'CANCELLED', 'test')`, [a.order_id])
      expect((await sync(db, a.order_id))?.cancel_status ?? null).toBeNull()
      await asService(db)
      expect((await value<Record<string, any>>(db, `select public.channel_fulfillment_context($1)`, [a.order_id])).status_tag).toBe('Status: Cancelled')
      // Logged when the worker reports.
      await db.query(`select public.channel_order_sync_update($1, '{"paid_status":"MARKED"}')`, [a.order_id])
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.order_status_history where order_id = $1 and message = 'Marked paid on Shopify'`, [a.order_id])).toBe(1)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      expect(await value<Record<string, any>>(db, `select public.order_channel_info($1)`, [a.order_id])).toMatchObject({ sync: { paid_status: 'MARKED' } })
    }))
})

describe('Two-way stock, cost and product details', () => {
  it('a change made in Shopify is applied here as the difference, keeping a change made here at the same time', () =>
    inTx(async (db) => {
      const sku = `TW-${Math.floor(Math.random() * 1e6)}`
      const p = await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const v = p.variantIds[0]
      const c = await shopify(db, { inventory_sync: true, location_id: LOC, external_changes: 'TWO_WAY' })
      await asSystem(db)
      await db.query(`insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, sku, shopify_available, last_pushed_qty, sync_status)
        values ($1, $2, 'p1', $3, 'gid://shopify/InventoryItem/77', $4, 10, 10, 'OK')`, [c, `ext-${sku}`, v, sku])
      // Here: one sold (10 → 9). Shopify: someone added 3 by hand (10 → 13).
      await db.query(`select public._apply_inventory_movement($1, 'ADJUSTMENT', -1, 0, 0, null, null, 'test', 'count', null, false)`, [v])
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.channel_inventory_adopt_change($1, $2, 13)`, [c, v])).toMatchObject({ status: 'ADOPTED', change: 3 })
      expect(await inventory(db, v)).toMatchObject({ on_hand: 12 })
      const m = await value<Record<string, any>>(db, `select to_jsonb(m) from public.sales_channel_variants m where channel_id = $1 and variant_id = $2`, [c, v])
      expect(m).toMatchObject({ last_pushed_qty: 13, shopify_available: 13, sync_status: 'OK' })
      // Then 12 is sent to Shopify (13 → 12) — the one sold here is kept; nothing loops.
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.channel_inventory_context($1, $2)`, [c, v])).toMatchObject({ desired: 12, last_pushed_qty: 13, policy: 'TWO_WAY' })
      // The adjustment is recorded with its reason.
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.inventory_movements where variant_id = $1 and on_hand_change = 3 and note like '%10 → 13%'`, [v])).toBe(1)
    }))

  it('cost changes in Shopify update the cost here; product details follow Shopify after the first sync; category from type', () =>
    inTx(async (db) => {
      const sku = `CO-${Math.floor(Math.random() * 1e6)}`
      const p = await createProduct(db, { price: 500, stock: 4, variants: [{ sku, title: 'Default', stock: 4 }] })
      const v = p.variantIds[0]
      const c = await shopify(db)
      await asSystem(db)
      await db.query(`update public.sales_channels set first_sync_at = now() where id = $1`, [c])
      await db.query(`insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, sku, sync_status)
        values ($1, '901', '900', $2, 'gid://shopify/InventoryItem/901', $3, 'OK')`, [c, v, sku])
      await asService(db)
      await db.query(`select public.channel_cost_seen($1, 'gid://shopify/InventoryItem/901', 333.5)`, [c])
      await asSystem(db)
      expect(Number(await value(db, `select cost_price from public.product_variants where id = $1`, [v]))).toBe(333.5)

      await asService(db)
      const item = { external_variant_id: '901', external_product_id: '900', inventory_item_id: 'gid://shopify/InventoryItem/901', sku, barcode: '777',
        product_title: 'Gothic Bracelet', variant_title: 'Default Title', product_status: 'ACTIVE', tracked: true, levels: [],
        price: '650', compare_at_price: '800', unit_cost: '340', vendor: 'Isolation', product_type: `Bracelets ${sku}`, tags: [], collections: ['Gothic'], images: [] }
      expect(await value<Record<string, any>>(db, `select public.channel_catalog_product_upsert($1, '900', $2)`, [c, JSON.stringify([item])])).toMatchObject({ updated: 2 })
      await asSystem(db)
      const pv = await value<Record<string, any>>(db, `select to_jsonb(v) from public.product_variants v where id = $1`, [v])
      expect(Number(pv.price)).toBe(650)
      expect(Number(pv.cost_price)).toBe(340)
      expect(pv.barcode).toBe('777')
      const prod = await value<Record<string, any>>(db, `select to_jsonb(p) || jsonb_build_object('cat', c.name) from public.products p left join public.categories c on c.id = p.category_id
        where p.id = (select product_id from public.product_variants where id = $1)`, [v])
      expect(prod).toMatchObject({ name: 'Gothic Bracelet', brand: 'Isolation', cat: `Bracelets ${sku}` })
    }))
})

describe('Attribution (no guessing)', () => {
  const cls = (db: Db, t: unknown) => value<Record<string, any>>(db, `select public.classify_touch($1)`, [JSON.stringify(t)])
  it('a social referrer without ad tags is "paid or organic unknown"; tags and Shopify ad events decide', () =>
    inTx(async (db) => {
      await asSystem(db)
      expect(await cls(db, { referrer: 'https://l.instagram.com/', params: {} })).toMatchObject({ channel: 'social', source: 'Instagram', is_paid: null })
      expect(await cls(db, { referrer: 'http://m.facebook.com', params: {} })).toMatchObject({ channel: 'social', source: 'Facebook', is_paid: null })
      expect(await cls(db, { referrer: null, params: { utm_source: 'instagram', utm_medium: 'paid', utm_campaign: 'Belt' } }))
        .toMatchObject({ channel: 'paid_social', source: 'Instagram Ads', is_paid: true, campaign: 'Belt' })
      expect(await cls(db, { referrer: 'https://instagram.com/', params: { shopify_marketing_type: 'ad' } })).toMatchObject({ channel: 'paid_social', is_paid: true })
      expect(await cls(db, { referrer: null, params: { utm_source: 'facebook', utm_medium: 'social' } })).toMatchObject({ channel: 'organic_social', is_paid: false })
      expect(await cls(db, { referrer: null, params: { utm_source: 'facebook' } })).toMatchObject({ channel: 'social', is_paid: null })
      expect(await cls(db, { referrer: null, params: { gclid: 'x1' } })).toMatchObject({ channel: 'paid_search', click_id_type: 'gclid', click_id: 'x1' })
      expect(await cls(db, { referrer: 'https://www.google.com/', params: {} })).toMatchObject({ channel: 'organic_search', is_paid: false })
      expect(await cls(db, { referrer: null, params: {} })).toMatchObject({ channel: 'direct' })
      expect(await cls(db, null)).toMatchObject({ channel: 'unknown', source: 'Unknown' })
    }))

  it('an order imported before Shopify had its journey ready is filled in later, never overwritten after', () =>
    inTx(async (db) => {
      const sku = `AT-${Math.floor(Math.random() * 1e6)}`
      await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const c = await shopify(db)
      const a = await imported(db, c, { sku, phone: phone(), attribution: { first_touch: null, last_touch: null } })
      await asService(db)
      const t = { at: '2026-10-10T05:00:00Z', landing: '/products/belt?utm_source=facebook&utm_medium=paid&fbclid=abc', referrer: 'https://m.facebook.com/', params: { utm_source: 'facebook', utm_medium: 'paid', fbclid: 'abc' } }
      expect(await value<Record<string, any>>(db, `select public.channel_order_attribution_fill($1, $2, $3)`, [c, a.ext, JSON.stringify({ first_touch: t, last_touch: t })]))
        .toMatchObject({ status: expect.stringMatching(/RECORDED|FILLED/) })
      await asSystem(db)
      expect(await value<Record<string, any>>(db, `select to_jsonb(a) from public.order_attributions a where order_id = $1`, [a.order_id]))
        .toMatchObject({ channel: 'paid_social', source: 'Facebook Ads', is_paid: true, click_id_type: 'fbclid', utm_medium: 'paid' })
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.channel_order_attribution_fill($1, $2, $3)`, [c, a.ext, JSON.stringify({ last_touch: { ...t, params: {} } })]))
        .toMatchObject({ status: 'ALREADY' })
    }))
})
