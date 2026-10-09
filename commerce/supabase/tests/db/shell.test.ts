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
  it('lands in the System log with who reported it and the page', async () => {
    await inTx(async (db) => {
      const staff = await createStaff(db, 'VIEWER')
      await asUser(db, staff)
      await expectError(db, `select public.report_issue('hi')`, [], /Describe the problem/)
      const id = await value<number>(db, `select public.report_issue($1, $2)`, ['Label preview is cut off', JSON.stringify({ page: '/admin/labels', browser: 'Chrome' })])
      await asSystem(db)
      const row = await value<Record<string, unknown>>(db, `select to_jsonb(l) from public.system_logs l where id = $1`, [id])
      expect(row).toMatchObject({ level: 'WARN', category: 'OTHER', source: 'staff-report' })
      expect(row.message).toMatch(/^Reported by Test VIEWER: Label preview is cut off/)
      expect(row.context).toMatchObject({ page: '/admin/labels', user_id: staff })
      await asAnon(db)
      await expectError(db, `select public.report_issue('Something broke')`, [], /permission denied|PERMISSION_DENIED/i)
    })
  })
})
