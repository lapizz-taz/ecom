import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { advanceOrder, createProduct, createStaff, inventory } from '../support/fixtures'

afterAll(closePool)

async function store(db: Db, platform: 'SHOPIFY' | 'WOOCOMMERCE', settings: Record<string, unknown> = {}) {
  await asService(db)
  const domain = platform === 'SHOPIFY' ? `s${Math.floor(Math.random() * 1e6)}.myshopify.com` : `https://w${Math.floor(Math.random() * 1e6)}.example.com`
  const id = await value<string>(db, `select (public.channel_upsert($1, null)).id`, [JSON.stringify({ platform, shop_domain: domain, auth_mode: platform === 'SHOPIFY' ? 'TOKEN' : 'KEYS' })])
  await asSystem(db)
  await db.query(`update public.sales_channels set status = 'CONNECTED', settings = settings || $2::jsonb where id = $1`, [id, JSON.stringify(settings)])
  return id
}

const wooItems = (sfx: string) => [
  { external_variant_id: `11${sfx}`, external_product_id: `10${sfx}`, inventory_item_id: `products/10${sfx}/variations/11${sfx}`, sku: `HOOD-${sfx}-M`, barcode: null,
    product_title: `Hoodie ${sfx}`, variant_title: 'M / Black', product_status: 'ACTIVE', tracked: true,
    levels: [{ location_id: 'default', location: 'Store stock', available: 7, on_hand: 7 }],
    price: '1450', compare_at_price: '1650', image_url: 'https://cdn.example.com/h.jpg', options: { Size: 'M', Colour: 'Black' }, product_description: 'Warm' },
  { external_variant_id: `12${sfx}`, external_product_id: `10${sfx}`, inventory_item_id: `products/10${sfx}/variations/12${sfx}`, sku: `HOOD-${sfx}-L`, barcode: null,
    product_title: `Hoodie ${sfx}`, variant_title: 'L / Black', product_status: 'ACTIVE', tracked: true,
    levels: [{ location_id: 'default', location: 'Store stock', available: 3, on_hand: 3 }],
    price: '1450', compare_at_price: null, image_url: null, options: { Size: 'L', Colour: 'Black' }, product_description: 'Warm' },
  { external_variant_id: `20${sfx}`, external_product_id: `20${sfx}`, inventory_item_id: `products/20${sfx}`, sku: null, barcode: null,
    product_title: `Gift card ${sfx}`, variant_title: 'Default Title', product_status: 'DRAFT', tracked: false,
    levels: [{ location_id: 'default', location: 'Store stock', available: null, on_hand: null }], price: '500', options: {} },
]

describe('Store catalog import', () => {
  it('WooCommerce: catalog keeps prices and options; importing previews first, then creates products, links them and records opening stock', () =>
    inTx(async (db) => {
      const sfx = String(Math.floor(Math.random() * 1e5))
      const c = await store(db, 'WOOCOMMERCE', { location_id: 'default' })
      await asService(db)
      const r = await value<{ items: number; linked: number }>(db, `select public.channel_catalog_import($1, $2, $3)`,
        [c, JSON.stringify(wooItems(sfx)), JSON.stringify([{ id: 'default', name: 'Store stock', active: true }])])
      expect(r).toMatchObject({ items: 3, linked: 0 })

      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const list = await value<Array<Record<string, any>>>(db, `select public.channel_catalog_products($1, null)`, [c])
      expect(list.find((p) => p.product_id === `10${sfx}`)).toMatchObject({ variants: 2, linked: 0, stock: 10 })

      // Preview changes nothing.
      const plan = await value<Record<string, any>>(db, `select public.channel_catalog_adopt($1, $2, true, false)`, [c, [`10${sfx}`]])
      expect(plan).toMatchObject({ applied: false, created: 0 })
      expect(plan.plan).toEqual([
        expect.objectContaining({ action: 'CREATE', sku: `HOOD-${sfx}-M`, stock: 7 }),
        expect.objectContaining({ action: 'CREATE', sku: `HOOD-${sfx}-L`, stock: 3 }),
      ])
      expect(await value<number>(db, `select count(*)::int from public.product_variants where sku like $1`, [`HOOD-${sfx}-%`])).toBe(0)

      const done = await value<Record<string, any>>(db, `select public.channel_catalog_adopt($1, $2, true, true)`, [c, [`10${sfx}`, `20${sfx}`]])
      expect(done).toMatchObject({ applied: true, created: 3, linked: 0 })
      await asSystem(db)
      const prod = await value<Record<string, any>>(db, `select to_jsonb(p) from public.products p join public.product_variants v on v.product_id = p.id where v.sku = $1`, [`HOOD-${sfx}-M`])
      expect(prod).toMatchObject({ name: `Hoodie ${sfx}`, status: 'ACTIVE', track_inventory: true, option_names: ['Colour', 'Size'] })
      expect(Number(prod.price)).toBe(1450)
      const vm = await value<Record<string, any>>(db, `select to_jsonb(v) from public.product_variants v where sku = $1`, [`HOOD-${sfx}-M`])
      expect(vm).toMatchObject({ title: 'M / Black', option_values: { Size: 'M', Colour: 'Black' } })
      expect(Number(vm.compare_at_price)).toBe(1650)
      expect(await inventory(db, vm.id)).toMatchObject({ on_hand: 7, reserved: 0 })
      // Opening stock is a recorded movement, and the link starts in step (nothing pushed back).
      expect(await value<number>(db, `select count(*)::int from public.inventory_movements where variant_id = $1 and movement_type = 'ADJUSTMENT' and on_hand_change = 7`, [vm.id])).toBe(1)
      expect(await value<Record<string, any>>(db, `select to_jsonb(m) from public.sales_channel_variants m where channel_id = $1 and external_variant_id = $2`, [c, `11${sfx}`]))
        .toMatchObject({ variant_id: vm.id, inventory_item_id: `products/10${sfx}/variations/11${sfx}`, last_pushed_qty: 7, sync_status: 'OK' })
      // Untracked item: created, but not synced; draft stays draft; SKU made from the store id.
      expect(await value<Record<string, any>>(db, `select jsonb_build_object('status', p.status, 'sync', m.sync_status) from public.sales_channel_variants m
        join public.product_variants v on v.id = m.variant_id join public.products p on p.id = v.product_id where m.channel_id = $1 and m.external_variant_id = $2`, [c, `20${sfx}`]))
        .toEqual({ status: 'DRAFT', sync: 'UNTRACKED' })
      expect(await value<string>(db, `select v.sku from public.sales_channel_variants m join public.product_variants v on v.id = m.variant_id where m.channel_id = $1 and m.external_variant_id = $2`, [c, `20${sfx}`]))
        .toBe(`WOO-20${sfx}`)

      // Importing again creates nothing twice.
      await asUser(db, owner)
      const again = await value<Record<string, any>>(db, `select public.channel_catalog_adopt($1, $2, true, true)`, [c, [`10${sfx}`]])
      expect(again).toMatchObject({ created: 0, linked: 0 })
      expect(again.plan.every((p: { action: string }) => p.action === 'ALREADY_LINKED')).toBe(true)

      // Changing our stock queues a WooCommerce push like Shopify's.
      await asSystem(db)
      await db.query(`update public.sales_channels set settings = settings || '{"inventory_sync":true}' where id = $1`, [c])
      await db.query(`select public._apply_inventory_movement($1, 'ADJUSTMENT', -2, 0, 0, null, null, null, 'test', null, false)`, [vm.id])
      expect(await value<string>(db, `select status from public.channel_sync_jobs where kind = 'INVENTORY' and ref_id = $1 and channel_id = $2`, [vm.id, c])).toBe('PENDING')
      const ctx = await value<Record<string, any>>(db, `select public.channel_inventory_context($1, $2)`, [c, vm.id])
      expect(ctx).toMatchObject({ desired: 5, last_pushed_qty: 7, location_id: 'default', inventory_item_id: `products/10${sfx}/variations/11${sfx}` })
      // A stock edit seen from WordPress (product.updated) is checked by a job.
      await asService(db)
      expect(await value<Record<string, any>>(db, `select public.channel_inventory_seen($1, $2, 'default', 4)`, [c, `products/10${sfx}/variations/12${sfx}`]))
        .toMatchObject({ status: 'OK', queued: 1 })
    }))

  it('existing SKUs are linked instead of duplicated; opening stock needs the stock permission', () =>
    inTx(async (db) => {
      const sfx = String(Math.floor(Math.random() * 1e5))
      const p = await createProduct(db, { price: 1400, stock: 2, variants: [{ sku: `HOOD-${sfx}-M`, title: 'M', stock: 2 }] })
      const c = await store(db, 'SHOPIFY')
      await asService(db)
      // The importer links HOOD-M by SKU on its own; L is new.
      await db.query(`select public.channel_catalog_import($1, $2, '[]')`, [c, JSON.stringify(wooItems(sfx).slice(0, 2))])
      const support = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, support)
      await expectError(db, `select public.channel_catalog_adopt($1, $2, false, true)`, [c, [`10${sfx}`]], /permission/i)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const done = await value<Record<string, any>>(db, `select public.channel_catalog_adopt($1, $2, false, true)`, [c, [`10${sfx}`]])
      expect(done.plan.map((x: { action: string }) => x.action)).toEqual(['ALREADY_LINKED', 'CREATE'])
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.product_variants where sku ilike $1`, [`HOOD-${sfx}-M`])).toBe(1)
      expect(await inventory(db, p.variantIds[0])).toMatchObject({ on_hand: 2 })
      // Without "with stock", the new variant starts at zero and is not marked in step.
      const l = await value<string>(db, `select id from public.product_variants where sku = $1`, [`HOOD-${sfx}-L`])
      expect(await inventory(db, l)).toMatchObject({ on_hand: 0 })
      expect(await value<string>(db, `select sync_status from public.sales_channel_variants where channel_id = $1 and variant_id = $2`, [c, l])).toBe('NEW')
    }))
})

describe('WooCommerce fulfilment', () => {
  it('is off unless turned on for the store; Shopify stays on by default', () =>
    inTx(async (db) => {
      const sfx = String(Math.floor(Math.random() * 1e5))
      await createProduct(db, { price: 500, stock: 10, variants: [{ sku: `WTOTE-${sfx}`, title: 'Default', stock: 10 }] })
      const ship = async (channel: string, ext: string) => {
        await asService(db)
        const r = await value<{ order_id: string }>(db, `select public.channel_ingest_order($1, $2, 'WEBHOOK')`, [channel, JSON.stringify({
          external_id: ext, number: `#${ext}`, cancelled: false,
          customer: { name: 'Rina Akter', phone: '01712000811', email: 'rina@example.com' },
          shipping: { address: 'House 9, Road 2, Mirpur 10', city: 'Dhaka', state: null, postal_code: '1216', district_hint: 'Dhaka' },
          lines: [{ external_variant_id: `w-${sfx}`, external_product_id: 'p1', sku: `WTOTE-${sfx}`, title: 'Tote', variant_title: null, quantity: 1, unit_price: 500, image_url: null }],
          shipping_price: 80, discount_total: 0, total: 580, paid_amount: 0, currency: 'BDT', gateway: 'COD', note: null, attribution: null,
        })])
        await advanceOrder(db, r.order_id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED'])
        await asSystem(db)
        return value<number>(db, `select count(*)::int from public.channel_sync_jobs where kind = 'FULFILL' and ref_id = $1`, [r.order_id])
      }
      expect(await ship(await store(db, 'WOOCOMMERCE'), `${sfx}1`)).toBe(0)
      expect(await ship(await store(db, 'WOOCOMMERCE', { fulfill_on_ship: true }), `${sfx}2`)).toBe(1)
      expect(await ship(await store(db, 'SHOPIFY'), `${sfx}3`)).toBe(1)
    }))
})
