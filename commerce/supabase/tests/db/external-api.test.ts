import { createHash, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { MERCHANT_1, asService, asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff, inventory } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

async function makeKey(db: Db, owner: string, scopes: string[], merchant = MERCHANT_1) {
  await asUser(db, owner, 'owner@example.com', merchant)
  return value<{ id: string; key: string; prefix: string }>(db, `select public.admin_api_key_create('ERP sync', $1)`, [scopes])
}

describe('external API keys', () => {
  it('are created by managers, shown once, stored as hashes, and find their business', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.admin_api_key_create('x', '{orders:read}')`, [], /PERMISSION_DENIED/)
      await asUser(db, owner)
      await expectError(db, `select public.admin_api_key_create('x', '{}')`, [], /choose what this key may do/)
      await expectError(db, `select public.admin_api_key_create('x', '{orders:delete}')`, [], /unknown permission/)
      await expectError(db, `select public.admin_api_key_create('x', '{orders:read}', now() - interval '1 day')`, [], /in the future/)

      const made = await makeKey(db, owner, ['orders:read', 'inventory:write'])
      expect(made.key).toMatch(/^ffl_live_[0-9a-f]{48}$/)
      expect(JSON.stringify(await value(db, `select public.admin_api_keys()`))).not.toContain(made.key)
      await asSystem(db)
      expect(await value(db, `select key_hash from public.api_keys where id = $1`, [made.id])).toBe(sha(made.key))

      await asService(db, null)
      expect(await value(db, `select public.api_key_merchant($1)`, [sha(made.key)])).toBe(MERCHANT_1)
      expect(await value(db, `select public.api_key_merchant($1)`, [sha('ffl_live_nope')])).toBeNull()
      await asService(db)
      expect(await value(db, `select public.api_key_check($1)`, [sha(made.key)])).toMatchObject({ name: 'ERP sync', scopes: ['inventory:write', 'orders:read'], feature: true })

      // Not callable by signed-in users or the public.
      await asUser(db, owner)
      await expectError(db, `select public.api_orders($1)`, [made.id], /permission denied/)

      await db.query(`select public.admin_api_key_revoke($1)`, [made.id])
      await asService(db, null)
      expect(await value(db, `select public.api_key_merchant($1)`, [sha(made.key)])).toBeNull()
      await asService(db)
      await expectError(db, `select public.api_orders($1)`, [made.id], /not valid or has been turned off/)
    }))
})

describe('external API data', () => {
  it('enforces scopes in the database and uses the admin rules', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const sku = `API-${randomUUID().slice(0, 6).toUpperCase()}`
      const product = await createProduct(db, { name: 'API Tee', price: 500, variants: [{ sku, title: 'M', stock: 8 }] })
      const order = await createOrder(db, { items: [{ variantId: product.variantIds[0], quantity: 2 }] })
      const reader = await makeKey(db, owner, ['orders:read', 'products:read', 'inventory:read', 'customers:read'])
      const writer = await makeKey(db, owner, ['orders:write', 'inventory:write'])

      await asService(db)
      const list = await value<{ data: Array<Record<string, any>>; total: number }>(db, `select public.api_orders($1, '{"limit": 5}')`, [reader.id])
      expect(list.data.find((o) => o.order_number === order.order_number)).toMatchObject({ status: order.status, items: null })
      const one = await value<Record<string, any>>(db, `select public.api_order($1, $2)`, [reader.id, order.order_number])
      expect(one.items).toEqual([expect.objectContaining({ sku, quantity: 2 })])
      await expectError(db, `select public.api_orders($1, '{"status": "NOPE"}')`, [reader.id], /unknown status/)

      const products = await value<{ data: Array<Record<string, any>> }>(db, `select public.api_products($1, '{"search": "API Tee"}')`, [reader.id])
      expect(products.data[0].variants[0]).toMatchObject({ sku, on_hand: 8 })
      expect((await value<{ data: unknown[] }>(db, `select public.api_customers($1)`, [reader.id])).data.length).toBeGreaterThan(0)

      // A read key cannot write, a write key cannot read.
      await expectError(db, `select public.api_order_set_status($1, $2, 'CANCELLED', 'x')`, [reader.id, order.order_number], /does not have the orders:write permission/)
      await expectError(db, `select public.api_orders($1)`, [writer.id], /does not have the orders:read permission/)

      // Stock: same rules as a manual adjustment.
      expect(await value(db, `select public.api_inventory_adjust($1, $2, 'set', 20, 'Warehouse count')`, [writer.id, sku])).toMatchObject({ on_hand: 20 })
      await expectError(db, `select public.api_inventory_adjust($1, $2, 'remove', 500, 'x')`, [writer.id, sku], /INSUFFICIENT_STOCK/)
      await expectError(db, `select public.api_inventory_adjust($1, 'NO-SUCH', 'set', 1, 'x')`, [writer.id], /no product with SKU/)
      expect((await value<{ data: Array<Record<string, any>> }>(db, `select public.api_inventory($1, $2)`, [reader.id, JSON.stringify({ sku })])).data[0])
        .toMatchObject({ sku, on_hand: 20 })

      // Order status follows the normal path and is logged.
      const status = await value<string>(db, `select status::text from public.orders where id = $1`, [order.id])
      expect(['PENDING', 'CONFIRMATION_REQUIRED']).toContain(status)
      expect(await value(db, `select public.api_order_set_status($1, $2, 'CONFIRMED')`, [writer.id, order.order_number])).toMatchObject({ status: 'CONFIRMED' })
      await expectError(db, `select public.api_order_set_status($1, $2, 'DELIVERED')`, [writer.id, order.order_number], /INVALID_TRANSITION|cannot|not allowed/i)
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.order_status_history where order_id = $1 and event = 'API'`, [order.id])).toBe(1)
      await asService(db)
      await expectError(db, `select public.api_order_set_status($1, $2, 'REJECTED_FRAUD')`, [writer.id, order.order_number], /made in the admin/)

      // Requests are logged and readable by staff.
      await db.query(`select public.api_request_log($1, 'GET', '/v1/orders', 200, 12, '1.2.3.4', null)`, [reader.id])
      await asUser(db, owner)
      expect(await value(db, `select public.admin_api_logs(10)`)).toEqual([expect.objectContaining({ key_name: 'ERP sync', path: '/v1/orders', status: 200 })])
    }))

  it('turns off with the plan feature', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const key = await makeKey(db, owner, ['orders:read'])
      await asSystem(db)
      await db.query(`update public.features set globally_enabled = false where code = 'external_api'`)
      await asService(db)
      await expectError(db, `select public.api_orders($1)`, [key.id], /FEATURE_OFF/)
      expect(await value(db, `select public.api_key_check($1)`, [sha(key.key)])).toMatchObject({ feature: false })
      await asUser(db, owner)
      await expectError(db, `select public.admin_api_key_create('x', '{orders:read}')`, [], /FEATURE_OFF/)
    }))
})

describe('external API keys and other stores', () => {
  it("reach only their own store: another store's order, SKU, products and customers stay out of reach", () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const sku = `SHARED-${randomUUID().slice(0, 6).toUpperCase()}`
      const mine = await createProduct(db, { name: 'Mine Tee', price: 500, variants: [{ sku, title: 'M', stock: 8 }] })
      const reader = await makeKey(db, owner, ['orders:read', 'products:read', 'inventory:read', 'customers:read'])
      const writer = await makeKey(db, owner, ['orders:write', 'inventory:write'])

      // Store B: the same SKU, its own order and customer.
      const other = await createMerchant(db)
      const theirs = await createProduct(db, { name: 'Their Secret Tee', price: 900, variants: [{ sku, title: 'M', stock: 5 }], merchantId: other })
      const order = await createOrder(db, { phone: '01711400001', name: 'Store B Customer', items: [{ variantId: theirs.variantIds[0], quantity: 1 }], merchantId: other })
      await asSystem(db, other)
      const status = await value<string>(db, `select status::text from public.orders where id = $1`, [order.id])

      await asService(db)
      // Their order, by number or id: not found.
      for (const ref of [order.order_number, order.id]) {
        await expectError(db, `select public.api_order($1, $2)`, [reader.id, ref], /not found|no order/i)
        await expectError(db, `select public.api_order_set_status($1, $2, 'CANCELLED', 'x')`, [writer.id, ref], /not found|no order/i)
      }
      // Lists hold only this store's records.
      const all = JSON.stringify([
        await value(db, `select public.api_orders($1, '{"limit": 200}')`, [reader.id]),
        await value(db, `select public.api_products($1, '{"limit": 200}')`, [reader.id]),
        await value(db, `select public.api_customers($1, '{"limit": 200}')`, [reader.id]),
        await value(db, `select public.api_inventory($1, '{"limit": 200}')`, [reader.id]),
      ])
      expect(all).not.toContain(order.order_number)
      expect(all).not.toContain('Their Secret Tee')
      expect(all).not.toContain('01711400001')
      expect(all).not.toContain('Store B Customer')
      // The shared SKU changes this store's stock only.
      expect(await value(db, `select public.api_inventory_adjust($1, $2, 'set', 30, 'Count')`, [writer.id, sku])).toMatchObject({ on_hand: 30 })
      await asSystem(db, other)
      expect((await inventory(db, theirs.variantIds[0])).on_hand).toBe(5)
      expect(await value<string>(db, `select status::text from public.orders where id = $1`, [order.id])).toBe(status)
      await asSystem(db)
      expect((await inventory(db, mine.variantIds[0])).on_hand).toBe(30)

      // A key sent with another store as the request's store is refused outright.
      await asService(db, other)
      await expectError(db, `select public.api_orders($1)`, [reader.id], /not valid or has been turned off/)
      await expectError(db, `select public.api_inventory_adjust($1, $2, 'set', 0, 'x')`, [writer.id, sku], /not valid or has been turned off/)
      await asSystem(db, other)
      expect((await inventory(db, theirs.variantIds[0])).on_hand).toBe(5)
    }))
})
