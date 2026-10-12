import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, inTx, value, type Db } from '../support/db'
import { createStaff, sellOn } from '../support/fixtures'

afterAll(closePool)

async function store(db: Db, platform: 'SHOPIFY' | 'WOOCOMMERCE') {
  await asService(db)
  const domain = platform === 'SHOPIFY' ? `s${Math.floor(Math.random() * 1e6)}.myshopify.com` : `https://w${Math.floor(Math.random() * 1e6)}.example.com`
  const id = await value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform, shop_domain: domain, auth_mode: platform === 'SHOPIFY' ? 'TOKEN' : 'KEYS' })])
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED' where id = $1`, [id])
  return id
}

const order = (id: string) => ({
  external_id: id, number: `#${id}`, cancelled: false,
  customer: { name: 'Rina Akter', phone: '01712000901', email: null },
  shipping: { address: 'House 9, Road 2, Mirpur 10', city: 'Dhaka', state: null, postal_code: '1216', district_hint: 'Dhaka' },
  lines: [{ external_variant_id: 'v-1', external_product_id: 'p-1', sku: null, title: 'Tote', variant_title: null, quantity: 1, unit_price: 500, image_url: null }],
  shipping_price: 120, discount_total: 0, total: 620, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null, attribution: null,
})

describe('one store at a time', () => {
  it('only the store picked under "Where do customers buy?" syncs; the others pause and pick up again when picked', () =>
    inTx(async (db) => {
      const shop = await store(db, 'SHOPIFY')
      const woo = await store(db, 'WOOCOMMERCE')
      await sellOn(db, 'SHOPIFY')

      // The store list and the function say which one is in use.
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const inUse = async () => Object.fromEntries((await value<Array<{ id: string; in_use: boolean }>>(db, `select public.sales_channels_list()`))
        .filter((c) => c.id === shop || c.id === woo).map((c) => [c.id === shop ? 'shopify' : 'woo', c.in_use]))
      expect(await inUse()).toEqual({ shopify: true, woo: false })
      await asService(db)
      expect(await value(db, `select public.channel_in_use($1)`, [woo])).toBe(false)

      // A paused store's orders are not imported (nothing is recorded).
      expect(await value(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [woo, JSON.stringify(order('W1'))])).toEqual({ status: 'SKIPPED', reason: 'PAUSED' })
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.channel_order_imports where channel_id = $1`, [woo])).toBe(0)

      // Store jobs: the paused store's job waits; the scheduler only wakes the server for the store in use.
      await db.query(`delete from public.channel_sync_jobs`)
      const wooJob = await value<string>(db, `select public.channel_job_enqueue($1, 'FULFILL', gen_random_uuid(), '{}', 0)`, [woo])
      expect(await value(db, `select public.channel_jobs_due()`)).toBe(false)
      expect(await value(db, `select public.channels_sync_due()`)).toBe(true)
      const shopJob = await value<string>(db, `select public.channel_job_enqueue($1, 'FULFILL', gen_random_uuid(), '{}', 0)`, [shop])
      expect(await value(db, `select public.channel_jobs_due()`)).toBe(true)
      await asService(db)
      expect(await value(db, `select array_agg(id) from public.channel_jobs_claim(10)`)).toEqual([shopJob])

      // "Our store": every connection pauses; nothing calls the server.
      await sellOn(db, 'OWN')
      await asSystem(db)
      await db.query(`update public.channel_sync_jobs set status = 'PENDING', locked_until = null where id = $1`, [shopJob])
      expect(await value(db, `select public.channel_jobs_due()`)).toBe(false)
      expect(await value(db, `select public.channels_sync_due()`)).toBe(false)
      await asService(db)
      expect(await value(db, `select count(*)::int from public.channel_jobs_claim(10)`)).toBe(0)

      // Picking WooCommerce: its waiting job runs now, and its orders come in.
      await sellOn(db, 'WOOCOMMERCE')
      await asService(db)
      expect(await value(db, `select array_agg(id) from public.channel_jobs_claim(10)`)).toEqual([wooJob])
      expect(await value(db, `select public.channel_in_use($1)`, [shop])).toBe(false)
      await asUser(db, owner)
      expect(await inUse()).toEqual({ shopify: false, woo: true })
    }))

  it('only the system asks whether a store is in use', () =>
    inTx(async (db) => {
      const shop = await store(db, 'SHOPIFY')
      await asUser(db, await createStaff(db, 'OWNER'))
      await expect(db.query(`select public.channel_in_use($1)`, [shop])).rejects.toThrow(/permission denied/)
    }))
})
