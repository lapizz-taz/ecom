import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
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

const level = (available: number | null) => [{ location_id: LOC, location: 'Warehouse', available, on_hand: available }]
function item(sfx: string, o: { variant: string; product: string; sku: string | null; qty: number | null; title?: string; vt?: string; status?: string; tracked?: boolean; cost?: string | null; options?: Record<string, string> }) {
  return {
    external_variant_id: `${o.variant}${sfx}`, external_product_id: `${o.product}${sfx}`, inventory_item_id: `gid://shopify/InventoryItem/${o.variant}${sfx}`,
    sku: o.sku, barcode: o.sku ? `BC-${o.sku}` : null, product_title: o.title ?? `Shirt ${sfx}`, variant_title: o.vt ?? 'Default Title',
    product_status: o.status ?? 'ACTIVE', tracked: o.tracked ?? true, levels: level(o.qty),
    price: '990', compare_at_price: '1200', unit_cost: o.cost === undefined ? '410.5' : o.cost, options: o.options ?? {},
    images: ['https://cdn.shopify.com/a.jpg', 'https://cdn.shopify.com/b.jpg'], image_url: 'https://cdn.shopify.com/a.jpg',
    vendor: 'Isolation', product_type: 'Shirts', tags: ['summer', 'cotton'], weight_grams: 250, product_description: 'Linen shirt',
  }
}

async function readCatalog(db: Db, c: string, items: unknown[]) {
  await asService(db)
  return value<Record<string, any>>(db, `select public.channel_catalog_import($1, $2, $3)`,
    [c, JSON.stringify(items), JSON.stringify([{ id: LOC, name: 'Warehouse', active: true }])])
}

const pendingJobs = (db: Db, c: string, kind: string) =>
  value<number>(db, `select count(*)::int from public.channel_sync_jobs where channel_id = $1 and kind = $2 and status = 'PENDING'`, [c, kind])

describe('First sync with a store', () => {
  it('preview changes nothing; applying imports new products with full data and the store stock, takes the store number for linked ones once, then turns sync on', () =>
    inTx(async (db) => {
      const sfx = String(Math.floor(Math.random() * 1e5))
      // Already sold here: same SKU, 4 in stock here, no cost yet.
      const mine = await createProduct(db, { price: 900, stock: 4, variants: [{ sku: `MINE-${sfx}`, title: 'Default', stock: 4 }] })
      await asSystem(db)
      await db.query(`update public.product_variants set cost_price = null, barcode = null where id = $1`, [mine.variantIds[0]])
      await db.query(`update public.products set cost_price = 0 where id = (select product_id from public.product_variants where id = $1)`, [mine.variantIds[0]])
      const c = await shopify(db)
      const r = await readCatalog(db, c, [
        item(sfx, { variant: '11', product: '10', sku: `SH-${sfx}-M`, qty: 6, vt: 'M', options: { Size: 'M' } }),
        item(sfx, { variant: '12', product: '10', sku: `SH-${sfx}-L`, qty: -2, vt: 'L', options: { Size: 'L' } }),
        item(sfx, { variant: '21', product: '20', sku: `MINE-${sfx}`, qty: 9, title: `Mine ${sfx}`, cost: '300' }),
        item(sfx, { variant: '31', product: '30', sku: `OLD-${sfx}`, qty: 5, title: `Old ${sfx}`, status: 'ARCHIVED' }),
        item(sfx, { variant: '41', product: '40', sku: null, qty: null, title: `Gift ${sfx}`, tracked: false }),
      ])
      // The SKU match links at once; nothing is imported before the first sync.
      expect(r).toMatchObject({ items: 5, linked: 1, imported: 0 })

      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const before = await value<number>(db, `select count(*)::int from public.products`)
      const plan = await value<Record<string, any>>(db, `select public.channel_first_sync($1, $2, true, false)`, [c, LOC])
      // Archived store products are imported too (as Archived), so the counts match the store.
      expect(plan).toMatchObject({ applied: false, store: 'Shopify', products: 3, create: 4, untracked: 1, already_linked: 1 })
      expect(plan.stock_changes).toEqual([expect.objectContaining({ sku: `MINE-${sfx}`, ours: 4, store: 9, change: 5 })])
      expect(plan.items.map((x: any) => x.sku).sort()).toEqual([`SH-${sfx}-L`, `SH-${sfx}-M`, `OLD-${sfx}`, `SHOP-41${sfx}`].sort())
      // Preview: nothing changed at all.
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.products`)).toBe(before)
      expect(await inventory(db, mine.variantIds[0])).toMatchObject({ on_hand: 4 })
      expect(await value<any>(db, `select first_sync_at from public.sales_channels where id = $1`, [c])).toBeNull()

      await asUser(db, owner)
      const done = await value<Record<string, any>>(db, `select public.channel_first_sync($1, $2, true, true)`, [c, LOC])
      expect(done).toMatchObject({ applied: true, products: 3, create: 4 })
      expect(done.stock_changes).toEqual(plan.stock_changes)

      await asSystem(db)
      // New product: one product, two variants, prices, cost, barcode, weight, vendor, tags, two images, stock from the store.
      const p = await value<Record<string, any>>(db, `select to_jsonb(p) || jsonb_build_object('images', (select count(*) from public.product_images where product_id = p.id))
        from public.products p join public.product_variants v on v.product_id = p.id where v.sku = $1`, [`SH-${sfx}-M`])
      expect(p).toMatchObject({ name: `Shirt ${sfx}`, brand: 'Isolation', status: 'ACTIVE', images: 2, weight_grams: 250 })
      expect(p.tags).toEqual(expect.arrayContaining(['shopify', 'summer', 'cotton', 'Shirts']))
      expect(Number(p.cost_price)).toBe(410.5)
      expect(await value<number>(db, `select count(*)::int from public.product_variants where product_id = $1`, [p.id])).toBe(2)
      const vm = await value<Record<string, any>>(db, `select to_jsonb(v) from public.product_variants v where sku = $1`, [`SH-${sfx}-M`])
      expect(vm).toMatchObject({ barcode: `BC-SH-${sfx}-M`, weight_grams: 250, option_values: { Size: 'M' } })
      expect(Number(vm.cost_price)).toBe(410.5)
      expect(await inventory(db, vm.id)).toMatchObject({ on_hand: 6, available: 6 })
      // Negative in the store → 0 here, and the store is set to 0 by a job.
      const vl = await value<string>(db, `select id from public.product_variants where sku = $1`, [`SH-${sfx}-L`])
      expect(await inventory(db, vl)).toMatchObject({ on_hand: 0 })
      // Linked product: stock taken from the store once (a recorded correction), empty cost and barcode filled, price kept.
      expect(await inventory(db, mine.variantIds[0])).toMatchObject({ on_hand: 9, available: 9 })
      expect(await value<number>(db, `select count(*)::int from public.inventory_movements where variant_id = $1 and movement_type = 'ADJUSTMENT' and on_hand_change = 5`, [mine.variantIds[0]])).toBe(1)
      const linked = await value<Record<string, any>>(db, `select to_jsonb(v) from public.product_variants v where id = $1`, [mine.variantIds[0]])
      expect(Number(linked.cost_price)).toBe(300)
      expect(linked.barcode).toBe(`BC-MINE-${sfx}`)
      // Product details follow Shopify after the first sync ("Update products from Shopify").
      expect(Number(linked.price)).toBe(990)
      // Archived in the store → imported as Archived here (not for sale), with its stock.
      expect(await value<string>(db, `select p.status from public.products p join public.product_variants v on v.product_id = p.id where v.sku = $1`, [`OLD-${sfx}`])).toBe('ARCHIVED')
      // Sync is on; everything in step except the one the store had negative.
      const ch = await value<Record<string, any>>(db, `select to_jsonb(c) from public.sales_channels c where id = $1`, [c])
      expect(ch.first_sync_at).not.toBeNull()
      expect(ch.settings).toMatchObject({ inventory_sync: true, location_id: LOC, auto_import_products: true })
      expect(await pendingJobs(db, c, 'INVENTORY')).toBe(1)
      expect(await value<string[]>(db, `select array_agg(distinct sync_status) from public.sales_channel_variants where channel_id = $1 and sync_status <> 'UNTRACKED'`, [c])).toEqual(['OK'])

      // From now on ours is the truth: a change here queues exactly one push.
      await db.query(`select public._apply_inventory_movement($1, 'ADJUSTMENT', 3, 0, 0, null, null, 'test', 'restock', null, false)`, [vm.id])
      await db.query(`select public._apply_inventory_movement($1, 'ADJUSTMENT', -1, 0, 0, null, null, 'test', 'count', null, false)`, [vm.id])
      expect(await value<number>(db, `select count(*)::int from public.channel_sync_jobs where channel_id = $1 and kind = 'INVENTORY' and ref_id = $2 and status = 'PENDING'`, [c, vm.id])).toBe(1)
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.channel_inventory_context($1, $2)`, [c, vm.id])).toMatchObject({ desired: 8, last_pushed_qty: 6, sync_on: true })

      // Running it again imports nothing twice; its preview shows it would take the store's number again.
      await asUser(db, owner)
      const again = await value<Record<string, any>>(db, `select public.channel_first_sync($1, $2, true, false)`, [c, LOC])
      expect(again).toMatchObject({ create: 0, link: 0, products: 0 })
      expect(again.stock_changes).toEqual([expect.objectContaining({ sku: `SH-${sfx}-M`, ours: 8, store: 6, change: -2 })])
    }))

  it('needs settings, products and stock permissions, a read catalog and a real location', () =>
    inTx(async (db) => {
      const c = await shopify(db)
      const packer = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, packer)
      await expectError(db, `select public.channel_first_sync($1, $2, true, false)`, [c, LOC], /PERMISSION_DENIED/)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.channel_first_sync($1, $2, true, false)`, [c, LOC], /read the store/)
      await readCatalog(db, c, [])
      await asUser(db, owner)
      await expectError(db, `select public.channel_first_sync($1, 'gid://shopify/Location/999', true, false)`, [c], /locations/)
    }))
})

describe('Products made in the store later', () => {
  it('a new product is imported with its stock; a new variant joins the same product; repeats and deletes never duplicate or remove ours', () =>
    inTx(async (db) => {
      const sfx = String(Math.floor(Math.random() * 1e5))
      const c = await shopify(db)
      await readCatalog(db, c, [])
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await db.query(`select public.channel_first_sync($1, $2, true, true)`, [c, LOC])

      await asService(db)
      const one = [item(sfx, { variant: '51', product: '50', sku: `NEW-${sfx}-S`, qty: 4, vt: 'S', options: { Size: 'S' }, title: `New ${sfx}` })]
      expect(await value<Record<string, any>>(db, `select public.channel_catalog_product_upsert($1, $2, $3)`, [c, `50${sfx}`, JSON.stringify(one)]))
        .toMatchObject({ imported: 1 })
      // Same webhook again (or products/update): nothing new.
      expect(await value<Record<string, any>>(db, `select public.channel_catalog_product_upsert($1, $2, $3)`, [c, `50${sfx}`, JSON.stringify(one)]))
        .toMatchObject({ imported: 0 })
      // A size added in the store: it joins the existing product.
      const two = [...one, item(sfx, { variant: '52', product: '50', sku: `NEW-${sfx}-XL`, qty: 2, vt: 'XL', options: { Size: 'XL' }, title: `New ${sfx}` })]
      expect(await value<Record<string, any>>(db, `select public.channel_catalog_product_upsert($1, $2, $3)`, [c, `50${sfx}`, JSON.stringify(two)]))
        .toMatchObject({ imported: 1 })
      await asSystem(db)
      expect(await value<number>(db, `select count(distinct product_id)::int from public.product_variants where sku like $1`, [`NEW-${sfx}-%`])).toBe(1)
      const xl = await value<string>(db, `select id from public.product_variants where sku = $1`, [`NEW-${sfx}-XL`])
      expect(await inventory(db, xl)).toMatchObject({ on_hand: 2 })
      expect(await pendingJobs(db, c, 'INVENTORY')).toBe(0)

      // Deleted in the store: our product and stock stay; the link stops syncing.
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.channel_catalog_product_upsert($1, $2, '[]')`, [c, `50${sfx}`])).toMatchObject({ removed: 2 })
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.product_variants where sku like $1`, [`NEW-${sfx}-%`])).toBe(2)
      expect(await inventory(db, xl)).toMatchObject({ on_hand: 2 })
      expect(await value<Record<string, any>>(db, `select to_jsonb(m) from public.sales_channel_variants m where channel_id = $1 and variant_id = $2`, [c, xl]))
        .toMatchObject({ inventory_item_id: null, sync_status: 'FAILED', last_error: 'Removed from the store' })
      await db.query(`select public._apply_inventory_movement($1, 'ADJUSTMENT', 1, 0, 0, null, null, 'test', 'x', null, false)`, [xl])
      expect(await pendingJobs(db, c, 'INVENTORY')).toBe(0)
    }))

  it('turned off, or before the first sync: new products only show up to import by hand', () =>
    inTx(async (db) => {
      const sfx = String(Math.floor(Math.random() * 1e5))
      const c = await shopify(db)
      await readCatalog(db, c, [])
      await asService(db)
      const one = [item(sfx, { variant: '61', product: '60', sku: `HAND-${sfx}`, qty: 4 })]
      expect(await value<Record<string, any>>(db, `select public.channel_catalog_product_upsert($1, $2, $3)`, [c, `60${sfx}`, JSON.stringify(one)])).toMatchObject({ imported: 0 })
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await db.query(`select public.channel_first_sync($1, $2, false, true)`, [c, LOC])
      // The first sync itself imported it; a later one does not come in by itself.
      await asService(db)
      const later = [item(sfx, { variant: '71', product: '70', sku: `LATER-${sfx}`, qty: 4 })]
      expect(await value<Record<string, any>>(db, `select public.channel_catalog_product_upsert($1, $2, $3)`, [c, `70${sfx}`, JSON.stringify(later)])).toMatchObject({ imported: 0 })
    }))
})

/** A Shopify order for a product of ours, imported like the webhook does. */
async function imported(db: Db, channel: string, sku: string, ext: string, qty = 1) {
  await asService(db)
  const r = await value<{ status: string; order_id: string }>(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [channel, JSON.stringify({
    external_id: ext, number: `#${ext}`, cancelled: false,
    customer: { name: 'Rina Akter', phone: '01712000811', email: 'rina@example.com' },
    shipping: { address: 'House 9, Road 2, Mirpur 10', city: 'Dhaka', state: null, postal_code: '1216', district_hint: 'Dhaka' },
    lines: [{ external_variant_id: `ext-${sku}`, external_product_id: 'p1', sku, title: 'Tote', variant_title: null, quantity: qty, unit_price: 500, image_url: null }],
    shipping_price: 80, discount_total: 0, total: 500 * qty + 80, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null, attribution: null,
  })])
  expect(r.status).toBe('IMPORTED')
  return r.order_id
}

async function ship(db: Db, order: string, consignment: string) {
  await advanceOrder(db, order, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  const courier = await value<string>(db, `insert into public.couriers(name, provider, api_enabled, tracking_url_template)
    values ('Steadfast ' || substr(md5(random()::text), 1, 5), 'steadfast', true, 'https://steadfast.com.bd/t/{tracking}') returning id`)
  await db.query(`select public.assign_courier($1, $2, $3, 70, null, $3)`, [order, courier, consignment])
  await advanceOrder(db, order, ['SHIPPED'])
}

describe('Shopify order A to Z: stock moves once, fulfilled when shipped, delivered when delivered', () => {
  it('import → reserve (marker moves, nothing pushed twice) → ship (no stock push) → fulfil → deliver (one Delivered mark)', () =>
    inTx(async (db) => {
      const sku = `AZ-${Math.floor(Math.random() * 1e6)}`
      const p = await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const v = p.variantIds[0]
      const c = await shopify(db, { inventory_sync: true, location_id: LOC })
      await asSystem(db)
      await db.query(`insert into public.sales_channel_variants(channel_id, external_variant_id, external_product_id, variant_id, inventory_item_id, sku, shopify_available, last_pushed_qty, sync_status)
        values ($1, $2, 'p1', $3, 'gid://shopify/InventoryItem/9', $4, 10, 10, 'OK')`, [c, `ext-${sku}`, v, sku])

      // Shopify sold 2: Shopify's count is already 8. We import and reserve 2.
      const o = await imported(db, c, sku, String(Math.floor(Math.random() * 1e9)), 2)
      expect(await inventory(db, v)).toMatchObject({ on_hand: 10, reserved: 2, available: 8 })
      await asSystem(db)
      const m = await value<Record<string, any>>(db, `select to_jsonb(m) from public.sales_channel_variants m where channel_id = $1 and variant_id = $2`, [c, v])
      // The marker followed Shopify's own drop, so the job sees "in step", not a change made in Shopify.
      expect(m.last_pushed_qty).toBe(8)
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.channel_inventory_context($1, $2)`, [c, v])).toMatchObject({ desired: 8, last_pushed_qty: 8 })
      // The inventory webhook for Shopify's own drop (to 8) queues a check, never a second deduction.
      expect(await value<Record<string, any>>(db, `select public.channel_inventory_seen($1, 'gid://shopify/InventoryItem/9', $2, 8)`, [c, LOC])).toMatchObject({ queued: 0 })
      // The worker found Shopify already at 8: the job ends without pushing.
      await db.query(`select public.channel_job_finish(id, 'DONE') from public.channel_sync_jobs where channel_id = $1 and status = 'PENDING'`, [c])

      // Shipping: stock leaves (on hand and reserved both drop) — available unchanged, so nothing is pushed.
      await ship(db, o, 'SF-777')
      expect(await inventory(db, v)).toMatchObject({ on_hand: 8, reserved: 0, available: 8 })
      await asSystem(db)
      expect(await pendingJobs(db, c, 'INVENTORY')).toBe(0)
      expect(await pendingJobs(db, c, 'FULFILL')).toBe(1)

      // The worker fulfilled it on Shopify.
      await asService(db)
      await db.query(`select public.channel_job_finish(id, 'DONE') from public.channel_sync_jobs where ref_id = $1 and status = 'PENDING'`, [o])
      await db.query(`select public.channel_fulfillment_update($1, $2)`, [o, JSON.stringify({ status: 'FULFILLED', fulfillment_id: 'gid://shopify/Fulfillment/9' })])

      // Delivered here → one job to mark it delivered on Shopify.
      await advanceOrder(db, o, ['DELIVERED'])
      await asSystem(db)
      expect(await pendingJobs(db, c, 'FULFILL')).toBe(1)
      expect(await value<Record<string, any>>(db, `select to_jsonb(f) from public.channel_fulfillments f where order_id = $1 and source = 'APP'`, [o]))
        .toMatchObject({ status: 'FULFILLED', delivered_status: 'PENDING' })
      await asService(db)
      const ctx = await value<Record<string, any>>(db, `select public.channel_fulfillment_context($1)`, [o])
      expect(ctx).toMatchObject({ delivered_target: 'gid://shopify/Fulfillment/9', order: { status: 'DELIVERED' } })
      expect(ctx.order.delivered_at).not.toBeNull()
      // Recorded only with Shopify's event id; logged on the order once.
      await expectError(db, `select public.channel_fulfillment_update($1, '{"delivered_status":"MARKED"}')`, [o], /event id/)
      await db.query(`select public.channel_fulfillment_update($1, '{"delivered_status":"MARKED","delivered_event_id":"gid://shopify/FulfillmentEvent/1"}')`, [o])
      await db.query(`select public.channel_fulfillment_update($1, '{"delivered_status":"MARKED","delivered_event_id":"gid://shopify/FulfillmentEvent/1"}')`, [o])
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.order_status_history where order_id = $1 and message = 'Marked delivered on Shopify'`, [o])).toBe(1)
      // Still no stock push from any of this.
      expect(await pendingJobs(db, c, 'INVENTORY')).toBe(0)
      expect(await inventory(db, v)).toMatchObject({ on_hand: 8, reserved: 0, available: 8 })
    }))

  it('"mark delivered" off: delivering queues nothing', () =>
    inTx(async (db) => {
      const sku = `AZ2-${Math.floor(Math.random() * 1e6)}`
      await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const c = await shopify(db, { mark_delivered: false })
      const o = await imported(db, c, sku, String(Math.floor(Math.random() * 1e9)))
      await ship(db, o, 'SF-1')
      await asService(db)
      await db.query(`select public.channel_job_finish(id, 'DONE') from public.channel_sync_jobs where ref_id = $1`, [o])
      await db.query(`select public.channel_fulfillment_update($1, $2)`, [o, JSON.stringify({ status: 'FULFILLED', fulfillment_id: 'gid://shopify/Fulfillment/10' })])
      await advanceOrder(db, o, ['DELIVERED'])
      await asSystem(db)
      // A status update still goes to Shopify (tag), but no Delivered mark is wanted.
      expect(await value<Record<string, any>>(db, `select to_jsonb(f) from public.channel_fulfillments f where order_id = $1 and source = 'APP'`, [o]))
        .toMatchObject({ delivered_status: null })
    }))
})
