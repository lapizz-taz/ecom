import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

const phone = () => `0171${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

describe('Customers by district', () => {
  it('counts customers per district, lists unrecognised districts with a suggestion, and fixes them', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 20 })
      const ph = phone()
      const o = await createOrder(db, { phone: ph, district: 'Sylhet', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`update public.orders set shipping_district = 'Chittagong city', shipping_address = 'Agrabad, Chittagong' where id = $1`, [o.id])

      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const before = await value<Record<string, any>>(db, `select public.customer_district_stats()`)
      expect(before.totals.unassigned_orders).toBeGreaterThanOrEqual(1)
      const list = await value<any[]>(db, `select public.customers_needing_district(50)`)
      expect(list.find((x) => x.phone === ph)).toMatchObject({ district_text: 'Chittagong city', suggestion: 'Chattogram', orders: 1 })

      await expectError(db, `select public.assign_customer_district($1, 'Atlantis')`, [ph], /64 districts/)
      expect(await value(db, `select public.assign_customer_district($1, 'chattogram')`, [ph])).toEqual({ orders: 1, district: 'Chattogram' })
      expect(await value(db, `select shipping_district from public.orders where id = $1`, [o.id])).toBe('Chattogram')
      const after = await value<Record<string, any>>(db, `select public.customer_district_stats()`)
      expect(after.districts.find((d: any) => d.district === 'Chattogram').orders).toBeGreaterThanOrEqual(1)
      expect((await value<any[]>(db, `select public.customers_needing_district(50)`)).some((x) => x.phone === ph)).toBe(false)

      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.assign_customer_district($1, 'Dhaka')`, [ph], /permission|required|denied/i)
    }))

  it('auto-assigns the customers whose address names a district', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 20 })
      const a = await createOrder(db, { phone: phone(), items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const b = await createOrder(db, { phone: phone(), items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`update public.orders set shipping_district = 'Comilla Sadar' where id = $1`, [a.id])
      await db.query(`update public.orders set shipping_district = 'Unknown place', shipping_address = 'near the bridge', shipping_city = null, shipping_area = null where id = $1`, [b.id])
      await asUser(db, await createStaff(db, 'OWNER'))
      const r = await value<Record<string, number>>(db, `select public.auto_assign_districts()`)
      expect(r.customers).toBeGreaterThanOrEqual(1)
      expect(r.left).toBeGreaterThanOrEqual(1)
      expect(await value(db, `select shipping_district from public.orders where id = $1`, [a.id])).toBe('Cumilla')
      expect(await value(db, `select shipping_district from public.orders where id = $1`, [b.id])).toBe('Unknown place')
    }))
})
