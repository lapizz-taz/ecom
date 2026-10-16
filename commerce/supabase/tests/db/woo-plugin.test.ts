import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, sellOn, setSetting } from '../support/fixtures'

afterAll(closePool)

const TO_SHIPPED = ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP', 'SHIPPED']

async function store(db: Db, platform: 'SHOPIFY' | 'WOOCOMMERCE' = 'WOOCOMMERCE', settings: Record<string, unknown> = {}) {
  await asService(db)
  const domain = platform === 'SHOPIFY' ? `s${Math.floor(Math.random() * 1e6)}.myshopify.com` : `https://w${Math.floor(Math.random() * 1e6)}.example.com`
  const id = await value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform, shop_domain: domain, auth_mode: platform === 'SHOPIFY' ? 'TOKEN' : 'KEYS' })])
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED', settings = settings || $2::jsonb where id = $1`, [id, JSON.stringify(settings)])
  await sellOn(db, platform)
  return id
}

/** An order that came from the store (as the importer leaves it), moved to Shipped. */
async function storeOrder(db: Db, channelId: string, external: string) {
  const p = await createProduct(db, { price: 650, cost: 300, stock: 5 })
  const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
  await asSystem(db)
  await db.query(`update public.orders set sales_channel_id = $2, external_order_id = $3 where id = $1`, [order.id, channelId, external])
  await advanceOrder(db, order.id, TO_SHIPPED)
  return order.id
}

const jobs = (db: Db, orderId: string) =>
  value<number>(db, `select count(*)::int from public.channel_sync_jobs where kind = 'FULFILL' and ref_id = $1 and status = 'PENDING'`, [orderId])

/** A store order before approval (as the importer leaves it). */
async function newStoreOrder(db: Db, channelId: string, external: string, quantity = 2) {
  const p = await createProduct(db, { price: 650, cost: 300, stock: 10 })
  const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity }] })
  await asSystem(db)
  await db.query(`update public.orders set sales_channel_id = $2, external_order_id = $3 where id = $1`, [order.id, channelId, external])
  await db.query(`delete from public.channel_sync_jobs where ref_id = $1`, [order.id])
  return order.id
}

describe('WooCommerce orders follow ours (status and returned stock)', () => {
  it('every status change of a store order queues the store update, unless status sync is off', () =>
    inTx(async (db) => {
      const woo = await store(db)
      const o = await newStoreOrder(db, woo, '501')
      await advanceOrder(db, o, ['FRAUD_CHECK', 'CONFIRMED'])
      await asSystem(db)
      expect(await jobs(db, o)).toBe(1)
      const ctx = await value<Record<string, any>>(db, `select public.channel_fulfillment_context($1)`, [o])
      expect(ctx.order).toMatchObject({ status: 'CONFIRMED', external_order_id: '501' })
      expect(ctx.settings).toMatchObject({ status_sync: true, fulfill_on_ship: false, inventory_sync: false })
      expect(ctx.restock_lines).toEqual([])

      const off = await store(db, 'WOOCOMMERCE', { status_sync: false })
      const f = await newStoreOrder(db, off, '502')
      await advanceOrder(db, f, ['FRAUD_CHECK', 'CONFIRMED'])
      await asSystem(db)
      expect(await jobs(db, f)).toBe(0)
    }))

  it('items received back as good are queued for the store with their quantity, damaged ones are not', () =>
    inTx(async (db) => {
      const woo = await store(db)
      const o = await newStoreOrder(db, woo, '503', 3)
      await advanceOrder(db, o, TO_SHIPPED)
      await asSystem(db)
      await db.query(`delete from public.channel_sync_jobs where ref_id = $1`, [o])
      const item = await value<string>(db, `select id from public.order_items where order_id = $1`, [o])
      await db.query(`select public._return_order_stock($1, $2::jsonb, 'test')`, [o, JSON.stringify([
        { order_item_id: item, quantity: 2, condition: 'RESTOCK' }, { order_item_id: item, quantity: 1, condition: 'DAMAGED' }])])
      expect(await jobs(db, o)).toBe(1)
      const ctx = await value<Record<string, any>>(db, `select public.channel_fulfillment_context($1)`, [o])
      expect(ctx.restock_lines).toHaveLength(1)
      expect(ctx.restock_lines[0]).toMatchObject({ quantity: 2 })
      expect(ctx.restock_lines[0].sku).toBeTruthy()
    }))

  it('the worker records the store status and what was put back, and the order history says so once', () =>
    inTx(async (db) => {
      const woo = await store(db)
      const o = await newStoreOrder(db, woo, '504')
      await advanceOrder(db, o, ['FRAUD_CHECK', 'CONFIRMED'])
      await asSystem(db)
      const log = (like: string) => value<number>(db, `select count(*)::int from public.order_status_history where order_id = $1 and message like $2`, [o, like])
      await db.query(`select public.channel_order_sync_update($1, $2::jsonb)`, [o, JSON.stringify({ store_status: 'confirmed', store_status_error: '' })])
      await db.query(`select public.channel_order_sync_update($1, $2::jsonb)`, [o, JSON.stringify({ store_status: 'confirmed', store_status_error: '' })])
      expect(await log('Set to Confirmed on WooCommerce')).toBe(1)

      await db.query(`select public.channel_order_sync_update($1, $2::jsonb)`, [o, JSON.stringify({ store_status_error: 'The order is cancelled in WooCommerce' })])
      expect(await log('WooCommerce status not updated: The order is cancelled%')).toBe(1)
      await db.query(`select public.channel_order_sync_retry($1)`, [o]).catch(() => undefined)

      const back = [{ external_variant_id: '101', sku: 'LS-M', name: 'Linen Shirt', quantity: 2 }]
      await db.query(`select public.channel_order_sync_update($1, $2::jsonb)`, [o, JSON.stringify({ store_status: 'returned', store_status_error: '', store_restock: back, restocked: [{ name: 'Linen Shirt - M', added: 2, stock: 12 }] })])
      // The same update again (a retried job): nothing new to tell.
      await db.query(`select public.channel_order_sync_update($1, $2::jsonb)`, [o, JSON.stringify({ store_status: 'returned', store_status_error: '', store_restock: back, restocked: [{ name: 'Linen Shirt - M', added: 0, stock: 12 }] })])
      expect(await log('2 item(s) put back in WooCommerce stock (2 × Linen Shirt - M)')).toBe(1)
      const row = await value<Record<string, any>>(db, `select to_jsonb(s) from public.channel_order_sync s where order_id = $1`, [o])
      expect(row).toMatchObject({ store_status: 'returned', store_status_error: null, store_restock: back })
    }))

  it('only the system can read the context or record updates', () =>
    inTx(async (db) => {
      const woo = await store(db)
      const o = await newStoreOrder(db, woo, '505')
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.channel_fulfillment_context($1)`, [o], /permission denied|SYSTEM|not allowed/i)
      await expectError(db, `select public.channel_order_sync_update($1, '{}'::jsonb)`, [o], /permission denied|SYSTEM|not allowed/i)
    }))
})

describe('Possible duplicates', () => {
  it('an earlier order that was already delivered or returned is a past order, not a duplicate', () =>
    inTx(async (db) => {
      const phone = '01770494953'
      const p = await createProduct(db, { price: 650, cost: 300, stock: 10 })
      const first = await createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, first.id, [...TO_SHIPPED, 'DELIVERED'])
      const again = await createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`update public.orders set duplicate_status = null, duplicate_of = null where id = $1`, [again.id])
      expect(await value(db, `select public._flag_possible_duplicate($1)`, [again.id])).toBeNull()
      expect(await value(db, `select duplicate_status from public.orders where id = $1`, [again.id])).toBeNull()

      // Still open (not approved yet): flagged as before (same phone, or the same address as the open order above).
      const open = await createOrder(db, { phone: '01770494954', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const open2 = await createOrder(db, { phone: '01770494954', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`update public.orders set duplicate_status = null, duplicate_of = null where id = $1`, [open2.id])
      expect([open.id, again.id]).toContain(await value(db, `select public._flag_possible_duplicate($1)`, [open2.id]))
    }))
})

describe('WooCommerce plugin: settings and health', () => {
  it('the heartbeat stores the report and returns the switches; defaults keep the shield off', () =>
    inTx(async (db) => {
      const woo = await store(db)
      await asService(db)
      const cfg = await value<Record<string, unknown>>(db, `select public.channel_plugin_seen($1, $2)`, [woo, JSON.stringify({ plugin: '1.0.0', woocommerce: '9.9.0' })])
      expect(cfg).toMatchObject({ order_events: true, capture_leads: true, attribution: true, custom_statuses: true, shield: false, shield_fail_open: true, shield_timeout: 4 })
      await asSystem(db)
      expect(await value(db, `select settings #>> '{plugin,plugin}' from public.sales_channels where id = $1`, [woo])).toBe('1.0.0')
      expect(await value(db, `select settings #>> '{plugin,last_seen_at}' from public.sales_channels where id = $1`, [woo])).toBeTruthy()

      // A Shopify store is not a plugin store.
      const shop = await store(db, 'SHOPIFY')
      await asService(db)
      await expectError(db, `select public.channel_plugin_seen($1, '{}')`, [shop], /NOT_FOUND/)
    }))

  it('switches are saved only by staff who manage settings, only as on/off, and the timeout is kept in range', () =>
    inTx(async (db) => {
      const woo = await store(db)
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.channel_plugin_config_save($1, '{"shield":true}')`, [woo], /settings\.manage|permission/i)

      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.channel_plugin_config_save($1, '{"shield":"yes"}')`, [woo], /VALIDATION/)
      const cfg = await value<Record<string, unknown>>(db, `select public.channel_plugin_config_save($1, '{"shield":true,"shield_timeout":60,"unknown_key":true}')`, [woo])
      expect(cfg).toMatchObject({ shield: true, shield_timeout: 10, order_events: true })
      expect(cfg).not.toHaveProperty('unknown_key')
    }))
})

describe('WooCommerce plugin: order shield at checkout', () => {
  it('refuses a block-listed number, asks for an advance when the courier check says so, otherwise allows', () =>
    inTx(async (db) => {
      const woo = await store(db)
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      await db.query(`select public.admin_block_add('PHONE', '01799887766', 'Fake orders')`)
      await asService(db)
      expect(await value(db, `select public.channel_checkout_decision($1, '01799887766') ->> 'decision'`, [woo])).toBe('block')
      expect(await value(db, `select public.channel_checkout_decision($1, '01700000001') ->> 'reason'`, [woo])).toBe('NO_CHECK')

      // The store's delivery success check: Low receivers pay a fixed 120 first.
      await setSetting(db, 'fraud', { receive_rate: { enabled: true, good_min: 80, mid_min: 50, min_parcels: 1,
        actions: { GOOD: 'COD', MID: 'ADVANCE', LOW: 'ADVANCE', NEW: 'COD', ERROR: 'ADVANCE' }, advance_type: 'FIXED', advance_amount: 120 } })
      await asSystem(db)
      const advance = await value<string>(db, `insert into public.fraud_checks(phone, provider, decision, advance_amount, metrics)
        values ('01700000002', 'test', 'ALLOW', 0, '{"courier_score": 42.5, "receive_rate": 42.5, "receive_rate_tier": "LOW", "parcel_count": 8, "delivered_orders": 3, "returned_orders": 5}') returning id`)
      const refused = await value<string>(db, `insert into public.fraud_checks(phone, provider, decision, metrics) values ('01700000004', 'test', 'BLOCK', '{"phone_flagged": true, "courier_score": 90, "delivered_orders": 9, "returned_orders": 1}') returning id`)
      const broken = await value<string>(db, `insert into public.fraud_checks(phone, provider, status, decision, metrics) values ('01700000005', 'test', 'ERROR', 'BLOCK', '{"provider_status": "ERROR"}') returning id`)
      await asService(db)
      const d = await value<Record<string, unknown>>(db, `select public.channel_checkout_decision($1, '01700000002', null, null, $2, 1370, 120)`, [woo, advance])
      expect(d).toMatchObject({ decision: 'advance', reason: 'ADVANCE', advance_amount: 120 })
      expect(String(d.message)).toContain('120')
      // The plugin's advance rules get the delivery level and the store's thresholds.
      expect(d).toMatchObject({ level: { tier: 'LOW', rate: 42.5, parcels: 8 }, levels: { good_min: 80, mid_min: 50, min_parcels: 1 } })
      expect(await value(db, `select public.channel_checkout_decision($1, '01700000004', null, null, $2) ->> 'decision'`, [woo, refused])).toBe('block')
      // A check that failed never blocks a customer, whatever it says: the store's "Check failed" action decides (here: advance).
      const failed = await value<Record<string, unknown>>(db, `select public.channel_checkout_decision($1, '01700000005', null, null, $2, 1370, 120)`, [woo, broken])
      expect(failed).toMatchObject({ decision: 'advance', reason: 'CHECK_UNAVAILABLE', advance_amount: 120, level: { tier: 'ERROR' } })
      // A lookup still running past the plugin's budget is "unavailable" too, never a free pass.
      expect(await value(db, `select public.channel_checkout_decision($1, '01700000006', null, null, null, 1370, 120, true) ->> 'decision'`, [woo])).toBe('advance')
      // An unknown check id never blocks a customer.
      await asService(db)
      expect(await value(db, `select public.channel_checkout_decision($1, '01700000003', null, null, gen_random_uuid()) ->> 'decision'`, [woo])).not.toBe('block')
    }))

  it('is not callable by signed-in users or the public', () =>
    inTx(async (db) => {
      const woo = await store(db)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.channel_checkout_decision($1, '01799887766')`, [woo], /permission denied|SYSTEM|not allowed/i)
    }))
})
