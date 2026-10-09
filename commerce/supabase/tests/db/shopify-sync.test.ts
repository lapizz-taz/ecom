import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { advanceOrder, createProduct, createStaff, inventory } from '../support/fixtures'

afterAll(closePool)

async function shopify(db: Db, settings: Record<string, unknown> = {}) {
  await asService(db)
  const id = await value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform: 'SHOPIFY', shop_domain: `s${Math.floor(Math.random() * 1e6)}.myshopify.com`, auth_mode: 'TOKEN' })])
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED', settings = settings || $2::jsonb,
    locations = '[{"id":"gid://shopify/Location/1","name":"Warehouse","active":true}]' where id = $1`, [id, JSON.stringify(settings)])
  return id
}

/** A Shopify order for our product (linked by SKU), imported like the webhook does. */
async function imported(db: Db, channel: string, sku: string, qty = 1, externalId = String(Math.floor(Math.random() * 1e9))) {
  await asService(db)
  const r = await value<{ status: string; order_id: string }>(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [channel, JSON.stringify({
    external_id: externalId, number: `#${externalId}`, cancelled: false,
    customer: { name: 'Rina Akter', phone: '01712000811', email: 'rina@example.com' },
    shipping: { address: 'House 9, Road 2, Mirpur 10', city: 'Dhaka', state: null, postal_code: '1216', district_hint: 'Dhaka' },
    lines: [{ external_variant_id: `ext-${sku}`, external_product_id: 'p1', sku, title: 'Tote', variant_title: null, quantity: qty, unit_price: 500, image_url: null }],
    shipping_price: 80, discount_total: 0, total: 500 * qty + 80, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null, attribution: null,
  })])
  expect(r.status).toBe('IMPORTED')
  return r.order_id
}

const jobs = (db: Db, kind: string, ref: string) =>
  db.query<{ status: string }>(`select status from public.channel_sync_jobs where kind = $1 and ref_id = $2`, [kind, ref]).then((r) => r.rows)
const fulfilment = (db: Db, order: string) =>
  value<Record<string, any> | null>(db, `select to_jsonb(f) from public.channel_fulfillments f where order_id = $1 and source = 'APP'`, [order]).catch(() => null)

async function ship(db: Db, order: string, consignment: string | null) {
  await advanceOrder(db, order, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  const courier = await value<string>(db, `insert into public.couriers(name, provider, api_enabled, tracking_url_template)
    values ('Pathao ' || substr(md5(random()::text), 1, 5), 'pathao', true, 'https://merchant.pathao.com/tracking?consignment_id={tracking}') returning id`)
  await db.query(`select public.assign_courier($1, $2, $3, 70, null, $3)`, [order, courier, consignment])
  await advanceOrder(db, order, ['SHIPPED'])
}

describe('Shopify fulfilment queue', () => {
  it('approve and RTS leave Shopify alone; shipping queues exactly one fulfilment with the real tracking link', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 10, variants: [{ sku: 'TOTE-SY1', title: 'Default', stock: 10 }] })
      const c = await shopify(db)
      const o = await imported(db, c, 'TOTE-SY1')
      await advanceOrder(db, o, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
      await asSystem(db)
      expect(await jobs(db, 'FULFILL', o)).toEqual([])
      expect(await fulfilment(db, o)).toBeNull()

      const courier = await value<string>(db, `insert into public.couriers(name, provider, api_enabled, tracking_url_template)
        values ('Pathao X', 'pathao', true, 'https://merchant.pathao.com/tracking?consignment_id={tracking}') returning id`)
      await db.query(`select public.assign_courier($1, $2, 'DL777', 70, null, 'DL777')`, [o, courier])
      await advanceOrder(db, o, ['SHIPPED'])
      await asSystem(db)
      expect(await jobs(db, 'FULFILL', o)).toEqual([{ status: 'PENDING' }])
      expect(await fulfilment(db, o)).toMatchObject({ status: 'PENDING', source: 'APP' })
      const ctx = await value<Record<string, any>>(db, `select public.channel_fulfillment_context($1)`, [o])
      expect(ctx.shipment).toMatchObject({ tracking: 'DL777', tracking_url: 'https://merchant.pathao.com/tracking?consignment_id=DL777' })
      expect(ctx.lines).toEqual([expect.objectContaining({ sku: 'TOTE-SY1', quantity: 1, external_variant_id: 'ext-TOTE-SY1' })])
      expect(p.variantIds).toHaveLength(1)

      // Delivered: nothing new is queued.
      await asService(db)
      await db.query(`select public.channel_job_finish(id, 'DONE') from public.channel_sync_jobs where ref_id = $1`, [o])
      await db.query(`select public.channel_fulfillment_update($1, $2)`, [o, JSON.stringify({ status: 'FULFILLED', fulfillment_id: 'gid://shopify/Fulfillment/1', notification_status: 'REQUESTED' })])
      await advanceOrder(db, o, ['DELIVERED'])
      await asSystem(db)
      expect((await jobs(db, 'FULFILL', o)).map((j) => j.status)).toEqual(['DONE'])
      // FULFILLED needs Shopify's id.
      await asService(db)
      await expectError(db, `select public.channel_fulfillment_update($1, '{"status":"FULFILLED"}')`, [o], /fulfilment id/)
    }))

  it('a tracking number added later wakes a waiting fulfilment; manual Shopify fulfilments are recorded once', () =>
    inTx(async (db) => {
      await createProduct(db, { price: 500, stock: 10, variants: [{ sku: 'TOTE-SY2', title: 'Default', stock: 10 }] })
      const c = await shopify(db)
      const o = await imported(db, c, 'TOTE-SY2', 1, '70001')
      await ship(db, o, null)
      await asService(db)
      await db.query(`select public.channel_job_finish(id, 'DONE') from public.channel_sync_jobs where ref_id = $1`, [o])
      await db.query(`select public.channel_fulfillment_update($1, '{"status":"NEEDS_TRACKING","error":"No tracking"}')`, [o])
      await asSystem(db)
      await db.query(`update public.shipments set consignment_id = 'DL55' where order_id = $1`, [o])
      expect((await fulfilment(db, o))!.status).toBe('PENDING')
      expect((await jobs(db, 'FULFILL', o)).filter((j) => j.status === 'PENDING')).toHaveLength(1)

      // Shopify tells us (twice) about a fulfilment someone made by hand.
      await asService(db)
      const seen = [{ id: 'gid://shopify/Fulfillment/555', status: 'SUCCESS', tracking_company: 'Steadfast', tracking_number: 'SF9', tracking_url: null, all_fulfilled: false }]
      await db.query(`select public.channel_fulfillments_seen($1, '70001', $2)`, [c, JSON.stringify(seen)])
      await db.query(`select public.channel_fulfillments_seen($1, '70001', $2)`, [c, JSON.stringify(seen)])
      await asSystem(db)
      expect(num(await value(db, `select count(*) from public.channel_fulfillments where order_id = $1 and source = 'SHOPIFY'`, [o]))).toBe(1)

      // Our own earlier request that succeeded is matched by tracking number, not duplicated.
      await asService(db)
      await db.query(`select public.channel_fulfillment_update($1, '{"status":"PROCESSING","tracking_number":"DL55"}')`, [o])
      await db.query(`select public.channel_fulfillments_seen($1, '70001', $2)`, [c, JSON.stringify([{ id: 'gid://shopify/Fulfillment/556', status: 'SUCCESS', tracking_number: 'DL55' }])])
      await asSystem(db)
      expect(await fulfilment(db, o)).toMatchObject({ status: 'FULFILLED', fulfillment_id: 'gid://shopify/Fulfillment/556' })
    }))

  it('own-store orders and switched-off channels never queue Shopify work', () =>
    inTx(async (db) => {
      await createProduct(db, { price: 500, stock: 10, variants: [{ sku: 'TOTE-SY3', title: 'Default', stock: 10 }] })
      const c = await shopify(db, { fulfill_on_ship: false })
      const o = await imported(db, c, 'TOTE-SY3')
      await ship(db, o, 'DL9')
      await asSystem(db)
      expect(await jobs(db, 'FULFILL', o)).toEqual([])
    }))
})

describe('sync job queue', () => {
  it('claims each due job once, backs off on retry and keeps failures for a person', () =>
    inTx(async (db) => {
      const c = await shopify(db)
      await asService(db)
      const ref = '00000000-0000-0000-0000-0000000000a1'
      const id = await value<string>(db, `select public.channel_job_enqueue($1, 'INVENTORY', $2)`, [c, ref])
      // Enqueuing again just wakes the same job.
      expect(await value<string>(db, `select public.channel_job_enqueue($1, 'INVENTORY', $2)`, [c, ref])).toBe(id)
      const claimed = await db.query(`select id from public.channel_jobs_claim(10) where id = $1`, [id])
      expect(claimed.rows).toHaveLength(1)
      expect((await db.query(`select id from public.channel_jobs_claim(10) where id = $1`, [id])).rows).toHaveLength(0)
      const retry = await value<Record<string, any>>(db, `select to_jsonb(public.channel_job_finish($1, 'RETRY', 'timeout'))`, [id])
      expect(retry.status).toBe('PENDING')
      expect(Date.parse(retry.next_attempt_at)).toBeGreaterThan(Date.now() - 5000)
      await db.query(`update public.channel_sync_jobs set attempts = max_attempts where id = $1`, [id])
      expect((await value<Record<string, any>>(db, `select to_jsonb(public.channel_job_finish($1, 'RETRY', 'still failing'))`, [id])).status).toBe('FAILED')
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await db.query(`select public.channel_job_retry($1)`, [id])
      await asSystem(db)
      expect(await value(db, `select status from public.channel_sync_jobs where id = $1`, [id])).toBe('PENDING')
      // Staff cannot drive the worker functions directly.
      await asUser(db, owner)
      await expectError(db, `select public.channel_jobs_claim(5)`, [], /permission denied|PERMISSION_DENIED/)
    }))
})

describe('Shopify stock sync', () => {
  it('links by SKU, flags duplicates, pushes our stock changes, and does not double count a Shopify order', () =>
    inTx(async (db) => {
      const tote = await createProduct(db, { price: 500, stock: 10, variants: [{ sku: 'SY-TOTE', title: 'Default', stock: 10 }] })
      await createProduct(db, { price: 300, stock: 5, variants: [{ sku: 'SY-DUP', title: 'Default', stock: 5 }] })
      await createProduct(db, { price: 300, stock: 5, variants: [{ sku: 'sy-dup', title: 'Default', stock: 5 }] })
      const c = await shopify(db, { location_id: 'gid://shopify/Location/1' })
      await asService(db)
      const level = (n: number) => [{ location_id: 'gid://shopify/Location/1', location: 'Warehouse', available: n }]
      const r = await value<Record<string, number>>(db, `select public.channel_catalog_import($1, $2, $3)`, [c, JSON.stringify([
        { external_variant_id: 'ext-SY-TOTE', external_product_id: 'p1', inventory_item_id: 'gid://shopify/InventoryItem/1', sku: 'SY-TOTE', product_title: 'Tote', variant_title: 'Default Title', tracked: true, levels: level(10) },
        { external_variant_id: 'ext-dup', external_product_id: 'p2', inventory_item_id: 'gid://shopify/InventoryItem/2', sku: 'SY-DUP', product_title: 'Dup', variant_title: 'Default Title', tracked: true, levels: level(5) },
        { external_variant_id: 'ext-none', external_product_id: 'p3', inventory_item_id: 'gid://shopify/InventoryItem/3', sku: null, product_title: 'No SKU', variant_title: 'Default Title', tracked: true, levels: level(1) },
      ]), JSON.stringify([{ id: 'gid://shopify/Location/1', name: 'Warehouse', active: true }])])
      expect(r.linked).toBe(1)

      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const ov = await value<Record<string, any>>(db, `select public.channel_inventory_overview($1)`, [c])
      expect(ov.items).toHaveLength(1)
      expect(Object.fromEntries(ov.unmapped.map((u: any) => [u.external_variant_id, u.reason]))).toEqual({ 'ext-dup': 'DUPLICATE_SKU_HERE', 'ext-none': 'NO_SKU' })

      // Turning sync on takes today's Shopify numbers as the baseline — nothing is pushed yet.
      await db.query(`select public.channel_sync_settings_save($1, '{"inventory_sync": true}')`, [c])
      await asSystem(db)
      expect(await value(db, `select sync_status from public.sales_channel_variants where channel_id = $1 and variant_id = $2`, [c, tote.variantIds[0]])).toBe('OK')
      expect(await jobs(db, 'INVENTORY', tote.variantIds[0])).toEqual([])

      // Stock changed here → one job.
      await asUser(db, owner)
      await db.query(`select public.adjust_stock($1, 'ADJUSTMENT', 3, 'Received', 'ADD')`, [tote.variantIds[0]])
      await asSystem(db)
      expect(await jobs(db, 'INVENTORY', tote.variantIds[0])).toEqual([{ status: 'PENDING' }])
      await db.query(`update public.sales_channel_variants set last_pushed_qty = 13, shopify_available = 13 where channel_id = $1`, [c])

      // A Shopify order: Shopify already went 13 → 11; importing it reserves 2 here and moves the marker to 11 too.
      await imported(db, c, 'SY-TOTE', 2)
      await asSystem(db)
      expect(await value(db, `select last_pushed_qty from public.sales_channel_variants where channel_id = $1 and variant_id = $2`, [c, tote.variantIds[0]])).toBe(11)
      expect((await inventory(db, tote.variantIds[0])).available).toBe(11)
      const ctx = await value<Record<string, any>>(db, `select public.channel_inventory_context($1, $2)`, [c, tote.variantIds[0]])
      expect(ctx).toMatchObject({ desired: 11, last_pushed_qty: 11, policy: 'FLAG' })

      // Shopify reports our own quantity back: ignored. A different one: checked by a job (after a pause).
      await asService(db)
      await db.query(`update public.channel_sync_jobs set status = 'DONE' where channel_id = $1`, [c])
      expect(await value(db, `select public.channel_inventory_seen($1, 'gid://shopify/InventoryItem/1', 'gid://shopify/Location/1', 11)`, [c])).toMatchObject({ queued: 0 })
      expect(await value(db, `select public.channel_inventory_seen($1, 'gid://shopify/InventoryItem/1', 'gid://shopify/Location/1', 4)`, [c])).toMatchObject({ queued: 1 })
      expect(await value(db, `select public.channel_inventory_seen($1, 'gid://shopify/InventoryItem/1', 'gid://shopify/Location/9', 4)`, [c])).toMatchObject({ status: 'OTHER_LOCATION' })

      // Reconcile: the dry run changes nothing; adopting Shopify's number is a recorded correction.
      await asUser(db, owner)
      const plan = await value<Record<string, any>>(db, `select public.channel_inventory_reconcile($1, $2, false)`, [c, JSON.stringify([{ variant_id: tote.variantIds[0], action: 'ADOPT' }])])
      expect(plan.plan[0]).toMatchObject({ action: 'ADOPT', from: 11, to: 4, on_hand_change: -7 })
      expect((await inventory(db, tote.variantIds[0])).available).toBe(11)
      await db.query(`select public.channel_inventory_reconcile($1, $2, true)`, [c, JSON.stringify([{ variant_id: tote.variantIds[0], action: 'ADOPT' }])])
      expect((await inventory(db, tote.variantIds[0])).available).toBe(4)
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.inventory_movements where variant_id = $1 and reference_label = 'Shopify reconciliation'`, [tote.variantIds[0]])).toBe(1)
    }))
})
