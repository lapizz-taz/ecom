import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { advanceOrder, createProduct, createStaff, sellOn } from '../support/fixtures'

afterAll(closePool)

// Every Shopify order imported here gets the tag "Fullfilio" in Shopify (30 Oct 2026). The tag is written by
// the store sync job (channels function); here: the job is queued as soon as the order comes in, the job
// reads the switch, and the switch is saved, shown and catches up on the orders imported while it was off.

async function shopify(db: Db, settings: Record<string, unknown> = {}) {
  await asService(db)
  const id = await value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform: 'SHOPIFY', shop_domain: `t${Math.floor(Math.random() * 1e6)}.myshopify.com`, auth_mode: 'TOKEN' })])
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED', settings = settings || $2::jsonb where id = $1`, [id, JSON.stringify(settings)])
  await sellOn(db, 'SHOPIFY')
  return id
}

async function imported(db: Db, channel: string, sku: string, phone: string) {
  await asService(db)
  const ext = String(Math.floor(Math.random() * 1e9))
  const r = await value<{ status: string; order_id: string }>(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [channel, JSON.stringify({
    external_id: ext, number: `#${ext.slice(0, 5)}`, cancelled: false,
    customer: { name: 'Tazul Islam', phone, email: null },
    shipping: { address: 'House 9, Road 2, Mirpur 10', city: 'Dhaka', state: null, postal_code: '1216', district_hint: 'Dhaka' },
    lines: [{ external_variant_id: `ext-${sku}`, external_product_id: 'p1', sku, title: 'Belt', variant_title: null, quantity: 1, unit_price: 500, image_url: null }],
    shipping_price: 80, discount_total: 0, total: 580, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null, attribution: null,
  })])
  expect(r.status).toBe('IMPORTED')
  return r.order_id
}

const pendingJobs = async (db: Db, orderId: string) => {
  await asSystem(db)
  return value<number>(db, `select count(*)::int from public.channel_sync_jobs where kind = 'FULFILL' and ref_id = $1 and status = 'PENDING'`, [orderId])
}
const finishJobs = async (db: Db, orderId: string) => {
  await asSystem(db)
  await db.query(`select public.channel_job_finish(id, 'DONE') from public.channel_sync_jobs where ref_id = $1 and status = 'PENDING'`, [orderId])
}
const phone = () => `0171${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

describe('the "Fullfilio" tag on imported Shopify orders', () => {
  it('an imported order is queued for the store sync at once (one job, later status changes join it); the job sees the switch on', () =>
    inTx(async (db) => {
      const sku = `IT-${Math.floor(Math.random() * 1e6)}`
      await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const c = await shopify(db)
      const o = await imported(db, c, sku, phone())
      expect(await pendingJobs(db, o)).toBe(1)
      expect(await value<number>(db, `select count(*)::int from public.channel_order_sync where order_id = $1`, [o])).toBe(1)
      await asService(db)
      const ctx = await value<Record<string, any>>(db, `select public.channel_fulfillment_context($1)`, [o])
      expect(ctx.settings).toMatchObject({ import_tag: true, status_tags: true })
      expect(ctx.status_tag).toBe('Fullfilio: New')

      // Approving it before the job ran: still one job for the order.
      await advanceOrder(db, o, ['CONFIRMED'])
      expect(await pendingJobs(db, o)).toBe(1)
    }))

  it('switched off: nothing is queued on import; switched back on, the orders imported meanwhile are queued, the tagged ones are not', () =>
    inTx(async (db) => {
      const sku = `IT2-${Math.floor(Math.random() * 1e6)}`
      await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const c = await shopify(db)
      const owner = await createStaff(db, 'OWNER')

      // Imported while on, and tagged by the job.
      const tagged = await imported(db, c, sku, phone())
      await finishJobs(db, tagged)
      await asService(db)
      await db.query(`select public.channel_order_sync_update($1, '{"status_tag":"Fullfilio | Fullfilio: New"}')`, [tagged])

      await asUser(db, owner)
      expect(await value(db, `select public.channel_sync_settings_save($1, '{"import_tag": false}')`, [c])).toMatchObject({ import_tag: false })
      expect((await value<Record<string, any>>(db, `select public.channel_inventory_overview($1)`, [c])).channel.settings.import_tag).toBe(false)
      const later = await imported(db, c, sku, phone())
      expect(await pendingJobs(db, later)).toBe(0)
      await asService(db)
      expect((await value<Record<string, any>>(db, `select public.channel_fulfillment_context($1)`, [later])).settings.import_tag).toBe(false)

      await asUser(db, owner)
      await db.query(`select public.channel_sync_settings_save($1, '{"import_tag": true}')`, [c])
      expect((await value<Record<string, any>>(db, `select public.channel_inventory_overview($1)`, [c])).channel.settings.import_tag).toBe(true)
      expect(await pendingJobs(db, later)).toBe(1)
      expect(await pendingJobs(db, tagged)).toBe(0)

      // Saving the settings again (still on) queues nothing more.
      await finishJobs(db, later)
      await asUser(db, owner)
      await db.query(`select public.channel_sync_settings_save($1, '{"import_tag": true}')`, [c])
      expect(await pendingJobs(db, later)).toBe(0)
    }))

  it('the catch-up skips disconnected stores and other stores; WooCommerce has no such switch', () =>
    inTx(async (db) => {
      const sku = `IT3-${Math.floor(Math.random() * 1e6)}`
      await createProduct(db, { price: 500, stock: 10, variants: [{ sku, title: 'Default', stock: 10 }] })
      const c = await shopify(db, { import_tag: false })
      const o = await imported(db, c, sku, phone())
      expect(await pendingJobs(db, o)).toBe(0)
      await asSystem(db)
      expect(await value<number>(db, `select public._channel_tag_imported_orders($1)`, [c])).toBe(1)
      await finishJobs(db, o)
      await db.query(`update public.sales_channels set status = 'DISCONNECTED' where id = $1`, [c])
      await db.query(`delete from public.channel_order_sync where order_id = $1`, [o])
      expect(await value<number>(db, `select public._channel_tag_imported_orders($1)`, [c])).toBe(0)

      await asService(db)
      const woo = await value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform: 'WOOCOMMERCE', shop_domain: `https://w${Math.floor(Math.random() * 1e6)}.example.com`, auth_mode: 'KEYS' })])
      await asSystem(db)
      expect((await value<Record<string, any>>(db, `select public.channel_inventory_overview($1)`, [woo])).channel.settings.import_tag).toBe(false)
      expect(await value<number>(db, `select public._channel_tag_imported_orders($1)`, [woo])).toBe(0)
    }))

  it('only the system runs the catch-up', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public._channel_tag_imported_orders(gen_random_uuid())`, [], /permission denied/)
    }))
})
