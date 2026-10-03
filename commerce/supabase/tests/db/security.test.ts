import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, expectError, inTx, value } from '../support/db'
import { createCustomerUser, createOrder, createProduct, createStaff, orderPayload } from '../support/fixtures'

afterAll(closePool)

describe('row level security', () => {
  it('hides private tables from anonymous visitors', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asAnon(db)
      for (const table of ['orders', 'customers', 'products', 'product_variants', 'inventory', 'finance_transactions', 'fraud_checks', 'audit_logs', 'profiles']) {
        expect(await value(db, `select count(*)::int from public.${table}`), table).toBe(0)
      }
      // Only public settings are visible.
      expect(await value(db, `select count(*)::int from public.settings where key = 'fraud'`)).toBe(0)
      expect(await value(db, `select count(*)::int from public.settings where key = 'store'`)).toBe(1)
    }))

  it('serves the catalogue to visitors without cost prices', () =>
    inTx(async (db) => {
      // A cost that can't turn up by chance inside an id or a timestamp.
      await createProduct(db, { name: 'Visible Tee', price: 799, cost: 321.47 })
      await asAnon(db)
      const list = await value<{ items: unknown[] }>(db, `select public.storefront_list_products(null, 'Visible Tee')`)
      expect(list.items).toHaveLength(1)
      expect(JSON.stringify(list)).not.toMatch(/321\.47|cost/)
      const quoteJson = JSON.stringify(await value(db, `select public.storefront_quote($1, 'Dhaka')`,
        [JSON.stringify([{ variant_id: (list.items[0] as { id: string }).id, quantity: 1 }])]).catch(() => ({})))
      expect(quoteJson).not.toMatch(/321\.47|cost/)
    }))

  it('denies admin functions to visitors and customers', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asAnon(db)
      await expectError(db, `select public.admin_search_orders('{}')`, [], /permission denied/)
      await expectError(db, `select public.calculate_order_quote('[]', 'Dhaka')`, [], /permission denied/)
      await expectError(db, `select public.place_storefront_order('{}')`, [], /permission denied/)
      const customer = await createCustomerUser(db)
      await asUser(db, customer)
      await expectError(db, `select public.transition_order_status($1, 'CONFIRMED')`, [order.id], /PERMISSION_DENIED/)
      await expectError(db, `select public.adjust_stock($1, 'ADJUSTMENT', 100, 'x', 'ADD')`, [p.variantIds[0]], /PERMISSION_DENIED/)
      await expectError(db, `insert into public.orders(order_number, customer_id, customer_name, customer_phone, shipping_address, shipping_district)
                             values ('X-1', $1, 'a', 'b', 'c', 'd')`, [order.customer_id], /permission denied/)
    }))

  it('lets customers see only their own orders, without fraud data', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      const alice = await createCustomerUser(db, 'alice@example.com')
      const bob = await createCustomerUser(db, 'bob@example.com')
      await asSystem(db)
      const aliceOrder = await value<{ id: string }>(db, `select to_jsonb(o) from public._create_order($1, 'STOREFRONT') o`,
        [JSON.stringify({ ...orderPayload({ phone: '01711500001', items: [{ variantId: p.variantIds[0], quantity: 1 }] }), auth_user_id: alice })])
      await asUser(db, bob)
      expect(await value(db, `select public.customer_get_order($1)`, [aliceOrder.id])).toBeNull()
      expect(await value<{ total: number }>(db, `select public.customer_my_orders()`)).toMatchObject({ total: 0 })
      expect(await value(db, `select count(*)::int from public.orders`)).toBe(0)
      await asUser(db, alice)
      const mine = await value<Record<string, unknown>>(db, `select public.customer_get_order($1)`, [aliceOrder.id])
      expect(mine.order_number).toBeTruthy()
      expect(JSON.stringify(mine)).not.toMatch(/fraud|risk|cost/)
    }))

  it('only reveals tracking when the phone matches', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      const order = await createOrder(db, { phone: '01711600001', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asAnon(db)
      expect(await value(db, `select public.track_order($1, '01711600002')`, [order.order_number])).toBeNull()
      expect(await value(db, `select public.track_order($1, '+8801711600001')`, [order.order_number])).not.toBeNull()
    }))

  it('gives viewers read access but no write access', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      expect(await value(db, `select count(*)::int from public.orders where id = $1`, [order.id])).toBe(1)
      expect(await value(db, `select count(*)::int from public.finance_transactions`)).toBe(0)
      await expectError(db, `select public.admin_update_order($1, '{"customer_name":"Hacked"}')`, [order.id], /PERMISSION_DENIED/)
      await expectError(db, `select public.create_finance_transaction('{}')`, [], /PERMISSION_DENIED/)
    }))
})

describe('privilege escalation', () => {
  it('prevents admins from granting OWNER and users from changing their own role', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const admin = await createStaff(db, 'ADMIN')
      const staff = await createStaff(db, 'VIEWER')
      await asUser(db, admin)
      // ADMIN lacks users.manage entirely.
      await expectError(db, `select public.admin_set_user_role($1, 'OWNER')`, [staff], /PERMISSION_DENIED/)
      await asUser(db, owner)
      await expectError(db, `select public.admin_set_user_role($1, 'VIEWER')`, [owner], /your own role/)
      await db.query(`select public.admin_set_user_role($1, 'ORDER_MANAGER')`, [staff])
      await asUser(db, staff)
      await expectError(db, `update public.profiles set role_id = (select id from public.roles where code = 'OWNER') where id = $1`, [staff], /permission denied/)
      await expectError(db, `select public.grant_owner('x@example.com')`, [], /permission denied/)
    }))

  it('limits delegated user managers to roles at or below their own rank', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      const manager = await createStaff(db, 'MANAGER')
      const admin = await createStaff(db, 'ADMIN')
      const staff = await createStaff(db, 'VIEWER')
      await asUser(db, owner)
      await db.query(`insert into public.role_permissions(role_id, permission_id)
        select r.id, p.id from public.roles r, public.permissions p where r.code = 'MANAGER' and p.code = 'users.manage'`)
      await asUser(db, manager)
      await db.query(`select public.admin_set_user_role($1, 'ORDER_MANAGER')`, [staff])
      await db.query(`select public.admin_set_user_role($1, 'MANAGER')`, [staff])
      await expectError(db, `select public.admin_set_user_role($1, 'ADMIN')`, [staff], /above your own/)
      await expectError(db, `select public.admin_set_user_role($1, 'VIEWER', false)`, [admin], /higher role/)
    }))

  it('keeps at least one active owner', () =>
    inTx(async (db) => {
      await asSystem(db)
      await db.query(`delete from public.profiles where role_id = (select id from public.roles where code = 'OWNER')`)
      const owner = await createStaff(db, 'OWNER')
      await asSystem(db)
      await expectError(db, `select public.admin_set_user_role($1, 'ADMIN')`, [owner], /at least one active owner/)
    }))

  it('reports permissions for the signed-in staff member', () =>
    inTx(async (db) => {
      const fin = await createStaff(db, 'FINANCE_MANAGER')
      await asUser(db, fin)
      const access = await value<{ role: string; permissions: string[] }>(db, `select public.get_my_access()`)
      expect(access.role).toBe('FINANCE_MANAGER')
      expect(access.permissions).toContain('finance.manage')
      expect(access.permissions).not.toContain('settings.manage')
      const customer = await createCustomerUser(db)
      await asUser(db, customer)
      expect(await value(db, `select public.get_my_access()`)).toBeNull()
    }))

  it('validates settings changes server-side and audits them', () =>
    inTx(async (db) => {
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.admin_update_setting('fraud', '{"thresholds":{"medium":70,"high":60,"critical":80}}')`, [], /thresholds must satisfy/)
      await db.query(`select public.admin_update_setting('inventory', '{"low_stock_threshold": 3, "allow_overselling": false}')`)
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.audit_logs where action = 'settings.update' and actor_id = $1`, [owner])).toBe(1)
    }))
})
