import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, expectError, inTx, value } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

type Search = Record<string, Array<Record<string, unknown>>>

describe('quick search (Ctrl+K)', () => {
  it('finds an order by number and by phone (with +880), a product by SKU, and a parcel by consignment id', async () => {
    await inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const phone = '01755123987'
      const order = await createOrder(db, { phone, items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      const sku = await value<string>(db, `select sku from public.product_variants where id = $1`, [p.variantIds[0]])
      const courier = await value<string>(db, `select id from public.couriers limit 1`)
      await db.query(`insert into public.shipments(order_id, courier_id, tracking_number, consignment_id) values ($1, $2, 'TRK-XYZ-55', 'CONS-99887')`, [order.id, courier])
      const number = await value<string>(db, `select order_number from public.orders where id = $1`, [order.id])

      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      const byNumber = await value<Search>(db, `select public.admin_global_search($1)`, [number])
      expect(byNumber.orders.map((o) => o.id)).toContain(order.id)
      const byPhone = await value<Search>(db, `select public.admin_global_search($1)`, ['+880 1755-123987'])
      expect(byPhone.orders.map((o) => o.id)).toContain(order.id)
      const bySku = await value<Search>(db, `select public.admin_global_search($1)`, [sku])
      expect(bySku.products.map((x) => x.id)).toContain(p.productId)
      const byParcel = await value<Search>(db, `select public.admin_global_search($1)`, ['CONS-998'])
      expect(byParcel.parcels[0]).toMatchObject({ order_id: order.id, consignment_id: 'CONS-99887' })
      // One letter is not a search.
      expect(await value(db, `select public.admin_global_search('a')`)).toEqual({})
    })
  })

  it('only returns what the role may see, and nothing to customers or visitors', async () => {
    await inTx(async (db) => {
      const inventory = await createStaff(db, 'INVENTORY_MANAGER')
      await asUser(db, inventory)
      const r = await value<Search>(db, `select public.admin_global_search('ISO')`)
      expect(Object.keys(r).sort()).toEqual(['products'])
      await asAnon(db)
      await expectError(db, `select public.admin_global_search('ISO')`, [], /permission denied|PERMISSION_DENIED/i)
    })
  })

  it('treats % and _ as plain characters', async () => {
    await inTx(async (db) => {
      const staff = await createStaff(db, 'ADMIN')
      await asUser(db, staff)
      const r = await value<Search>(db, `select public.admin_global_search('%%')`)
      expect(r.orders).toEqual([])
      expect(r.customers).toEqual([])
    })
  })
})

describe('report issue', () => {
  it('opens a bug ticket the reporter can follow and lands in the System log with who reported it and the page', async () => {
    await inTx(async (db) => {
      const staff = await createStaff(db, 'VIEWER')
      await asUser(db, staff)
      await expectError(db, `select public.report_issue('hi')`, [], /Describe the problem/)
      const num = await value<number>(db, `select public.report_issue($1, $2)`, ['Label preview is cut off', JSON.stringify({ page: '/admin/labels', browser: 'Chrome' })])
      const ticket = await value<Record<string, any>>(db, `select to_jsonb(t) from public.support_tickets t where number = $1`, [num])
      expect(ticket).toMatchObject({ kind: 'BUG', status: 'OPEN', subject: 'Label preview is cut off', created_by: staff })
      expect(ticket.context).toMatchObject({ page: '/admin/labels', browser: 'Chrome' })
      await asSystem(db)
      const row = await value<Record<string, unknown>>(db, `select to_jsonb(l) from public.system_logs l where context ->> 'ticket_id' = $1`, [ticket.id])
      expect(row).toMatchObject({ level: 'WARN', category: 'OTHER', source: 'staff-report' })
      expect(row.message).toMatch(new RegExp(`^Bug #${num} by Test VIEWER: Label preview is cut off`))
      expect(row.context).toMatchObject({ page: '/admin/labels', user_id: staff })
      await asAnon(db)
      await expectError(db, `select public.report_issue('Something broke')`, [], /permission denied|PERMISSION_DENIED/i)
    })
  })
})

describe('dashboard command centre', () => {
  it('counts conversion from sessions that bought, never above 100%, and hides money from roles without finance', async () => {
    await inTx(async (db) => {
      await asSystem(db)
      // Two sessions, one bought; plus an order that never went through the store.
      await db.query(`insert into public.storefront_events(session_id, event_type) values
        ('sess-aaaaaaaa', 'PAGE_VIEW'), ('sess-aaaaaaaa', 'PURCHASE'), ('sess-bbbbbbbb', 'PAGE_VIEW')`)
      const p = await createProduct(db, { price: 800, stock: 5 })
      await createOrder(db, { phone: '01755000111', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const range = [new Date(Date.now() - 86_400_000).toISOString().slice(0, 10), new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)]
      const all = await value<Record<string, any>>(db, `select public.dashboard_command_center($1::date, $2::date)`, range)
      expect(all.period.sessions).toBeGreaterThanOrEqual(2)
      expect(Number(all.period.conversion_rate)).toBeLessThanOrEqual(100)
      expect(all.recent_orders.length).toBeGreaterThan(0)

      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      const v = await value<Record<string, any>>(db, `select public.dashboard_command_center($1::date, $2::date)`, range)
      expect(v.finance).toBeUndefined()
      await asAnon(db)
      await expectError(db, `select public.dashboard_command_center(current_date, current_date)`, [], /dashboard\.view|permission denied|PERMISSION/i)
    })
  })
})
