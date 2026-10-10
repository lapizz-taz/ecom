import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, inventory } from '../support/fixtures'

afterAll(closePool)

const phone = () => `0171${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
const order = (db: Db, id: string) =>
  value<Record<string, any>>(db, `select to_jsonb(o) || jsonb_build_object('stage', public.order_stage(o.status, o.confirmed_at)) from public.orders o where id = $1`, [id])

/** An approved order handed to a courier (status SHIPPED, picked up by the courier). */
async function shipped(db: Db, variantId: string) {
  const o = await createOrder(db, { phone: phone(), items: [{ variantId, quantity: 1 }] })
  await advanceOrder(db, o.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  const courier = await value<string>(db, `select id from public.couriers limit 1`)
  const ship = await value<string>(db, `select id from public.assign_courier($1, $2, $3, 70)`, [o.id, courier, `TRK-${Math.floor(Math.random() * 1e9)}`])
  await db.query(`select public.apply_shipment_status($1, 'PICKED_UP', null, null, null, 'WEBHOOK', null, $2)`, [ship, `k-${ship}-p`])
  return { id: o.id, ship }
}
const courier = (db: Db, ship: string, status: string) =>
  db.query(`select public.apply_shipment_status($1, $2::public.shipment_status, null, null, null, 'WEBHOOK', null, $3)`, [ship, status, `k-${ship}-${status}`])

describe('Delivered is final', () => {
  it('a delivered order cannot be moved to a return by hand', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const s = await shipped(db, p.variantIds[0])
      await courier(db, s.ship, 'DELIVERED')
      expect((await order(db, s.id)).status).toBe('DELIVERED')
      await expectError(db, `select public._transition_order($1, 'RETURN_REQUESTED', 'too late')`, [s.id], /cannot move from DELIVERED/)
      expect(await value<number>(db, `select count(*)::int from public.order_status_transitions where from_status in ('DELIVERED', 'PARTIALLY_DELIVERED') and to_status = 'RETURN_REQUESTED'`)).toBe(0)
    }))

  it('a courier "return" after delivery is logged; the order stays delivered and stock is untouched', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const s = await shipped(db, p.variantIds[0])
      await courier(db, s.ship, 'DELIVERED')
      const before = await inventory(db, p.variantIds[0])
      await courier(db, s.ship, 'RETURNING')
      await courier(db, s.ship, 'RETURNED')
      const o = await order(db, s.id)
      expect(o).toMatchObject({ status: 'DELIVERED', stage: 'DELIVERED' })
      expect(await inventory(db, p.variantIds[0])).toEqual(before)
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.order_status_history where order_id = $1 and event = 'COURIER_RETURN_AFTER_DELIVERY'`, [s.id])).toBe(2)
    }))
  it('the scanner refuses to turn a delivered parcel into a return', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const s = await shipped(db, p.variantIds[0])
      await courier(db, s.ship, 'DELIVERED')
      const before = await inventory(db, p.variantIds[0])
      const num = await value<string>(db, `select order_number from public.orders where id = $1`, [s.id])
      await asUser(db, await createStaff(db, 'OWNER'))
      const r = await value<Record<string, any>>(db, `select public.scan_parcel($1, 'RETURNED')`, [num])
      expect(r.result).toBe('ERROR')
      expect(r.message).toMatch(/final/)
      expect((await order(db, s.id)).status).toBe('DELIVERED')
      expect(await inventory(db, p.variantIds[0])).toEqual(before)
    }))

  it('scanning a returning parcel as Returned receives it and restocks', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const s = await shipped(db, p.variantIds[0])
      await courier(db, s.ship, 'FAILED')
      const num = await value<string>(db, `select order_number from public.orders where id = $1`, [s.id])
      await asUser(db, await createStaff(db, 'OWNER'))
      const r = await value<Record<string, any>>(db, `select public.scan_parcel($1, 'RETURNED')`, [num])
      expect(r.result).not.toBe('ERROR')
      expect(await order(db, s.id)).toMatchObject({ status: 'RETURNED', stage: 'RETURNED' })
      expect((await inventory(db, p.variantIds[0])).on_hand).toBe(5)
    }))
})

describe('One "Return pending" stage', () => {
  it('refused (Pathao "delivery failed"), returning (Steadfast "cancelled" / Pathao "return") and return asked for all show as Return pending', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 9 })
      const refused = await shipped(db, p.variantIds[0])
      await courier(db, refused.ship, 'FAILED')
      expect(await order(db, refused.id)).toMatchObject({ status: 'FAILED_DELIVERY', stage: 'RETURN_PENDING' })

      const coming = await shipped(db, p.variantIds[0])
      await courier(db, coming.ship, 'RETURNING')
      expect(await order(db, coming.id)).toMatchObject({ status: 'RETURNING', stage: 'RETURN_PENDING' })

      const asked = await shipped(db, p.variantIds[0])
      await advanceOrder(db, asked.id, ['RETURN_REQUESTED'])
      expect(await order(db, asked.id)).toMatchObject({ status: 'RETURN_REQUESTED', stage: 'RETURN_PENDING' })

      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from (select public.order_stage(s, now()) st from unnest(enum_range(null::public.order_status)) s) x where st = 'PENDING_RETURN'`)).toBe(0)
    }))
})

describe('Bulk product edit and bulk stock', () => {
  it('changes price, cost, status and category for many products at once; staff without the permission are refused', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 500, cost: 200, stock: 3 })
      const b = await createProduct(db, { price: 700, cost: 300, stock: 3 })
      await asSystem(db)
      const cat = await value<string>(db, `insert into public.categories(name, slug) values ('Belts', 'belts-' || substr(md5(random()::text), 1, 6)) returning id`)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const r = await value<Record<string, any>>(db, `select public.admin_products_bulk_update($1, $2)`,
        [[a.productId, b.productId], JSON.stringify({ price: 990, cost_price: 410, active: false, category_id: cat })])
      expect(r.updated).toBe(2)
      await asSystem(db)
      const rows = await value<any[]>(db, `select jsonb_agg(jsonb_build_object('price', price, 'cost', cost_price, 'status', status, 'cat', category_id)) from public.products where id = any($1)`, [[a.productId, b.productId]])
      for (const row of rows) expect(row).toEqual({ price: 990, cost: 410, status: 'ARCHIVED', cat })

      const viewer = await createStaff(db, 'VIEWER')
      await asUser(db, viewer)
      await expectError(db, `select public.admin_products_bulk_update($1, $2)`, [[a.productId], JSON.stringify({ price: 1 })], /permission|required|denied/i)
    }))

  it('adds / sets stock for many variants in one go with a ledger entry each; one bad line saves nothing', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 500, stock: 4 })
      const b = await createProduct(db, { price: 500, stock: 10 })
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      const r = await value<Record<string, any>>(db, `select public.inventory_bulk_adjust($1, 'Stock received')`, [JSON.stringify([
        { variant_id: a.variantIds[0], quantity: 6, mode: 'ADD' },
        { variant_id: b.variantIds[0], quantity: 3, mode: 'SET' },
        { variant_id: a.variantIds[0], quantity: 0, mode: 'ADD' },
      ])])
      expect(r.changed).toBe(2)
      expect((await inventory(db, a.variantIds[0])).on_hand).toBe(10)
      expect((await inventory(db, b.variantIds[0])).on_hand).toBe(3)
      await asSystem(db)
      expect(await value<number>(db, `select count(*)::int from public.inventory_movements where variant_id = any($1) and note = 'Stock received'`, [[a.variantIds[0], b.variantIds[0]]])).toBe(2)

      await asUser(db, owner)
      await expectError(db, `select public.inventory_bulk_adjust($1, 'Count')`, [JSON.stringify([
        { variant_id: a.variantIds[0], quantity: 5, mode: 'ADD' },
        { variant_id: b.variantIds[0], quantity: 99, mode: 'REMOVE' },
      ])], /stock|negative|enough|INSUFFICIENT/i)
      expect((await inventory(db, a.variantIds[0])).on_hand).toBe(10)
      await expectError(db, `select public.inventory_bulk_adjust($1, '')`, [JSON.stringify([{ variant_id: a.variantIds[0], quantity: 1 }])], /note/)
    }))
})
