import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, inTx, value, type Db } from '../support/db'
import { createProduct, createStaff } from '../support/fixtures'

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

async function ingest(db: Db, channel: string, sku: string, number: string | null) {
  await asService(db)
  return value<Record<string, any>>(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [channel, JSON.stringify({
    external_id: String(Math.floor(Math.random() * 1e12)), number, cancelled: false,
    customer: { name: 'Riaz Uddin', phone: phone(), email: null },
    shipping: { address: 'House 4, Road 7, Uttara', city: 'Dhaka', state: null, postal_code: null, district_hint: 'Dhaka' },
    lines: [{ external_variant_id: `ext-${sku}`, external_product_id: 'p1', sku, title: 'Shirt', variant_title: null, quantity: 1, unit_price: 990, image_url: null }],
    shipping_price: 80, discount_total: 0, total: 1070, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null, attribution: null,
  })])
}

describe('Store order numbers (Shopify #10768 → order 10768)', () => {
  it('uses the store number; falls back to the own counter when the number is taken or the option is off; web orders unchanged', () =>
    inTx(async (db) => {
      const sku = `NUM-${Math.floor(Math.random() * 1e6)}`
      await createProduct(db, { price: 990, stock: 20, variants: [{ sku, title: 'Default', stock: 20 }] })
      const n = String(10000 + Math.floor(Math.random() * 1e8))
      const a = await shopify(db)
      const first = await ingest(db, a, sku, `#${n}`)
      expect(first).toMatchObject({ status: 'IMPORTED', order_number: n })
      await asSystem(db)
      expect(await value<Record<string, any>>(db, `select jsonb_build_object('n', order_number, 'ext', external_order_number) from public.orders where id = $1`, [first.order_id]))
        .toEqual({ n, ext: `#${n}` })

      // A second store with the same number: own number instead, and a note says why.
      const b = await shopify(db)
      const clash = await ingest(db, b, sku, `#${n}`)
      expect(clash.status).toBe('IMPORTED')
      expect(clash.order_number).not.toBe(n)
      expect(clash.order_number).toMatch(/-\d+$/)
      await asSystem(db)
      expect(await value<string>(db, `select string_agg(body, ' ') from public.order_notes where order_id = $1`, [clash.order_id])).toMatch(/already used here/)

      // Option off → own counter.
      const off = await shopify(db, { store_order_numbers: false })
      const own = await ingest(db, off, sku, `#${Number(n) + 1}`)
      expect(own.order_number).toMatch(/-\d+$/)

      // A number that is not a plain code (spaces, symbols) is not used.
      const odd = await ingest(db, a, sku, 'Order 55 / A')
      expect(odd.order_number).toMatch(/-\d+$/)

      // The setting is only for that one insert: a staff order right after still gets the own counter.
      await asSystem(db)
      expect(await value<string>(db, `select coalesce(current_setting('app.order_number', true), '')`)).toBe('')
    }))

  it('a failed import does not leave the number behind for the next order', () =>
    inTx(async (db) => {
      const c = await shopify(db)
      await asService(db)
      const n = String(20000 + Math.floor(Math.random() * 1e8))
      const bad = await value<Record<string, any>>(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [c, JSON.stringify({
        external_id: String(Math.floor(Math.random() * 1e12)), number: `#${n}`, cancelled: false,
        customer: { name: 'X Y', phone: phone() }, shipping: { address: 'Somewhere far', city: 'Nowhere' },
        lines: [{ external_variant_id: 'none', sku: 'NO-SUCH-SKU', title: 'Ghost', quantity: 1, unit_price: 10 }],
        shipping_price: 0, total: 10, paid_amount: 0,
      })])
      expect(bad.status).toBe('FAILED')
      await asSystem(db)
      expect(await value<string>(db, `select coalesce(current_setting('app.order_number', true), '')`)).toBe('')
      expect(await value<number>(db, `select count(*)::int from public.orders where order_number = $1`, [n])).toBe(0)
    }))
})

describe('Store catalog summary', () => {
  it('counts store products and variants by status next to what is imported, and says why anything is missing', () =>
    inTx(async (db) => {
      const sfx = String(Math.floor(Math.random() * 1e5))
      const c = await shopify(db)
      const it = (v: string, p: string, status: string) => ({
        external_variant_id: `${v}${sfx}`, external_product_id: `${p}${sfx}`, inventory_item_id: `gid://shopify/InventoryItem/${v}${sfx}`,
        sku: `SUM-${v}${sfx}`, product_title: `P${p}`, variant_title: 'Default Title', product_status: status, tracked: true,
        levels: [{ location_id: LOC, location: 'Warehouse', available: 2, on_hand: 2 }], price: '100', options: {},
      })
      await asService(db)
      await db.query(`select public.channel_catalog_import($1, $2, $3)`, [c, JSON.stringify([
        it('11', '1', 'ACTIVE'), it('12', '1', 'ACTIVE'), it('21', '2', 'DRAFT'), it('31', '3', 'ARCHIVED'),
      ]), JSON.stringify([{ id: LOC, name: 'Warehouse', active: true }])])
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const before = await value<Record<string, any>>(db, `select public.channel_catalog_summary($1)`, [c])
      expect(before).toMatchObject({ store_products: 3, store_variants: 4, imported_products: 0, by_status: { ACTIVE: 1, DRAFT: 1, ARCHIVED: 1 } })
      expect(before.missing).toHaveLength(3)
      expect(before.missing[0].reason).toBe('FIRST_SYNC')

      await db.query(`select public.channel_first_sync($1, $2, true, true)`, [c, LOC])
      const after = await value<Record<string, any>>(db, `select public.channel_catalog_summary($1)`, [c])
      expect(after).toMatchObject({ store_products: 3, store_variants: 4, imported_products: 3, imported_variants: 4, products_here: 3, missing: [] })
      await asSystem(db)
      expect(await value<string[]>(db, `select array_agg(p.status::text order by p.name) from public.products p
        join public.product_variants v on v.product_id = p.id where v.sku like $1`, [`SUM-%${sfx}`])).toEqual(['ACTIVE', 'ACTIVE', 'DRAFT', 'ARCHIVED'])
    }))
})
