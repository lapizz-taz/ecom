import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import { advanceOrder, createOrder, createProduct, createStaff, inventory, placeOrder } from '../support/fixtures'

afterAll(closePool)

interface Batch { updated?: number; approved?: number; failed: Array<{ error: string }> }

async function row(db: Db, id: string) {
  await asSystem(db)
  return one<Record<string, unknown>>(db, `select *, public.order_stage(status, confirmed_at) as stage from public.orders where id = $1`, [id])
}

async function lineId(db: Db, orderId: string, variantId: string) {
  await asSystem(db)
  return value<string>(db, `select id from public.order_items where order_id = $1 and variant_id = $2`, [orderId, variantId])
}

async function financeByCategory(db: Db, orderId: string) {
  await asSystem(db)
  const { rows } = await db.query<{ code: string; total: string }>(`
    select c.code, sum(ft.amount) as total from public.finance_transactions ft
    join public.finance_categories c on c.id = ft.category_id where ft.order_id = $1 group by c.code`, [orderId])
  return Object.fromEntries(rows.map((r) => [r.code, Number(r.total)]))
}

describe('web orders', () => {
  it('records call outcomes, then approval moves the order to Approved Orders', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 500, stock: 10 })
      const order = await placeOrder(db, { phone: '01711000501', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      expect(order.status).toBe('CONFIRMATION_REQUIRED')
      expect(await row(db, order.id)).toMatchObject({ review_status: 'PROCESSING', stage: 'WEB', contact_attempts: 0 })

      const agent = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, agent)
      await db.query(`select public.set_web_order_status($1, 'NO_RESPONSE', 'Rang twice')`, [[order.id]])
      await db.query(`select public.set_web_order_status($1, 'GOOD_NO_RESPONSE')`, [[order.id]])
      await expectError(db, `select public.set_web_order_status($1, 'FOLLOW_UP')`, [[order.id]], /choose when to call back/)
      const later = new Date(Date.now() + 3 * 3600_000).toISOString()
      await db.query(`select public.set_web_order_status($1, 'FOLLOW_UP', 'After 6pm', $2)`, [[order.id], later])
      expect(await row(db, order.id)).toMatchObject({ review_status: 'FOLLOW_UP', contact_attempts: 2, review_note: 'After 6pm' })

      await asUser(db, agent)
      const counts = await value<{ web: Record<string, number> }>(db, `select public.admin_order_queue_counts()`)
      expect(counts.web.FOLLOW_UP).toBeGreaterThanOrEqual(1)

      expect(await value<Batch>(db, `select public.approve_orders($1, 'Confirmed on the phone')`, [[order.id]]))
        .toEqual({ approved: 1, failed: [] })
      expect(await row(db, order.id)).toMatchObject({ status: 'CONFIRMED', stage: 'PENDING', approved_by: agent, follow_up_at: null })

      // Approved orders leave the web queue for good.
      await asUser(db, agent)
      expect((await value<Batch>(db, `select public.set_web_order_status($1, 'NO_RESPONSE')`, [[order.id]])).failed[0].error)
        .toMatch(/already approved/)
      expect((await value<Batch>(db, `select public.approve_orders($1)`, [[order.id]])).failed[0].error).toMatch(/already approved/)
      const approved = await value<{ items: Array<{ id: string; stage: string }> }>(db,
        `select public.admin_search_orders('{"queue": "approved", "stage": "PENDING"}'::jsonb)`)
      expect(approved.items.map((o) => o.id)).toContain(order.id)
      const web = await value<{ items: Array<{ id: string }> }>(db, `select public.admin_search_orders('{"queue": "web"}'::jsonb)`)
      expect(web.items.map((o) => o.id)).not.toContain(order.id)

      await asSystem(db)
      const events = await db.query(`select event from public.order_status_history where order_id = $1 and event = 'REVIEW_STATUS'`, [order.id])
      expect(events.rowCount).toBe(3)
    }))

  it('closes duplicate and invalid orders and gives their stock back', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 400, stock: 5 })
      const variant = p.variantIds[0]
      const order = await placeOrder(db, { phone: '01711000502', items: [{ variantId: variant, quantity: 2 }] })
      expect((await inventory(db, variant)).reserved).toBe(2)

      const packer = await createStaff(db, 'PRODUCTION_MANAGER')
      await asUser(db, packer)
      await expectError(db, `select public.set_web_order_status($1, 'DUPLICATE')`, [[order.id]], /PERMISSION_DENIED|orders.update/)

      const agent = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, agent)
      await db.query(`select public.set_web_order_status($1, 'DUPLICATE', 'Same as the earlier order')`, [[order.id]])
      expect(await row(db, order.id)).toMatchObject({ status: 'CANCELLED', review_status: 'DUPLICATE', stage: 'WEB',
        cancel_reason: 'Duplicate: Same as the earlier order' })
      expect((await inventory(db, variant)).reserved).toBe(0)

      // A closed order only moves between closing statuses and cannot be approved.
      await asUser(db, agent)
      expect((await value<Batch>(db, `select public.set_web_order_status($1, 'NO_RESPONSE')`, [[order.id]])).failed[0].error)
        .toMatch(/this order is cancelled/)
      await db.query(`select public.set_web_order_status($1, 'INVALID')`, [[order.id]])
      expect((await row(db, order.id)).review_status).toBe('INVALID')
      expect((await value<Batch>(db, `select public.approve_orders($1)`, [[order.id]])).failed[0].error).toMatch(/cannot be approved/)

      // Cancellations from anywhere else show up as Cancelled / Invalid.
      const other = await createOrder(db, { phone: '01711000503', items: [{ variantId: variant, quantity: 1 }] })
      await advanceOrder(db, other.id, ['FRAUD_CHECK', 'REJECTED_FRAUD'])
      expect((await row(db, other.id)).review_status).toBe('INVALID')
      await advanceOrder(db, other.id, ['FRAUD_REVIEW'])
      expect((await row(db, other.id)).review_status).toBe('PROCESSING')
      await advanceOrder(db, other.id, ['CANCELLED'])
      expect((await row(db, other.id)).review_status).toBe('CANCELLED')
    }))

  it('lets admins add call statuses without changing how the built-in ones behave', () =>
    inTx(async (db) => {
      const admin = await createStaff(db, 'ADMIN')
      await asUser(db, admin)
      expect(await one(db, `select code, closes_order, is_system from public.admin_save_review_status($1)`,
        [JSON.stringify({ label: 'Wrong number', color: 'danger', closes_order: true })]))
        .toEqual({ code: 'WRONG_NUMBER', closes_order: true, is_system: false })
      expect(await one(db, `select label, closes_order from public.admin_save_review_status($1)`,
        [JSON.stringify({ code: 'NO_RESPONSE', label: 'Not answering', closes_order: true })]))
        .toEqual({ label: 'Not answering', closes_order: false })
      await expectError(db, `select public.admin_save_review_status($1)`,
        [JSON.stringify({ code: 'PROCESSING', label: 'Processing', is_active: false })], /cannot be turned off/)

      const agent = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, agent)
      await expectError(db, `select public.admin_save_review_status($1)`, [JSON.stringify({ label: 'Mine' })], /PERMISSION_DENIED|settings.manage/)
    }))
})

describe('approved order stages', () => {
  it('handles pre-orders and cancellations before and after pickup', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 600, stock: 5 })
      const variant = p.variantIds[0]
      const staff = await createStaff(db, 'ORDER_MANAGER')

      const pre = await createOrder(db, { phone: '01711000510', items: [{ variantId: variant, quantity: 1 }] })
      await advanceOrder(db, pre.id, ['CONFIRMED', 'PRE_ORDER'])
      expect((await row(db, pre.id)).stage).toBe('PRE_ORDER')
      await advanceOrder(db, pre.id, ['READY_TO_SHIP'])
      await asUser(db, staff)
      await expectError(db, `select public.transition_order_status($1, 'PENDING_CANCEL', '')`, [pre.id], /cancellation reason/)
      await db.query(`select public.transition_order_status($1, 'PENDING_CANCEL', 'Customer changed their mind')`, [pre.id])
      // Waiting on the courier: listed under Cancelled (no separate tab), status still PENDING_CANCEL.
      expect(await row(db, pre.id)).toMatchObject({ status: 'PENDING_CANCEL', stage: 'CANCELLED' })
      await asUser(db, staff)
      await db.query(`select public.transition_order_status($1, 'CANCELLED', 'Courier confirmed the cancel')`, [pre.id])
      expect(await row(db, pre.id)).toMatchObject({ status: 'CANCELLED', stage: 'CANCELLED', cancel_reason: 'Customer changed their mind' })
      expect((await inventory(db, variant)).reserved).toBe(0)

      // Once the courier has it, a cancellation means the parcel comes back.
      const shipped = await createOrder(db, { phone: '01711000511', items: [{ variantId: variant, quantity: 1 }] })
      await advanceOrder(db, shipped.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED'])
      expect((await inventory(db, variant)).on_hand).toBe(4)
      await asUser(db, staff)
      await db.query(`select public.transition_order_status($1, 'PENDING_CANCEL', 'Refused on the phone')`, [shipped.id])
      await expectError(db, `select public.transition_order_status($1, 'CANCELLED', 'x')`, [shipped.id], /already picked this parcel up/)
      await db.query(`select public.transition_order_status($1, 'RETURNING')`, [shipped.id])
      expect((await row(db, shipped.id)).stage).toBe('RETURN_PENDING')
      await asUser(db, staff)
      await db.query(`select public.process_order_return($1, null, 'Back from the hub')`, [shipped.id])
      expect((await row(db, shipped.id)).stage).toBe('RETURNED')
      expect((await inventory(db, variant)).on_hand).toBe(5)
    }))

  it('follows the courier when it picks up a parcel whose cancellation is pending', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 600, stock: 5 })
      const variant = p.variantIds[0]
      const o = await createOrder(db, { phone: '01711000512', items: [{ variantId: variant, quantity: 1 }] })
      await advanceOrder(db, o.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
      await asSystem(db)
      const courier = await value<string>(db, `select id from public.couriers limit 1`)
      const ship = await value<string>(db, `select id from public.assign_courier($1, $2, 'TRK-PC1', 70)`, [o.id, courier])
      await advanceOrder(db, o.id, ['PENDING_CANCEL'])
      await asSystem(db)
      await db.query(`select public.apply_shipment_status($1, 'PICKED_UP', null, null, null, 'WEBHOOK', null, 'pc-1')`, [ship])
      const after = await row(db, o.id)
      expect(after.status).toBe('PENDING_CANCEL')
      expect(after.shipped_at).not.toBeNull()
      expect((await inventory(db, variant)).on_hand).toBe(4)
      await asSystem(db)
      await db.query(`select public.apply_shipment_status($1, 'RETURNING', null, null, null, 'WEBHOOK', null, 'pc-2')`, [ship])
      expect((await row(db, o.id)).status).toBe('RETURNING')
    }))

  it('collects only for what the customer kept on a partial delivery', () =>
    inTx(async (db) => {
      const shirt = await createProduct(db, { price: 1000, cost: 400, stock: 5 })
      const socks = await createProduct(db, { price: 300, cost: 100, stock: 5 })
      const o = await createOrder(db, { phone: '01711000520', items: [
        { variantId: shirt.variantIds[0], quantity: 1 }, { variantId: socks.variantIds[0], quantity: 2 }] })
      expect(num(o.total_amount)).toBe(1680)
      await advanceOrder(db, o.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP'])
      await asSystem(db)
      const courier = await value<string>(db, `select id from public.couriers limit 1`)
      const ship = await value<string>(db, `select id from public.assign_courier($1, $2, 'TRK-PD1', 70)`, [o.id, courier])
      await advanceOrder(db, o.id, ['SHIPPED'])
      const shirtLine = await lineId(db, o.id, shirt.variantIds[0])
      const socksLine = await lineId(db, o.id, socks.variantIds[0])

      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      await expectError(db, `select public.transition_order_status($1, 'PARTIALLY_DELIVERED')`, [o.id], /record which items came back/)
      await expectError(db, `select public.record_partial_delivery($1, $2)`,
        [o.id, JSON.stringify([{ order_item_id: shirtLine, quantity: 1 }, { order_item_id: socksLine, quantity: 2 }])], /everything came back/)
      await expectError(db, `select public.record_partial_delivery($1, $2)`,
        [o.id, JSON.stringify([{ order_item_id: shirtLine, quantity: 2 }])], /more items came back/)
      const after = await one<Record<string, string>>(db, `select * from public.record_partial_delivery($1, $2)`,
        [o.id, JSON.stringify([{ order_item_id: shirtLine, quantity: 1 }])])
      expect(after.status).toBe('PARTIALLY_DELIVERED')
      expect(num(after.partial_return_amount)).toBe(1000)
      expect(num(after.cod_amount)).toBe(680)
      await expectError(db, `select public.record_partial_delivery($1, $2)`,
        [o.id, JSON.stringify([{ order_item_id: socksLine, quantity: 1 }])], /already recorded/)
      expect(await financeByCategory(db, o.id)).toMatchObject({ PRODUCT_SALES: 1600, PARTIAL_RETURNS: 1000, COGS: 600 })

      // The courier pays out only what it collected.
      await asUser(db, staff)
      expect(num((await value<{ amount: number }>(db, `select public.record_cod_settlement($1)`, [[ship]])).amount)).toBe(680)
      expect((await row(db, o.id)).payment_status).toBe('PAID')

      // The shirt comes back to the shelf; the order stays Partial.
      await asUser(db, staff)
      await db.query(`select public.process_order_return($1, $2)`, [o.id, JSON.stringify([{ order_item_id: shirtLine, quantity: 1, condition: 'RESTOCK' }])])
      expect((await row(db, o.id)).stage).toBe('PARTIAL')
      expect((await inventory(db, shirt.variantIds[0])).on_hand).toBe(5)
      expect((await financeByCategory(db, o.id)).COGS).toBe(200)
      await asSystem(db)
      expect(await one(db, `select delivered_orders, total_spent::float as total_spent from public.customers where id = $1`, [o.customer_id]))
        .toEqual({ delivered_orders: 1, total_spent: 680 })
    }))

  it('expenses a lost parcel and reverses it when the parcel turns up', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 800, cost: 300, stock: 3 })
      const variant = p.variantIds[0]
      const o = await createOrder(db, { phone: '01711000530', items: [{ variantId: variant, quantity: 2 }] })
      await advanceOrder(db, o.id, ['CONFIRMED', 'PROCESSING', 'READY_TO_SHIP', 'SHIPPED', 'LOST'])
      expect((await row(db, o.id)).stage).toBe('LOST')
      expect((await financeByCategory(db, o.id)).LOST_PARCELS).toBe(600)
      expect((await inventory(db, variant)).on_hand).toBe(1)

      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      await db.query(`select public.process_order_return($1, null, 'Found at the hub')`, [o.id])
      expect((await row(db, o.id)).stage).toBe('RETURNED')
      expect((await financeByCategory(db, o.id)).LOST_PARCELS).toBe(0)
      expect((await inventory(db, variant)).on_hand).toBe(3)
    }))
})

describe('incomplete checkouts and bulk moves', () => {
  it('keeps the ad data when staff turn an incomplete checkout into an order', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 700, stock: 5 })
      await asService(db)
      const lead = await value<string>(db, `select public.capture_checkout_lead($1)`, [JSON.stringify({
        visitor_id: 'visitor-lead-777', phone: '01711000540', items: [{ variant_id: p.variantIds[0], quantity: 1 }], subtotal: 700, total: 780,
        attribution: { visitor_id: 'visitor-lead-777', last_touch: { at: '2026-10-01T10:00:00Z', landing: '/product/x', referrer: null,
          params: { utm_source: 'facebook', utm_medium: 'paid', utm_campaign: 'Belt', ad_id: '55' } } },
      })])
      // Staff typed a different number for the order (customer gave another phone on the call).
      const order = await createOrder(db, { phone: '01811000541', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      expect((await one(db, `select status from public.admin_link_checkout_lead($1, $2)`, [lead, order.id])).status).toBe('CONVERTED')
      await asSystem(db)
      expect(await one(db, `select source, campaign, ad_id from public.order_attributions where order_id = $1`, [order.id]))
        .toEqual({ source: 'Facebook Ads', campaign: 'Belt', ad_id: '55' })
      const other = await createOrder(db, { phone: '01811000542', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asUser(db, staff)
      await expectError(db, `select public.admin_link_checkout_lead($1, $2)`, [lead, other.id], /already became another order/)
    }))

  it('moves approved orders straight to Ready to ship in bulk', () =>
    inTx(async (db) => {
      const p = await createProduct(db, { price: 300, stock: 5 })
      const a = await createOrder(db, { phone: '01711000550', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      const b = await createOrder(db, { phone: '01711000551', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, a.id, ['CONFIRMED'])
      const staff = await createStaff(db, 'ORDER_MANAGER')
      await asUser(db, staff)
      const result = await value<Batch>(db, `select public.bulk_transition_orders($1, 'READY_TO_SHIP')`, [[a.id, b.id]])
      expect(result.updated).toBe(1)
      expect(result.failed[0].error).toMatch(/cannot move from PENDING/)
      expect((await row(db, a.id)).stage).toBe('RTS')
      expect((await row(db, b.id)).status).toBe('PENDING')
    }))
})
