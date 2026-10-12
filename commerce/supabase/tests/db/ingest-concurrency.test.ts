// The same store order arriving twice at the same moment (a webhook and the hourly sync, or a
// retried delivery) must become exactly one order. This runs as two real transactions on two
// connections, outside the rolled-back transaction the other tests use, so it cleans up after itself.
import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, closePool, getPool, MERCHANT_1, value, type Db } from '../support/db'
import { sellOn } from '../support/fixtures'

afterAll(closePool)

const EXTERNAL_ID = `race-${Date.now()}`

/** The Cloudflare engine runs one statement at a time in one process: there is no race to test
 *  there, and its permanent-record triggers have no replica mode for the clean-up. */
const onEngine = Boolean(process.env.CF_DB_TESTS)

const order = () => ({
  external_id: EXTERNAL_ID, number: `#R${EXTERNAL_ID.slice(-6)}`, cancelled: false,
  customer: { name: 'Race Customer', phone: '+880 1712-000999', email: null },
  shipping: { address: 'House 1, Road 1, Mirpur 10', city: 'Dhaka', state: null, postal_code: '1216', district_hint: 'Dhaka' },
  lines: [{ external_variant_id: 'v-race', external_product_id: 'p-race', sku: null, title: 'Race Tote', variant_title: 'Black', quantity: 1, unit_price: 500, image_url: null }],
  shipping_price: 60, discount_total: 0, total: 560, paid_amount: 0, currency: 'BDT', gateway: 'Cash on Delivery (COD)', note: null, attribution: null,
})

/** One ingest in its own transaction, as a request from an edge function is. */
async function ingestIn(db: Db, channelId: string, via: string): Promise<{ status: string; order_id?: string }> {
  await db.query('begin')
  try {
    await asService(db)
    const r = await value<{ status: string; order_id?: string }>(db, `select public.channel_ingest_order($1, $2, $3)`, [channelId, JSON.stringify(order()), via])
    await db.query('commit')
    return r
  } catch (e) {
    await db.query('rollback')
    throw e
  }
}

describe.skipIf(onEngine)('the same store order arriving twice at once', () => {
  it('becomes one order: one import wins, the other sees a duplicate, nothing is counted twice', async () => {
    const a = (await getPool().connect()) as Db
    const b = (await getPool().connect()) as Db
    let channelId: string | null = null
    let previousMode: string | null = null
    try {
      await a.query('begin')
      await asSystem(a)
      previousMode = await value<string | null>(a, `select value ->> 'mode' from public.settings where merchant_id = $1 and key = 'storefront'`, [MERCHANT_1])
      await sellOn(a, 'SHOPIFY')
      await asService(a)
      channelId = await value<string>(a, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform: 'SHOPIFY', shop_domain: `race-${Date.now()}.myshopify.com`, auth_mode: 'TOKEN' })])
      await a.query('commit')

      const [ra, rb] = await Promise.all([ingestIn(a, channelId, 'WEBHOOK'), ingestIn(b, channelId, 'SYNC')])
      expect([ra.status, rb.status].sort()).toEqual(['DUPLICATE', 'IMPORTED'])
      expect(ra.order_id).toBe(rb.order_id)

      await a.query('begin')
      await asSystem(a)
      expect(await value<number>(a, `select count(*)::int from public.orders where sales_channel_id = $1`, [channelId])).toBe(1)
      expect(await value<number>(a, `select count(*)::int from public.channel_order_imports where channel_id = $1 and external_id = $2`, [channelId, EXTERNAL_ID])).toBe(1)
      expect(await value<number>(a, `select orders_imported::int from public.sales_channels where id = $1`, [channelId])).toBe(1)
      await a.query('commit')
    } finally {
      // Leave the shared test database as it was. The history and ledger tables refuse deletes
      // (as they should), so the clean-up runs with triggers and foreign keys off, as the owner.
      await a.query('rollback').catch(() => undefined)
      await a.query('begin')
      await asSystem(a)
      if (channelId) {
        await a.query(`set local session_replication_role = replica`)
        const orderId = await value<string | null>(a, `select order_id from public.channel_order_imports where channel_id = $1 and external_id = $2`, [channelId, EXTERNAL_ID]).catch(() => null)
        await a.query(`delete from public.channel_order_imports where channel_id = $1`, [channelId])
        if (orderId) {
          for (const t of ['order_status_history', 'order_notes', 'order_attributions', 'stock_reservations', 'order_items']) {
            await a.query(`delete from public.${t} where order_id = $1`, [orderId])
          }
          await a.query(`delete from public.orders where id = $1`, [orderId])
        }
        await a.query(`delete from public.sales_channels where id = $1`, [channelId])
        await a.query(`set local session_replication_role = origin`)
      }
      if (previousMode) await sellOn(a, previousMode as 'OWN' | 'SHOPIFY' | 'WOOCOMMERCE' | 'OFF')
      await a.query('commit').catch(() => a.query('rollback'))
      a.release()
      b.release()
    }
  })
})
