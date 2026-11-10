import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, inTx, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

type Line = { variant: string; quantity: number; returned: number; damaged: number; expected_back: number }
type List = { items: Array<{ id: string; status: string; lines: Line[] }> }

const phone = () => `0171${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

/** Sunset I in M and L, one of each, shipped; the courier then reports a partial delivery. */
async function partlyDelivered(db: Db) {
  const p = await createProduct(db, { price: 1860, variants: [{ sku: `SUN-M-${phone()}`, title: 'M', stock: 5 }, { sku: `SUN-L-${phone()}`, title: 'L', stock: 5 }] })
  const tel = phone()
  const o = await createOrder(db, { phone: tel, items: [{ variantId: p.variantIds[0], quantity: 1 }, { variantId: p.variantIds[1], quantity: 1 }] })
  await advanceOrder(db, o.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  const courier = await value<string>(db, `select id from public.couriers limit 1`)
  const ship = await value<string>(db, `select id from public.assign_courier($1, $2, $3, 70)`, [o.id, courier, `DA${Math.floor(Math.random() * 1e9)}`])
  await db.query(`select public.apply_shipment_status($1, 'PICKED_UP', null, null, null, 'WEBHOOK', null, $2)`, [ship, `k-${ship}-p`])
  await db.query(`select public.apply_shipment_status($1, 'PARTIALLY_DELIVERED', 'Partial delivery', null, null, 'WEBHOOK', $2, $3)`,
    [ship, JSON.stringify({ event: 'order.partial-delivery' }), `k-${ship}-pd`])
  const items = await db.query<{ id: string; variant_title: string }>(`select id, variant_title from public.order_items where order_id = $1`, [o.id])
  return { id: o.id, phone: tel, itemL: items.rows.find((r) => r.variant_title === 'L')!.id }
}

async function lines(db: Db, staff: string, tel: string) {
  await asUser(db, staff)
  const list = await value<List>(db, `select public.admin_search_orders($1::jsonb)`, [JSON.stringify({ q: tel })])
  return Object.fromEntries(list.items[0].lines.map((l) => [l.variant, [l.returned, l.damaged, l.expected_back]]))
}

describe('Approved Orders: what happened to each item of a partly delivered order', () => {
  it('lists, per item, what was sent back, what came back to stock and what came back damaged', () =>
    inTx(async (db) => {
      const o = await partlyDelivered(db)
      const staff = await createStaff(db, 'OWNER')
      // Nothing recorded yet.
      expect(await lines(db, staff, o.phone)).toEqual({ M: [0, 0, 0], L: [0, 0, 0] })
      // "Partial delivery…": the customer sent the L back.
      await asUser(db, staff)
      await db.query(`select public.record_partial_delivery($1, $2, 'Kept the M')`, [o.id, JSON.stringify([{ order_item_id: o.itemL, quantity: 1 }])])
      expect(await lines(db, staff, o.phone)).toEqual({ M: [0, 0, 0], L: [0, 0, 1] })
      // The parcel arrives and the L goes back to stock.
      await asUser(db, staff)
      await db.query(`select public.process_order_return($1, $2, 'Received')`, [o.id, JSON.stringify([{ order_item_id: o.itemL, quantity: 1, condition: 'RESTOCK' }])])
      expect(await lines(db, staff, o.phone)).toEqual({ M: [0, 0, 0], L: [1, 0, 1] })
    }))

  it('other orders carry no "sent back" figure', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 900, variants: [{ sku: `TEE-${phone()}`, title: 'M', stock: 5 }] })
      const tel = phone()
      const o = await createOrder(db, { phone: tel, items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      await advanceOrder(db, o.id, ['CONFIRMED'])
      const staff = await createStaff(db, 'OWNER')
      expect(await lines(db, staff, tel)).toEqual({ M: [0, 0, 0] })
    }))
})
