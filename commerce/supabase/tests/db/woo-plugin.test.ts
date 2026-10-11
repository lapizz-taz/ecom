import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const TO_SHIPPED = ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP', 'SHIPPED']

async function store(db: Db, platform: 'SHOPIFY' | 'WOOCOMMERCE' = 'WOOCOMMERCE', settings: Record<string, unknown> = {}) {
  await asService(db)
  const domain = platform === 'SHOPIFY' ? `s${Math.floor(Math.random() * 1e6)}.myshopify.com` : `https://w${Math.floor(Math.random() * 1e6)}.example.com`
  const id = await value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform, shop_domain: domain, auth_mode: platform === 'SHOPIFY' ? 'TOKEN' : 'KEYS' })])
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED', settings = settings || $2::jsonb where id = $1`, [id, JSON.stringify(settings)])
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

const pushes = (db: Db, orderId: string) =>
  value<number>(db, `select count(*)::int from public.channel_status_pushes where order_id = $1`, [orderId])

describe('WooCommerce plugin: delivered / returned pushed to the store', () => {
  it('queues one push when a store order is delivered, and none for other stores or with the switch off', () =>
    inTx(async (db) => {
      const woo = await store(db)
      const o = await storeOrder(db, woo, '501')
      await advanceOrder(db, o, ['DELIVERED'])
      await asSystem(db)
      expect(await pushes(db, o)).toBe(1)
      // Setting the status again (e.g. a correction) never queues a second push.
      await db.query(`update public.orders set status = 'SHIPPED' where id = $1`, [o])
      await db.query(`update public.orders set status = 'DELIVERED' where id = $1`, [o])
      expect(await pushes(db, o)).toBe(1)

      const shop = await store(db, 'SHOPIFY')
      const s = await storeOrder(db, shop, '601')
      await advanceOrder(db, s, ['DELIVERED'])
      await asSystem(db)
      expect(await pushes(db, s)).toBe(0)

      const off = await store(db, 'WOOCOMMERCE', { plugin_config: { custom_statuses: false } })
      const f = await storeOrder(db, off, '701')
      await advanceOrder(db, f, ['DELIVERED'])
      await asSystem(db)
      expect(await pushes(db, f)).toBe(0)
    }))

  it('a failed push is retried later, then given up after a permanent error, with the order log telling why', () =>
    inTx(async (db) => {
      const woo = await store(db)
      const o = await storeOrder(db, woo, '502')
      await advanceOrder(db, o, ['DELIVERED'])
      await asSystem(db)
      const due = await value<Array<Record<string, any>>>(db, `select public.channel_status_push_due(10)`)
      const mine = due.find((d) => d.order_id === o)!
      expect(mine).toMatchObject({ external_order_id: '502', target: 'delivered', attempts: 0 })

      await db.query(`select public.channel_status_push_result($1, false, 'HTTP 503', true)`, [mine.id])
      const after = await value<Record<string, any>>(db, `select to_jsonb(p) from public.channel_status_pushes p where id = $1`, [mine.id])
      expect(after).toMatchObject({ status: 'PENDING', attempts: 1, last_error: 'HTTP 503' })
      expect(new Date(after.next_at).getTime()).toBeGreaterThan(Date.now())
      // Not due again straight away.
      const again = await value<Array<Record<string, any>>>(db, `select public.channel_status_push_due(10)`)
      expect(again.some((d) => d.id === mine.id)).toBe(false)

      await db.query(`select public.channel_status_push_result($1, false, 'Order not found on the store', false)`, [mine.id])
      expect(await value(db, `select status from public.channel_status_pushes where id = $1`, [mine.id])).toBe('FAILED')
      expect(await value<number>(db, `select count(*)::int from public.order_status_history where order_id = $1 and message like 'Could not mark Delivered%'`, [o])).toBe(1)
    }))

  it('only the system can read or settle the queue', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.channel_status_push_due(10)`, [], /permission denied|SYSTEM|not allowed/i)
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

      await asSystem(db)
      const advance = await value<string>(db, `insert into public.fraud_checks(phone, provider, decision, advance_amount)
        values ('01700000002', 'test', 'ADVANCE_REQUIRED', 120) returning id`)
      const refused = await value<string>(db, `insert into public.fraud_checks(phone, provider, decision) values ('01700000004', 'test', 'BLOCK') returning id`)
      const broken = await value<string>(db, `insert into public.fraud_checks(phone, provider, status, decision) values ('01700000005', 'test', 'ERROR', 'BLOCK') returning id`)
      await asService(db)
      const d = await value<Record<string, unknown>>(db, `select public.channel_checkout_decision($1, '01700000002', null, null, $2)`, [woo, advance])
      expect(d).toMatchObject({ decision: 'advance', reason: 'ADVANCE' })
      expect(String(d.message)).toContain('120')
      expect(await value(db, `select public.channel_checkout_decision($1, '01700000004', null, null, $2) ->> 'decision'`, [woo, refused])).toBe('block')
      // A check that failed never blocks a customer, whatever it says.
      expect(await value(db, `select public.channel_checkout_decision($1, '01700000005', null, null, $2) ->> 'reason'`, [woo, broken])).toBe('CHECK_UNAVAILABLE')
      // An unknown check id never blocks a customer.
      await asService(db)
      expect(await value(db, `select public.channel_checkout_decision($1, '01700000003', null, null, gen_random_uuid()) ->> 'decision'`, [woo])).toBe('allow')
    }))

  it('is not callable by signed-in users or the public', () =>
    inTx(async (db) => {
      const woo = await store(db)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.channel_checkout_decision($1, '01799887766')`, [woo], /permission denied|SYSTEM|not allowed/i)
    }))
})
