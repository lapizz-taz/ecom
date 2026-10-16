import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

async function anOrder(db: Db) {
  const p = await createProduct(db, { price: 900, stock: 10 })
  return createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
}

describe('Call role', () => {
  it('exists in every store, new stores included, with order, call and status access only', () =>
    inTx(async (db) => {
      await asSystem(db)
      const perms = await value<string[]>(db, `select array_agg(p.code order by p.code) from public.roles r
        join public.role_permissions rp on rp.role_id = r.id join public.permissions p on p.id = rp.permission_id where r.code = 'CALL'`)
      expect(perms).toEqual(['orders.status', 'orders.update', 'orders.view', 'pbx.call'])

      await asSystem(db, null)
      const id = await value<string>(db, `insert into public.merchants (name) values ($1) returning id`, [`Shop ${randomUUID().slice(0, 6)}`])
      await asSystem(db, id)
      await db.query(`select public._merchant_seed_defaults($1)`, [id])
      expect(await value<string>(db, `select name from public.roles where merchant_id = $1 and code = 'CALL'`, [id])).toBe('Call')
      expect(await value<number>(db, `select count(*)::int from public.role_permissions rp join public.roles r on r.id = rp.role_id where r.merchant_id = $1 and r.code = 'CALL'`, [id])).toBe(4)
    }))

  it('sees orders but not costs, products, the dashboard or finance', () =>
    inTx(async (db) => {
      const order = await anOrder(db)
      const caller = await createStaff(db, 'CALL')
      await asUser(db, caller)
      expect(await value<string>(db, `select order_number from public.orders where id = $1`, [order.id])).toBe(order.order_number)
      expect(await value<number>(db, `select count(*)::int from public.order_items where order_id = $1`, [order.id])).toBe(1)
      await expectError(db, `select cost_total from public.orders where id = $1`, [order.id], /permission denied/)
      await expectError(db, `select unit_cost from public.order_items where order_id = $1`, [order.id], /permission denied/)
      await expectError(db, `select public.order_cost_summary($1)`, [order.id], /visible to finance/)
      expect(await value<number | null>(db, `select public.order_cost_total($1)`, [order.id])).toBeNull()
      expect(await value<number>(db, `select count(*)::int from public.products`)).toBe(0)
      expect(await value<number>(db, `select count(*)::int from public.product_variants`)).toBe(0)
      await expectError(db, `select public.dashboard_command_center(current_date - 7, current_date)`, [], /PERMISSION_DENIED|dashboard/)
      expect(await value<number>(db, `select count(*)::int from public.finance_transactions`)).toBe(0)
    }))

  it('finance and the owner still see costs; order managers still read the catalog', () =>
    inTx(async (db) => {
      const order = await anOrder(db)
      for (const role of ['FINANCE_MANAGER', 'OWNER']) {
        await asUser(db, await createStaff(db, role))
        const c = await value<Record<string, any>>(db, `select public.order_cost_summary($1)`, [order.id])
        expect(c.items).toHaveLength(1)
        expect(c).toHaveProperty('cost_total')
      }
      await asUser(db, await createStaff(db, 'ORDER_MANAGER'))
      expect(await value<number>(db, `select count(*)::int from public.products`)).toBeGreaterThan(0)
      expect(await value<number>(db, `select count(*)::int from public.inventory_overview`)).toBeGreaterThan(0)
    }))

  it('every other order column stays readable for staff (a new column needs a grant)', () =>
    inTx(async (db) => {
      await asSystem(db)
      const missing = await value<string[]>(db, `select coalesce(array_agg(t.relname || '.' || a.attname), '{}') from pg_attribute a join pg_class t on t.oid = a.attrelid
        where t.relname in ('orders', 'order_items') and t.relnamespace = 'public'::regnamespace and a.attnum > 0 and not a.attisdropped
          and a.attname not in ('cost_total', 'unit_cost') and not has_column_privilege('authenticated', t.oid, a.attnum, 'SELECT')`)
      expect(missing).toEqual([])
    }))
})
