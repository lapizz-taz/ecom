import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, inTx, value, type Db } from '../support/db'
import { createProduct, createStaff, sellOn } from '../support/fixtures'

afterAll(closePool)

// Products an imported order created (before the store product was imported) follow the
// store's stock once stock syncs, instead of staying at 0 and "Not synced yet".

const LOC = 'gid://shopify/Location/1'

async function shopify(db: Db) {
  await asService(db)
  const id = await value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform: 'SHOPIFY', shop_domain: `o${Math.floor(Math.random() * 1e6)}.myshopify.com`, auth_mode: 'TOKEN' })])
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED' where id = $1`, [id])
  await sellOn(db, 'SHOPIFY')
  return id
}

const item = (variant: string, product: string, sku: string, qty: number) => ({
  external_variant_id: variant, external_product_id: product, inventory_item_id: `gid://shopify/InventoryItem/${variant}`,
  sku, barcode: null, product_title: `Belt ${variant}`, variant_title: 'Default Title', product_status: 'ACTIVE', tracked: true,
  levels: [{ location_id: LOC, location: 'Shop location', available: qty, on_hand: qty }],
  price: '899', compare_at_price: '1599', unit_cost: '274.7', options: {}, images: [], image_url: null,
  vendor: 'Isolation', product_type: null, tags: [], weight_grams: null, product_description: null,
})

async function readCatalog(db: Db, c: string, items: unknown[]) {
  await asService(db)
  await db.query(`select public.channel_catalog_import($1, $2, $3)`, [c, JSON.stringify(items), JSON.stringify([{ id: LOC, name: 'Shop location', active: true }])])
}

async function firstSync(db: Db, c: string, autoImport = true) {
  const owner = await createStaff(db, 'OWNER')
  await asUser(db, owner)
  await db.query(`select public.channel_first_sync($1, $2, $3, true)`, [c, LOC, autoImport])
}

/** A Shopify order for one item, imported like the webhook does. */
async function order(db: Db, c: string, ext: string, variant: string, product: string, sku: string) {
  await asService(db)
  const r = await value<{ status: string }>(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [c, JSON.stringify({
    external_id: ext, number: `#${ext}`, cancelled: false,
    customer: { name: 'Rina Akter', phone: '01712000811', email: null },
    shipping: { address: 'House 9, Road 2, Mirpur 10', city: 'Dhaka', state: null, postal_code: '1216', district_hint: 'Dhaka' },
    lines: [{ external_variant_id: variant, external_product_id: product, sku, title: `Belt ${variant}`, variant_title: null, quantity: 1, unit_price: 899, image_url: null }],
    shipping_price: 80, discount_total: 0, total: 979, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null, attribution: null,
  })])
  expect(r.status).toBe('IMPORTED')
}

async function state(db: Db, c: string, variant: string) {
  await asSystem(db)
  return value<Record<string, unknown>>(db, `
    select jsonb_build_object('track', p.track_inventory, 'on_hand', i.on_hand, 'reserved', i.reserved, 'sync', m.sync_status,
      'store', m.shopify_available, 'pushed', m.last_pushed_qty, 'item', m.inventory_item_id)
    from public.sales_channel_variants m
    join public.product_variants v on v.id = m.variant_id
    join public.products p on p.id = v.product_id
    left join public.inventory i on i.variant_id = v.id
    where m.channel_id = $1 and m.external_variant_id = $2`, [c, variant])
}

describe('Products made by imported orders follow the store stock', () => {
  it('an order before the first sync: the first sync gives the product the store tracking and number', () =>
    inTx(async (db) => {
      const n = String(Math.floor(Math.random() * 1e6))
      const c = await shopify(db)
      await readCatalog(db, c, [item(`1${n}`, `10${n}`, `BELT-${n}`, 5), item(`2${n}`, `20${n}`, `CHAIN-${n}`, 7)])
      // Right after connecting, an order brings an item no product exists for yet.
      await order(db, c, `A${n}`, `1${n}`, `10${n}`, `BELT-${n}`)
      expect(await state(db, c, `1${n}`)).toMatchObject({ track: false, on_hand: 0 })

      await firstSync(db, c)
      expect(await state(db, c, `1${n}`)).toMatchObject({ track: true, on_hand: 5, reserved: 0, sync: 'OK', store: 5, pushed: 5, item: `gid://shopify/InventoryItem/1${n}` })
      // Imported normally, as before.
      expect(await state(db, c, `2${n}`)).toMatchObject({ track: true, on_hand: 7, sync: 'OK' })
      await asSystem(db)
      expect(await value<string>(db, `select m.reference_label from public.inventory_movements m join public.sales_channel_variants x on x.variant_id = m.variant_id
        where x.channel_id = $1 and x.external_variant_id = $2`, [c, `1${n}`])).toMatch(/^Opening stock from /)
    }))

  it('after the first sync: never in the middle of its own order (counted once), then from the next read of the store product', () =>
    inTx(async (db) => {
      const n = String(Math.floor(Math.random() * 1e6))
      const c = await shopify(db)
      await readCatalog(db, c, [])
      await firstSync(db, c, false)
      // Listed in the store with 4 (not imported: automatic import is off).
      await asService(db)
      await db.query(`select public.channel_catalog_product_upsert($1, $2, $3)`, [c, `30${n}`, JSON.stringify([item(`3${n}`, `30${n}`, `CLIP-${n}`, 4)])])
      // The order for one of them makes the product here; it does not reserve anything.
      await order(db, c, `B${n}`, `3${n}`, `30${n}`, `CLIP-${n}`)
      expect(await state(db, c, `3${n}`)).toMatchObject({ track: false, on_hand: 0 })
      // The store now has 3 (the order took one); that is the number here, with nothing reserved.
      await asService(db)
      await db.query(`select public.channel_catalog_product_upsert($1, $2, $3)`, [c, `30${n}`, JSON.stringify([item(`3${n}`, `30${n}`, `CLIP-${n}`, 3)])])
      expect(await state(db, c, `3${n}`)).toMatchObject({ track: true, on_hand: 3, reserved: 0, sync: 'OK', store: 3, pushed: 3 })
    }))

  it('after the first sync: the store product read later gives the order-made product its number', () =>
    inTx(async (db) => {
      const n = String(Math.floor(Math.random() * 1e6))
      const c = await shopify(db)
      await readCatalog(db, c, [])
      await firstSync(db, c)
      await order(db, c, `C${n}`, `4${n}`, `40${n}`, `RING-${n}`)
      // Nothing known about it in the store yet: it waits.
      expect(await state(db, c, `4${n}`)).toMatchObject({ track: false, on_hand: 0 })
      await asService(db)
      await db.query(`select public.channel_catalog_product_upsert($1, $2, $3)`, [c, `40${n}`, JSON.stringify([item(`4${n}`, `40${n}`, `RING-${n}`, 3)])])
      expect(await state(db, c, `4${n}`)).toMatchObject({ track: true, on_hand: 3, sync: 'OK' })
      // One product, not a second import of it.
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.product_variants where sku = $1`, [`RING-${n}`])).toBe(1)
    }))

  it('leaves alone products someone made without stock, and order-made ones whose stock was already changed', () =>
    inTx(async (db) => {
      const n = String(Math.floor(Math.random() * 1e6))
      // Made here by staff, counting no stock on purpose; the store lists the same SKU.
      const mine = await createProduct(db, { price: 500, variants: [{ sku: `GIFT-${n}`, title: 'Default' }] })
      await asSystem(db)
      await db.query(`update public.products set track_inventory = false where id = (select product_id from public.product_variants where id = $1)`, [mine.variantIds[0]])
      const c = await shopify(db)
      await readCatalog(db, c, [item(`5${n}`, `50${n}`, `GIFT-${n}`, 9), item(`6${n}`, `60${n}`, `TOTE-${n}`, 6)])
      await order(db, c, `D${n}`, `6${n}`, `60${n}`, `TOTE-${n}`)
      // Someone set the order-made product's stock by hand before the first sync.
      await asSystem(db)
      const tote = await value<string>(db, `select variant_id from public.sales_channel_variants where channel_id = $1 and external_variant_id = $2`, [c, `6${n}`])
      await db.query(`select public._apply_inventory_movement($1, 'ADJUSTMENT', 2, 0, 0, null, null, 'Counted', 'by hand', null, false)`, [tote])

      await firstSync(db, c)
      expect(await state(db, c, `5${n}`)).toMatchObject({ track: false })
      expect(await state(db, c, `6${n}`)).toMatchObject({ track: false, on_hand: 2 })
    }))
})
