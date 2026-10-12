import { randomUUID } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import type { Context } from './context.ts'
import { callRpc } from './rpc/index.ts'
import type { Sql } from './sql.ts'
import { asService, asUser, createMerchant, createStaff, freshDatabase, MERCHANT_1, rest, rolledBack } from './testing.ts'

let sql: Sql
beforeAll(() => {
  sql = freshDatabase()
})

/** A product saved the way the catalog editor saves it (as the store's server). */
function createProduct(input: { price: number; cost?: number; stock?: number; trackInventory?: boolean; variants?: Array<{ sku: string; title: string; stock?: number }> }, as: Context = asService(sql)) {
  const suffix = randomUUID().slice(0, 6)
  const product = callRpc(sql, as, 'admin_save_product', {
    p_payload: {
      name: `Product ${suffix}`, status: 'ACTIVE', price: input.price, cost_price: input.cost ?? 0, track_inventory: input.trackInventory ?? true,
      variants: (input.variants ?? [{ sku: `SKU-${suffix}`, title: 'Default', stock: input.stock ?? 10 }])
        .map((v) => ({ sku: v.sku, title: v.title, initial_stock: v.stock ?? input.stock ?? 10 })),
    },
  }) as { id: string }
  const variantIds = sql.all('SELECT id FROM product_variants WHERE product_id = ? ORDER BY position', [product.id]).map((r) => String(r.id))
  return { productId: product.id, variantIds }
}

const stock = (variantId: string) => {
  const r = sql.all('SELECT on_hand, reserved, available, damaged FROM inventory WHERE variant_id = ?', [variantId])[0]
  return { on_hand: r.on_hand, reserved: r.reserved, available: r.available, damaged: r.damaged }
}

describe('products', () => {
  it('saves a product with variants, opening stock and one default variant', () => rolledBack(sql, () => {
    const p = createProduct({ price: 1200, cost: 500, variants: [{ sku: 'TEE-S', title: 'Small', stock: 4 }, { sku: 'TEE-M', title: 'Medium', stock: 6 }] })
    expect(p.variantIds).toHaveLength(2)
    expect(stock(p.variantIds[0])).toEqual({ on_hand: 4, reserved: 0, available: 4, damaged: 0 })
    expect(stock(p.variantIds[1]).on_hand).toBe(6)
    const variants = sql.all('SELECT sku, is_default, is_active FROM product_variants WHERE product_id = ? ORDER BY position', [p.productId])
    expect(variants).toEqual([{ sku: 'TEE-S', is_default: 1, is_active: 1 }, { sku: 'TEE-M', is_default: 0, is_active: 1 }])
    const opening = sql.all("SELECT movement_type, quantity, note, unit_cost FROM inventory_movements WHERE variant_id = ?", [p.variantIds[0]])
    expect(opening).toEqual([{ movement_type: 'ADJUSTMENT', quantity: 4, note: 'Opening stock', unit_cost: 500 }])
    // Saving again with one variant left keeps the other's history but switches it off.
    const product = sql.all('SELECT * FROM products WHERE id = ?', [p.productId])[0]
    callRpc(sql, asService(sql), 'admin_save_product', { p_payload: { id: p.productId, name: product.name, price: 1300, variants: [{ id: p.variantIds[1], sku: 'TEE-M', title: 'Medium' }] } })
    expect(sql.all('SELECT sku, is_default, is_active FROM product_variants WHERE product_id = ? ORDER BY sku', [p.productId]))
      .toEqual([{ sku: 'TEE-M', is_default: 1, is_active: 1 }, { sku: 'TEE-S', is_default: 0, is_active: 0 }])
    expect(sql.all('SELECT price FROM products WHERE id = ?', [p.productId])[0].price).toBe(1300)
  }))

  it('validates like before and gives a product without variants a Default one', () => rolledBack(sql, () => {
    const svc = asService(sql)
    expect(() => callRpc(sql, svc, 'admin_save_product', { p_payload: { name: '', price: 10 } })).toThrow(/product name is required/)
    expect(() => callRpc(sql, svc, 'admin_save_product', { p_payload: { name: 'X', price: -1 } })).toThrow(/price must be zero or more/)
    expect(() => callRpc(sql, svc, 'admin_save_product', { p_payload: { name: 'X', price: 1, variants: [{ sku: ' ' }] } })).toThrow(/every variant needs a SKU/)
    const product = callRpc(sql, svc, 'admin_save_product', { p_payload: { name: 'Plain Mug!', price: 250 } }) as { id: string; slug: string; status: string }
    expect(product).toMatchObject({ slug: 'plain-mug', status: 'DRAFT' })
    const v = sql.all('SELECT sku, title, is_default FROM product_variants WHERE product_id = ?', [product.id])
    expect(v).toEqual([{ sku: `PLAIN-MUG-${product.id.slice(0, 6)}`, title: 'Default', is_default: 1 }])
  }))

  it('quick and bulk edits change price, cost, status and category; the audit log records them', () => rolledBack(sql, () => {
    const owner = createStaff(sql, 'OWNER')
    const me = asUser(sql, owner)
    const a = createProduct({ price: 100, cost: 40 })
    const b = createProduct({ price: 200, cost: 90 })
    const quick = callRpc(sql, me, 'admin_product_quick_update', { p_id: a.productId, p: { price: 150.555, active: false } })
    expect(quick).toMatchObject({ price: 150.56, status: 'ARCHIVED' })
    const cat = callRpc(sql, me, 'admin_save_product', { p_payload: { name: 'unused', price: 1 } }) as { id: string }
    void cat
    sql.run("INSERT INTO categories (id, merchant_id, name, slug) VALUES (?, ?, 'Hats', 'hats')", ['11111111-1111-4111-8111-111111111111', MERCHANT_1])
    const bulk = callRpc(sql, me, 'admin_products_bulk_update', { p_ids: [a.productId, b.productId], p: { cost_price: 50, category_id: '11111111-1111-4111-8111-111111111111' } })
    expect(bulk).toEqual({ updated: 2 })
    expect(sql.all('SELECT cost_price, category_id FROM products WHERE id IN (?, ?) ORDER BY price', [a.productId, b.productId]))
      .toEqual([{ cost_price: 50, category_id: '11111111-1111-4111-8111-111111111111' }, { cost_price: 50, category_id: '11111111-1111-4111-8111-111111111111' }])
    expect(Number(sql.all("SELECT count(*) AS n FROM audit_logs WHERE action = 'products.bulk_update' AND actor_id = ?", [owner])[0].n)).toBe(1)
    expect(Number(sql.all("SELECT count(*) AS n FROM audit_logs WHERE action = 'products.update' AND entity_id = ?", [a.productId])[0].n)).toBeGreaterThan(0)
  }))

  it('product stats count stock and value; staff without products.view are refused', () => rolledBack(sql, () => {
    const owner = createStaff(sql, 'OWNER')
    createProduct({ price: 100, cost: 40, stock: 3 })
    const stats = callRpc(sql, asUser(sql, owner), 'admin_product_stats', {}) as Record<string, number>
    expect(stats.stock).toBeGreaterThanOrEqual(3)
    expect(stats.sell_value).toBeGreaterThanOrEqual(300)
    const other = createMerchant(sql)
    const outsider = createStaff(sql, 'VIEWER', other)
    expect(() => callRpc(sql, asUser(sql, outsider), 'admin_product_stats', {})).toThrow(/PERMISSION_DENIED/)
  }))

  it('respects the plan\'s product limit', () => rolledBack(sql, () => {
    const plan = sql.all("SELECT id FROM plans WHERE code = 'STARTER'")[0].id as string
    sql.run("UPDATE plans SET limits = json_set(limits, '$.products', 1) WHERE id = ?", [plan])
    sql.run('UPDATE subscriptions SET ended_at = ? WHERE merchant_id = ?', [new Date().toISOString(), MERCHANT_1])
    sql.run(`INSERT INTO subscriptions (id, merchant_id, plan_id, status, price, billing_interval) VALUES (?, ?, ?, 'ACTIVE', 0, 'MONTHLY')`, [randomUUID(), MERCHANT_1, plan])
    const existing = Number(sql.all("SELECT count(*) AS n FROM products WHERE merchant_id = ? AND status <> 'ARCHIVED'", [MERCHANT_1])[0].n)
    if (existing === 0) createProduct({ price: 1 })
    expect(() => createProduct({ price: 1 })).toThrow(/LIMIT_REACHED: your plan allows 1 products/)
  }))
})

describe('stock', () => {
  it('adds, removes and sets stock with an audited movement', () => rolledBack(sql, () => {
    const p = createProduct({ price: 100, stock: 10 })
    const staff = createStaff(sql, 'INVENTORY_MANAGER')
    const me = asUser(sql, staff)
    const v = p.variantIds[0]
    callRpc(sql, me, 'adjust_stock', { p_variant_id: v, p_type: 'ADJUSTMENT', p_quantity: 5, p_note: 'Found in back room', p_mode: 'ADD' })
    callRpc(sql, me, 'adjust_stock', { p_variant_id: v, p_type: 'ADJUSTMENT', p_quantity: 3, p_note: 'Counted wrong', p_mode: 'REMOVE' })
    callRpc(sql, me, 'adjust_stock', { p_variant_id: v, p_type: 'ADJUSTMENT', p_quantity: 20, p_note: 'Stock take', p_mode: 'SET' })
    callRpc(sql, me, 'adjust_stock', { p_variant_id: v, p_type: 'DAMAGE', p_quantity: 2, p_note: 'Water damage' })
    callRpc(sql, me, 'adjust_stock', { p_variant_id: v, p_type: 'TRANSFER', p_quantity: 1, p_note: 'Repaired' })
    expect(stock(v)).toEqual({ on_hand: 19, reserved: 0, available: 19, damaged: 1 })
    expect(Number(sql.all("SELECT count(*) AS n FROM audit_logs WHERE action = 'stock.adjusted' AND actor_id = ?", [staff])[0].n)).toBe(5)
  }))

  it('requires a reason, never lets available stock go negative, and is all-or-nothing in bulk', () => rolledBack(sql, () => {
    const p = createProduct({ price: 100, stock: 3 })
    const q = createProduct({ price: 100, stock: 3 })
    const svc = asService(sql)
    expect(() => callRpc(sql, svc, 'adjust_stock', { p_variant_id: p.variantIds[0], p_type: 'ADJUSTMENT', p_quantity: 1, p_note: '', p_mode: 'REMOVE' })).toThrow(/reason/)
    expect(() => callRpc(sql, svc, 'adjust_stock', { p_variant_id: p.variantIds[0], p_type: 'LOSS', p_quantity: 4, p_note: 'Stolen' })).toThrow(/INSUFFICIENT_STOCK/)
    expect(() => callRpc(sql, svc, 'adjust_stock', { p_variant_id: p.variantIds[0], p_type: 'SALE', p_quantity: 1, p_note: 'x' })).toThrow(/invalid input value for enum|cannot be recorded manually/)
    // The second line fails, so the first one is undone too.
    expect(() => callRpc(sql, svc, 'inventory_bulk_adjust', {
      p_items: [{ variant_id: q.variantIds[0], quantity: 2, mode: 'ADD' }, { variant_id: p.variantIds[0], quantity: 10, mode: 'REMOVE' }], p_note: 'Recount',
    })).toThrow(/INSUFFICIENT_STOCK/)
    expect(stock(q.variantIds[0]).on_hand).toBe(3)
    expect(callRpc(sql, svc, 'inventory_bulk_adjust', { p_items: [{ variant_id: q.variantIds[0], quantity: 7, mode: 'SET' }], p_note: 'Recount' })).toEqual({ changed: 1 })
    expect(stock(q.variantIds[0]).on_hand).toBe(7)
    // Overselling only when the store allows it.
    sql.run(`INSERT INTO settings (merchant_id, key, value) VALUES (?, 'inventory', '{"allow_overselling": true}')
      ON CONFLICT (merchant_id, key) DO UPDATE SET value = json_set(value, '$.allow_overselling', json('true'))`, [MERCHANT_1])
    callRpc(sql, svc, 'adjust_stock', { p_variant_id: p.variantIds[0], p_type: 'LOSS', p_quantity: 4, p_note: 'Stolen' })
    expect(stock(p.variantIds[0]).available).toBe(-1)
  }))

  it('is denied to roles without inventory.adjust, also through the table API', () => rolledBack(sql, () => {
    const p = createProduct({ price: 100, stock: 3 })
    const viewer = createStaff(sql, 'VIEWER')
    const me = asUser(sql, viewer)
    expect(() => callRpc(sql, me, 'adjust_stock', { p_variant_id: p.variantIds[0], p_type: 'ADJUSTMENT', p_quantity: 1, p_note: 'x', p_mode: 'ADD' })).toThrow(/PERMISSION_DENIED/)
    const patch = rest(sql, me, 'PATCH', `inventory?variant_id=eq.${p.variantIds[0]}`, { body: { on_hand: 1000 } })
    expect(patch.status).toBe(403)
    expect(stock(p.variantIds[0]).on_hand).toBe(3)
  }))

  it('keeps the movement ledger immutable', () => rolledBack(sql, () => {
    const p = createProduct({ price: 100, stock: 3 })
    expect(() => sql.run('UPDATE inventory_movements SET quantity = 1 WHERE variant_id = ?', [p.variantIds[0]])).toThrow(/IMMUTABLE_RECORD/)
    expect(() => sql.run('DELETE FROM inventory_movements WHERE variant_id = ?', [p.variantIds[0]])).toThrow(/IMMUTABLE_RECORD/)
  }))

  it('queues one stock push per connected store and variant', () => rolledBack(sql, () => {
    const p = createProduct({ price: 100, stock: 3 })
    const channel = randomUUID()
    sql.run(`INSERT INTO sales_channels (id, merchant_id, platform, name, shop_domain, status, settings)
      VALUES (?, ?, 'SHOPIFY', 'Shop', 'shop.myshopify.com', 'CONNECTED', '{"inventory_sync": true, "location_id": "gid://shopify/Location/1"}')`, [channel, MERCHANT_1])
    sql.run(`INSERT INTO sales_channel_variants (channel_id, external_variant_id, variant_id, inventory_item_id, sync_status, merchant_id)
      VALUES (?, '111', ?, 'gid://shopify/InventoryItem/9', 'OK', ?)`, [channel, p.variantIds[0], MERCHANT_1])
    const svc = asService(sql)
    callRpc(sql, svc, 'adjust_stock', { p_variant_id: p.variantIds[0], p_type: 'ADJUSTMENT', p_quantity: 2, p_note: 'More', p_mode: 'ADD' })
    callRpc(sql, svc, 'adjust_stock', { p_variant_id: p.variantIds[0], p_type: 'ADJUSTMENT', p_quantity: 1, p_note: 'Less', p_mode: 'REMOVE' })
    const jobs = sql.all("SELECT kind, ref_id, status FROM channel_sync_jobs WHERE channel_id = ?", [channel])
    expect(jobs).toEqual([{ kind: 'INVENTORY', ref_id: p.variantIds[0], status: 'PENDING' }])
    expect(sql.all('SELECT sync_status FROM sales_channel_variants WHERE channel_id = ?', [channel])[0].sync_status).toBe('PENDING')
  }))

  it('inventory insights list tracked variants with their stock status', () => rolledBack(sql, () => {
    const owner = createStaff(sql, 'OWNER')
    const p = createProduct({ price: 100, cost: 40, stock: 0 })
    const res = callRpc(sql, asUser(sql, owner), 'inventory_insights', {}) as { lead_days: number; items: Array<Record<string, unknown>> }
    expect(res.lead_days).toBe(7)
    const item = res.items.find((i) => i.variant_id === p.variantIds[0])
    expect(item).toMatchObject({ on_hand: 0, available: 0, status: 'OUT', abc: null, daily: 0, suggest: null })
    // The overview the stock pages read directly.
    const overview = rest(sql, asUser(sql, owner), 'GET', `inventory_overview?select=sku,stock_status,track_inventory,low_stock_threshold&variant_id=eq.${p.variantIds[0]}`)
    expect(overview.body).toEqual([{ sku: expect.any(String), stock_status: 'OUT_OF_STOCK', track_inventory: true, low_stock_threshold: 5 }])
  }))

  it('the products pages read products with variants, stock and images in the shape they expect', () => rolledBack(sql, () => {
    const owner = createStaff(sql, 'OWNER')
    const me = asUser(sql, owner)
    const p = createProduct({ price: 300, cost: 120, variants: [{ sku: 'CAP-1', title: 'One', stock: 2 }, { sku: 'CAP-2', title: 'Two', stock: 5 }] })
    sql.run("INSERT INTO product_images (product_id, url, position, is_primary, merchant_id) VALUES (?, 'https://x/b.png', 1, 0, ?), (?, 'https://x/a.png', 0, 1, ?)", [p.productId, MERCHANT_1, p.productId, MERCHANT_1])
    const list = rest(sql, me, 'GET', `products?select=id,name,price,cost_price,track_inventory,extra_category_ids,categories(name),product_variants(id,sku,title,is_active,inventory(on_hand,reserved,available)),product_images(url,is_primary,position)&id=eq.${p.productId}&or=(name.ilike.*product*,sku.ilike.*product*)&offset=0&limit=25&order=created_at.desc,name.asc,id.asc`, { prefer: 'count=exact' })
    expect(list.status).toBe(200)
    expect(list.headers['Content-Range']).toBe('0-0/1')
    const row = (list.body as Array<Record<string, unknown>>)[0]
    expect(row).toMatchObject({ price: 300, cost_price: 120, track_inventory: true, extra_category_ids: [], categories: null })
    expect((row.product_variants as Array<Record<string, unknown>>).map((v) => v.inventory)).toEqual(
      expect.arrayContaining([{ on_hand: 2, reserved: 0, available: 2 }, { on_hand: 5, reserved: 0, available: 5 }]))
    const one = rest(sql, me, 'GET', `products?select=*,product_variants(*,inventory(on_hand,reserved,available,damaged)),product_images(*)&id=eq.${p.productId}&product_variants.order=position.asc&product_images.order=position.asc`)
    const full = (one.body as Array<{ product_variants: Array<{ sku: string; inventory: { damaged: number } }>; product_images: Array<{ url: string }> }>)[0]
    expect(full.product_variants.map((v) => v.sku)).toEqual(['CAP-1', 'CAP-2'])
    expect(full.product_variants[0].inventory.damaged).toBe(0)
    expect(full.product_images.map((i) => i.url)).toEqual(['https://x/a.png', 'https://x/b.png'])
    callRpc(sql, me, 'admin_reorder_product_images', { p_product_id: p.productId, p_image_ids: sql.all("SELECT id FROM product_images WHERE product_id = ? ORDER BY url DESC", [p.productId]).map((r) => r.id) })
    expect(sql.all('SELECT url, position, is_primary FROM product_images WHERE product_id = ? ORDER BY position', [p.productId]))
      .toEqual([{ url: 'https://x/b.png', position: 0, is_primary: 1 }, { url: 'https://x/a.png', position: 1, is_primary: 0 }])
  }))
})
