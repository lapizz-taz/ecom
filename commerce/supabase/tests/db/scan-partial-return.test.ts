import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, inTx, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, inventory } from '../support/fixtures'
import { createMerchant } from '../support/sweep'

afterAll(closePool)

type Item = { id: string; variant_title: string; quantity: number; returned_quantity: number; expected_back: number }
type Scan = { result: string; message: string; order: { id: string; status: string; items?: Item[] } | null }

const phone = () => `0171${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`
const status = async (db: Db, id: string) => {
  await asSystem(db)
  return value<string>(db, `select status::text from public.orders where id = $1`, [id])
}

/** Sunset I in M and L, one of each, shipped and marked "partial delivery" by the courier. */
async function partlyDelivered(db: Db) {
  const p = await createProduct(db, { price: 1860, variants: [{ sku: `SUN-M-${phone()}`, title: 'M', stock: 5 }, { sku: `SUN-L-${phone()}`, title: 'L', stock: 5 }] })
  const [m, l] = p.variantIds
  const o = await createOrder(db, { phone: phone(), items: [{ variantId: m, quantity: 1 }, { variantId: l, quantity: 1 }] })
  await advanceOrder(db, o.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
  await asSystem(db)
  const courier = await value<string>(db, `select id from public.couriers limit 1`)
  const tracking = `DA${Math.floor(Math.random() * 1e9)}`
  const ship = await value<string>(db, `select id from public.assign_courier($1, $2, $3, 70)`, [o.id, courier, tracking])
  await db.query(`select public.apply_shipment_status($1, 'PICKED_UP', null, null, null, 'WEBHOOK', null, $2)`, [ship, `k-${ship}-p`])
  await db.query(`select public.apply_shipment_status($1, 'PARTIALLY_DELIVERED', 'Customer requested Partial Delivery and merchant aligned', null, null, 'WEBHOOK', $2, $3)`,
    [ship, JSON.stringify({ event: 'order.partial-delivery', collected_amount: 1980 }), `k-${ship}-pd`])
  const items = await db.query<{ id: string; variant_title: string }>(`select id, variant_title from public.order_items where order_id = $1`, [o.id])
  const item = (size: string) => items.rows.find((r) => r.variant_title === size)!.id
  return { id: o.id, ship, tracking, m, l, itemM: item('M'), itemL: item('L') }
}

async function scan(db: Db, code: string, merchantId?: string) {
  const staff = await createStaff(db, 'OWNER', undefined, merchantId)
  await asUser(db, staff, 'user@example.com', merchantId)
  return value<Scan>(db, `select public.scan_parcel($1, 'RETURNED')`, [code])
}

describe('Scanning a partly delivered parcel that comes back', () => {
  it('asks which items came back, with each size, and changes nothing yet', () =>
    inTx(async (db) => {
      const o = await partlyDelivered(db)
      expect(await status(db, o.id)).toBe('PARTIALLY_DELIVERED')
      const before = [await inventory(db, o.m), await inventory(db, o.l)]
      const r = await scan(db, o.tracking)
      expect(r.result).toBe('CHOOSE')
      expect(r.message).toMatch(/choose what came back/)
      expect(r.order?.items?.map((i) => [i.variant_title, i.quantity, i.returned_quantity, i.expected_back]).sort())
        .toEqual([['L', 1, 0, 0], ['M', 1, 0, 0]])
      expect(await status(db, o.id)).toBe('PARTIALLY_DELIVERED')
      expect([await inventory(db, o.m), await inventory(db, o.l)]).toEqual(before)
      await asSystem(db)
      expect(await value<string>(db, `select result from public.parcel_scans where order_id = $1 order by created_at desc limit 1`, [o.id])).toBe('CHOOSE')
    }))

  it('fills in what "Partial delivery…" recorded as sent back', () =>
    inTx(async (db) => {
      const o = await partlyDelivered(db)
      await asUser(db, await createStaff(db, 'OWNER'))
      await db.query(`select public.record_partial_delivery($1, $2, 'Kept the M')`, [o.id, JSON.stringify([{ order_item_id: o.itemL, quantity: 1 }])])
      const r = await scan(db, o.tracking)
      expect(r.result).toBe('CHOOSE')
      const back = Object.fromEntries((r.order?.items ?? []).map((i) => [i.variant_title, i.expected_back]))
      expect(back).toEqual({ L: 1, M: 0 })
    }))

  it('after the L is received from the popup, only the L is back in stock, and scanning again says already received', () =>
    inTx(async (db) => {
      const o = await partlyDelivered(db)
      const before = await inventory(db, o.l)
      const first = await scan(db, o.tracking)
      expect(first.result).toBe('CHOOSE')
      await db.query(`select public.process_order_return($1, $2, 'Received at the scanner')`,
        [o.id, JSON.stringify([{ order_item_id: o.itemL, quantity: 1, condition: 'RESTOCK' }])])
      expect(await status(db, o.id)).toBe('PARTIALLY_DELIVERED')
      expect((await inventory(db, o.l)).on_hand).toBe(before.on_hand + 1)
      const again = await scan(db, o.tracking)
      expect(again.result).toBe('ALREADY')
      expect(again.message).toMatch(/already received/)
      expect(again.order?.items).toBeUndefined()
    }))

  it("finds the order by the courier's return consignment number, but only for its own business", () =>
    inTx(async (db) => {
      const o = await partlyDelivered(db)
      const rc = `RC${Math.floor(Math.random() * 1e9)}`
      await asSystem(db)
      await db.query(`select public.apply_shipment_status($1, 'RETURNING', 'Pathao: return-in-transit', null, null, 'WEBHOOK', $2, $3)`,
        [o.ship, JSON.stringify({ return_type: 'partial', return_consignment_id: rc, collected_amount: 1980 }), `k-${o.ship}-rt`])
      const r = await scan(db, rc.toLowerCase())
      expect(r.result).toBe('CHOOSE')
      expect(r.order?.id).toBe(o.id)
      const other = await createMerchant(db)
      const elsewhere = await scan(db, rc, other)
      expect(elsewhere.result).toBe('NOT_FOUND')
    }))

  it('a fully delivered parcel is still final', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 5 })
      const o = await createOrder(db, { phone: phone(), items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, o.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
      await asSystem(db)
      const courier = await value<string>(db, `select id from public.couriers limit 1`)
      const ship = await value<string>(db, `select id from public.assign_courier($1, $2, $3, 70)`, [o.id, courier, `TRK-${Math.floor(Math.random() * 1e9)}`])
      await db.query(`select public.apply_shipment_status($1, 'PICKED_UP', null, null, null, 'WEBHOOK', null, $2)`, [ship, `k-${ship}-p`])
      await db.query(`select public.apply_shipment_status($1, 'DELIVERED', null, null, null, 'WEBHOOK', null, $2)`, [ship, `k-${ship}-d`])
      const num = await value<string>(db, `select order_number from public.orders where id = $1`, [o.id])
      const r = await scan(db, num)
      expect(r.result).toBe('ERROR')
      expect(r.message).toMatch(/final/)
    }))
})
