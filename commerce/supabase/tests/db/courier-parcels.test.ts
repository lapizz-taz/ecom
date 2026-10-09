import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff } from '../support/fixtures'

afterAll(closePool)

type Page = { counts: Record<string, number>; total: number; items: Array<Record<string, any>> }

async function parcels(db: Db, user: string, p: Record<string, unknown>) {
  await asUser(db, user)
  return value<Page>(db, `select public.courier_parcels($1)`, [JSON.stringify(p)])
}

describe('courier management parcels', () => {
  it('sorts parcels into tabs and shows the rider the courier reported', () =>
    inTx(async (db) => {
      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asSystem(db)
      const courier = await value<string>(db, `insert into public.couriers(name, provider, api_enabled, default_shipping_cost)
        values ('Pathao ' || substr(md5(random()::text), 1, 6), 'pathao', true, 70) returning id`)
      const p = await createProduct(db, { price: 600, stock: 10 })
      const ready = await createOrder(db, { phone: '01711000101', items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      await advanceOrder(db, ready.id, ['CONFIRMED'])
      const booked = await createOrder(db, { phone: '01711000102', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, booked.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
      await asSystem(db)
      const consignment = 'DLT' + Math.floor(Math.random() * 1e6)
      const ship = await value<string>(db, `select id from public.assign_courier($1, $2, $3, 70, null, $3)`, [booked.id, courier, consignment])
      await db.query(`insert into public.shipment_events(shipment_id, status, description, source, raw, occurred_at)
        values ($1, 'OUT_FOR_DELIVERY', 'Out for delivery', 'WEBHOOK', '{"rider_name":"Karim","rider_phone":"01999000111","reason":"Customer asked to come after 5pm"}', now() + interval '1 minute')`, [ship])

      const before = await parcels(db, staff, { tab: 'all', q: '01711000101' })
      expect(before.items).toHaveLength(1)
      expect(before.items[0]).toMatchObject({ tab: 'pending_entry', shipment: null, item_count: 2 })

      const byConsignment = await parcels(db, staff, { tab: 'assigned', q: consignment })
      expect(byConsignment.total).toBe(1)
      expect(byConsignment.items[0]).toMatchObject({
        order_number: booked.order_number, rider: { name: 'Karim', phone: '01999000111' }, rider_note: 'Customer asked to come after 5pm', attempts: 1,
      })
      expect(byConsignment.items[0].courier.provider).toBe('pathao')
      expect(num(byConsignment.counts.assigned)).toBeGreaterThanOrEqual(1)

      // Back from the courier → Returned tab.
      await asSystem(db)
      await db.query(`update public.shipments set status = 'RETURNED' where id = $1`, [ship])
      expect((await parcels(db, staff, { tab: 'returned', q: consignment })).total).toBe(1)
      expect((await parcels(db, staff, { tab: 'assigned', q: consignment })).total).toBe(0)

      await expectError(db, `select public.courier_parcels('{"tab":"nope"}')`, [], /VALIDATION/)
      await asService(db)
      const viewer = await createStaff(db, 'FINANCE_MANAGER')
      await asUser(db, viewer)
      const can = await value<boolean>(db, `select public.has_permission('couriers.view')`)
      if (!can) await expectError(db, `select public.courier_parcels('{}')`, [], /PERMISSION_DENIED/)
    }))
})
