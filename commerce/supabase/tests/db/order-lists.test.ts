import { afterAll, describe, expect, it } from 'vitest'
import { asAnon, asSystem, asUser, closePool, expectError, inTx, one, value, type Db } from '../support/db'
import { createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

type List = { total: number; items: Array<{ id: string; order_number: string; tags: string[]; lines: Array<{ sku: string; quantity: number }> }> }

async function search(db: Db, filters: Record<string, unknown>): Promise<List> {
  return value<List>(db, `select public.admin_search_orders($1::jsonb, 'created_at', 'desc', 50, 0)`, [JSON.stringify(filters)])
}

describe('order lists: tags and filters', () => {
  it('tags orders, keeps the tag list and filters by tag', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 20 })
      const a = await createOrder(db, { phone: '01711000501', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const b = await createOrder(db, { phone: '01711000502', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const manager = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, manager)
      expect(await value(db, `select public.order_set_tags($1, array['VIP', ' Gift ', 'VIP'])`, [[a.id, b.id]])).toBe(2)
      await db.query(`select public.order_set_tags($1, '{}', array['VIP'])`, [[b.id]])
      const vip = await search(db, { tags: ['VIP'], q: '0171100050' })
      expect(vip.items.map((o) => o.id)).toEqual([a.id])
      expect(vip.items[0].tags).toEqual(['Gift', 'VIP'])
      expect((await search(db, { tags: ['Gift'], q: '0171100050' })).total).toBe(2)
      const options = await value<{ tags: Array<{ name: string }> }>(db, `select public.admin_order_filter_options()`)
      expect(options.tags.map((t) => t.name)).toEqual(expect.arrayContaining(['Gift', 'VIP']))

      // Viewing is not enough to tag.
      await asUser(db, await createStaff(db, 'VIEWER'))
      await expectError(db, `select public.order_set_tags($1, array['X'])`, [[a.id]], /orders.update/)
    }))

  it('filters by product (optionally only that product) and quantity', () =>
    inTx(async (db) => {
      const ring = await createProduct(db, { name: 'Signet Ring', price: 300, stock: 20 })
      const tee = await createProduct(db, { name: 'Plain Tee', price: 400, stock: 20 })
      const onlyRing = await createOrder(db, { phone: '01711000511', items: [{ variantId: ring.variantIds[0], quantity: 3 }] })
      const mixed = await createOrder(db, { phone: '01711000512', items: [{ variantId: ring.variantIds[0], quantity: 1 }, { variantId: tee.variantIds[0], quantity: 1 }] })
      await asUser(db, await createStaff(db, 'ORDER_MANAGER'))
      const ids = async (f: Record<string, unknown>) => (await search(db, { q: '0171100051', ...f })).items.map((o) => o.id).sort()
      expect(await ids({ product_name: 'signet' })).toEqual([onlyRing.id, mixed.id].sort())
      expect(await ids({ product_name: 'signet', only_product: true })).toEqual([onlyRing.id])
      expect(await ids({ qty_min: 3 })).toEqual([onlyRing.id])
      expect(await ids({ qty_max: 2 })).toEqual([mixed.id])
      const listed = await search(db, { q: '01711000512' })
      expect(listed.items[0].lines).toHaveLength(2)
    }))

  it('filters by delivery success rate and keeps the rate away from callers outside staff functions', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 20 })
      const order = await createOrder(db, { phone: '01711000521', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      const check = await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [JSON.stringify({
        phone: '01711000521', provider: 'courier_history', providers: ['courier_history'],
        provider_counts: { total: 10, delivered: 9, returned: 1 }, provider_courier_score: 90,
      })])
      await db.query(`update public.orders set fraud_check_id = $2 where id = $1`, [order.id, check.id])
      await asUser(db, await createStaff(db, 'ORDER_MANAGER'))
      expect((await search(db, { q: '01711000521', success_min: 85 })).total).toBe(1)
      expect((await search(db, { q: '01711000521', success_max: 50 })).total).toBe(0)
      await expectError(db, `select public._order_success_rate($1)`, [check.id], /permission denied/)
      await asAnon(db)
      await expectError(db, `select public.admin_search_orders('{}')`, [], /permission|PERMISSION/)
    }))

  it('gives the edit screen our record and the courier breakdown', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 20 })
      const first = await createOrder(db, { phone: '01711000531', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await createOrder(db, { phone: '01711000531', items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      await asSystem(db)
      await db.query(`select public.record_fraud_check($1)`, [JSON.stringify({
        phone: '01711000531', provider: 'courier_history', providers: ['courier_history'],
        provider_counts: { total: 3, delivered: 2, returned: 1 }, provider_courier_score: 83.34,
        provider_response: { courier_history: { couriers: [{ courier: 'carrybee', name: 'CarryBee', orders: 3, delivered: 2, cancelled: 1, success_ratio: 66.67 }] } },
      })])
      await asUser(db, await createStaff(db, 'ORDER_MANAGER'))
      const record = await value<{ ours: { total: number; in_progress: number }; check: { rate: number; couriers: Array<{ name: string }> } }>(
        db, `select public.admin_order_customer_record($1)`, [first.id])
      expect(record.ours).toMatchObject({ total: 2, in_progress: 2 })
      expect(record.check.rate).toBe(83.34)
      expect(record.check.couriers.map((c) => c.name)).toEqual(['CarryBee'])
    }))
})
