import { afterAll, describe, expect, it } from 'vitest'
import { asSystem, asUser, closePool, expectError, inTx, one, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, setSetting, transition } from '../support/fixtures'

afterAll(closePool)

async function status(db: Db, orderId: string): Promise<string> {
  await asSystem(db)
  return value<string>(db, `select status from public.orders where id = $1`, [orderId])
}

describe('order status transitions', () => {
  it('walks the full pipeline and stamps timestamps', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100, requiresProduction: true })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PRODUCTION', 'QUALITY_CHECK',
        'PACKING', 'READY_TO_SHIP', 'SHIPPED', 'DELIVERED'])
      const o = await one<Record<string, string | null>>(db,
        `select status, confirmed_at, shipped_at, delivered_at from public.orders where id = $1`, [order.id])
      expect(o.status).toBe('DELIVERED')
      expect(o.confirmed_at && o.shipped_at && o.delivered_at).toBeTruthy()
      const n = await value<number>(db, `select count(*)::int from public.order_status_history where order_id = $1 and event = 'STATUS_CHANGED'`, [order.id])
      expect(n).toBe(9)
    }))

  it('rejects invalid transitions', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await expectError(db, `select public._transition_order($1, 'SHIPPED')`, [order.id], /INVALID_TRANSITION.*PENDING to SHIPPED/)
      await expectError(db, `select public._transition_order($1, 'DELIVERED')`, [order.id], /INVALID_TRANSITION/)
      await transition(db, order.id, 'CANCELLED', 'test')
      await expectError(db, `select public._transition_order($1, 'CONFIRMED')`, [order.id], /INVALID_TRANSITION.*CANCELLED/)
    }))

  it('requires permission and a reason to cancel, and logs an audit entry', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const viewer = await createStaff(db, 'VIEWER')
      const manager = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, viewer)
      await expectError(db, `select public.transition_order_status($1, 'CANCELLED', 'x')`, [order.id], /PERMISSION_DENIED/)
      await asUser(db, manager)
      await expectError(db, `select public.transition_order_status($1, 'CANCELLED', '')`, [order.id], /reason is required/)
      await db.query(`select public.transition_order_status($1, 'CANCELLED', 'Duplicate order')`, [order.id])
      await asSystem(db)
      const h = await one<{ actor_id: string; message: string }>(db,
        `select actor_id, message from public.order_status_history where order_id = $1 and to_status = 'CANCELLED'`, [order.id])
      expect(h).toEqual({ actor_id: manager, message: 'Duplicate order' })
      expect(await value(db, `select count(*)::int from public.audit_logs where action = 'order.status_changed' and entity_id = $1`, [order.id])).toBe(1)
    }))

  it('bulk updates report per-order failures without aborting the batch', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100, stock: 10 })
      const a = await createOrder(db, { phone: '01711300001', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const b = await createOrder(db, { phone: '01711300002', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, a.id, ['FRAUD_CHECK', 'CONFIRMED'])
      await asSystem(db)
      const r = await value<{ updated: number; failed: unknown[] }>(db,
        `select public.bulk_transition_orders($1, 'PROCESSING', null)`, [[a.id, b.id]])
      expect(r.updated).toBe(1)
      expect(r.failed).toHaveLength(1)
    }))

  it('blocks edits after shipment', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP', 'SHIPPED'])
      await asSystem(db)
      await expectError(db, `select public.admin_update_order($1, '{"customer_name":"New"}')`, [order.id], /cannot be edited after they ship/)
    }))

  it('lets staff without price permission edit addresses but not prices', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const manager = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, manager)
      await db.query(`select public.admin_update_order($1, '{"shipping_address":"New address 22", "customer_phone":"01822000000"}')`, [order.id])
      await expectError(db, `select public.admin_update_order($1, '{"delivery_charge":0}')`, [order.id], /price_override/)
      await asSystem(db)
      const o = await one<{ shipping_address: string; customer_phone: string; customer_id: string }>(db,
        `select shipping_address, customer_phone, customer_id from public.orders where id = $1`, [order.id])
      expect(o.shipping_address).toBe('New address 22')
      expect(o.customer_phone).toBe('01822000000')
      expect(o.customer_id).not.toBe(order.customer_id)
    }))
})

describe('production pipeline', () => {
  it('queues production items when an order starts processing and syncs the order status', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100, requiresProduction: true })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 2 }] })
      await advanceOrder(db, order.id, ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING'])
      const po = await one<{ id: string; status: string }>(db, `select id, status from public.production_orders where order_id = $1`, [order.id])
      expect(po.status).toBe('WAITING')
      expect(await value(db, `select quantity from public.production_items where production_order_id = $1`, [po.id])).toBe(2)

      const staff = await createStaff(db, 'PRODUCTION_MANAGER')
      await asUser(db, staff)
      const act = (action: string, note: string | null = null) => db.query(`select public.production_action($1, $2, $3)`, [po.id, action, note])
      await act('START')
      expect(await status(db, order.id)).toBe('PRODUCTION')
      await asUser(db, staff)
      await act('SEND_TO_QC')
      expect(await status(db, order.id)).toBe('QUALITY_CHECK')
      await asUser(db, staff)
      await expectError(db, `select public.production_action($1, 'REJECT', null)`, [po.id], /reason is required/)
      await act('REJECT', 'Stitching loose')
      expect(await status(db, order.id)).toBe('PRODUCTION')
      await asUser(db, staff)
      await act('SEND_TO_QC')
      await act('APPROVE')
      await act('MARK_READY')
      expect(await status(db, order.id)).toBe('READY_TO_SHIP')
      expect(await value(db, `select rejection_count from public.production_orders where id = $1`, [po.id])).toBe(1)
      await expectError(db, `select public.production_action($1, 'START')`, [po.id], /INVALID_TRANSITION/)
    }))

  it('skips production for ready-made goods unless configured for all orders', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING'])
      expect(await value(db, `select count(*)::int from public.production_orders where order_id = $1`, [order.id])).toBe(0)
      await setSetting(db, 'production', { auto_create: 'ALL' })
      const order2 = await createOrder(db, { phone: '01711000555', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order2.id, ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING'])
      expect(await value(db, `select count(*)::int from public.production_orders where order_id = $1`, [order2.id])).toBe(1)
    }))

  it('cancels the production card when the order is cancelled', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100, requiresProduction: true })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'CANCELLED'])
      expect(await value(db, `select status from public.production_orders where order_id = $1`, [order.id])).toBe('CANCELLED')
    }))
})

describe('courier shipments', () => {
  it('drives the order from courier status updates and ignores duplicate callbacks', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING'])
      await asSystem(db)
      const courierId = await value<string>(db, `insert into public.couriers(name, provider, tracking_url_template) values ('SF', 'steadfast', 'https://t.example/{tracking}') returning id`)
      const ship = await one<{ id: string; status: string }>(db, `select id, status from public.assign_courier($1, $2, 'TRK99', 70)`, [order.id, courierId])
      expect(ship.status).toBe('BOOKED')
      await db.query(`select public.apply_shipment_status($1, 'PICKED_UP', null, null, null, 'WEBHOOK', null, 'evt-1')`, [ship.id])
      expect(await status(db, order.id)).toBe('SHIPPED')
      await db.query(`select public.apply_shipment_status($1, 'DELIVERED', null, null, null, 'WEBHOOK', null, 'evt-2')`, [ship.id])
      await db.query(`select public.apply_shipment_status($1, 'DELIVERED', null, null, null, 'WEBHOOK', null, 'evt-2')`, [ship.id])
      expect(await status(db, order.id)).toBe('DELIVERED')
      expect(await value(db, `select count(*)::int from public.shipment_events where shipment_id = $1`, [ship.id])).toBe(3)

      const tracked = await value<{ shipment: { tracking_url: string } }>(db, `select public.track_order($1, $2)`, [order.order_number, '01711000001'])
      expect(tracked.shipment.tracking_url).toBe('https://t.example/TRK99')
    }))

  it('marks failed deliveries and waits for staff to receive returned parcels', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 100, stock: 4 })
      const order = await createOrder(db, { items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['FRAUD_CHECK', 'CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP', 'SHIPPED'])
      await asSystem(db)
      const courierId = await value<string>(db, `select id from public.couriers limit 1`)
      const ship = await value<string>(db, `select id from public.assign_courier($1, $2, 'TRK5', 70)`, [order.id, courierId])
      await db.query(`select public.apply_shipment_status($1, 'RETURNED')`, [ship])
      expect(await status(db, order.id)).toBe('FAILED_DELIVERY')
      expect(await value(db, `select on_hand from public.inventory where variant_id = $1`, [p.variantIds[0]])).toBe(3)
    }))
})
