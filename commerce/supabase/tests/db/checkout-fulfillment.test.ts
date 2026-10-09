import { afterAll, describe, expect, it } from 'vitest'
import { asService, asSystem, asUser, closePool, expectError, inTx, num, one, value, type Db } from '../support/db'
import {
  advanceOrder, createOrder, createProduct, createStaff, inventory, orderPayload, placeOrder, setSetting, type OrderInput,
} from '../support/fixtures'

afterAll(closePool)

const POLICY = {
  enabled: true, good_min: 80, mid_min: 50, min_parcels: 1,
  actions: { GOOD: 'COD', MID: 'ADVANCE', LOW: 'ADVANCE', NEW: 'COD', ERROR: 'ADVANCE' },
  advance_type: 'FIXED', advance_amount: 55,
  message: 'Please pay the {amount} delivery charge in advance with bKash or Nagad.',
}

async function enablePolicy(db: Db, overrides: Record<string, unknown> = {}) {
  await asSystem(db)
  await db.query(`update public.settings set value = jsonb_set(value, '{receive_rate}', $1::jsonb) where key = 'fraud'`,
    [JSON.stringify({ ...POLICY, ...overrides })])
}

async function evaluate(db: Db, metrics: Record<string, unknown>, context = { order_value: 1500, delivery_charge: 80, return_charge: 50 }) {
  await asSystem(db)
  return value<{ decision: string; advance_amount: number; advance_type: string; receive_rate_tier: string; customer_message: string | null;
    matched_rules: Array<{ name: string; policy?: string }> }>(
    db, `select public.evaluate_fraud_rules($1, $2)`, [JSON.stringify(metrics), JSON.stringify(context)])
}

/** Places a storefront order the way the checkout function does, returning the raw response. */
async function checkout(db: Db, input: OrderInput, extra: Record<string, unknown> = {}, counts?: Record<string, number>) {
  await asService(db)
  const check = await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [
    JSON.stringify({ phone: input.phone ?? '01711000001', provider: counts ? 'http' : 'internal', provider_counts: counts ?? {} }),
  ])
  const placed = await value<Record<string, unknown> & { id: string; merged: boolean; order_number: string }>(
    db, `select public.place_storefront_order($1, $2)`, [JSON.stringify({ ...orderPayload(input), ...extra }), check.id])
  await asSystem(db)
  return placed
}

async function itemsOf(db: Db, orderId: string) {
  await asSystem(db)
  const r = await db.query<{ variant_id: string; quantity: number }>(
    `select variant_id, quantity from public.order_items where order_id = $1 order by created_at`, [orderId])
  return r.rows
}

async function events(db: Db, orderId: string): Promise<string[]> {
  await asSystem(db)
  const r = await db.query<{ event: string }>(`select event from public.order_status_history where order_id = $1 order by created_at`, [orderId])
  return r.rows.map((x) => x.event)
}

describe('delivery-success (receive rate) policy', () => {
  it('is off by default', () =>
    inTx(async (db) => {
      const r = await evaluate(db, { courier_score: 30, delivered_orders: 3, failed_delivery_orders: 7 })
      expect(r.decision).toBe('ALLOW')
      expect(r.receive_rate_tier).toBe('LOW')
    }))

  it('allows good customers and asks mid/low ones for a fixed ৳55 advance', () =>
    inTx(async (db) => {
      await enablePolicy(db)
      const good = await evaluate(db, { courier_score: 92, delivered_orders: 12, returned_orders: 1 })
      expect(good.decision).toBe('ALLOW')
      expect(good.receive_rate_tier).toBe('GOOD')

      const mid = await evaluate(db, { courier_score: 65, delivered_orders: 13, returned_orders: 7 })
      expect(mid.decision).toBe('ADVANCE_REQUIRED')
      expect(num(mid.advance_amount)).toBe(55)
      expect(mid.advance_type).toBe('FIXED')
      expect(mid.customer_message).toContain('{amount}')
      expect(mid.matched_rules[0]).toMatchObject({ policy: 'receive_rate', name: 'Delivery success Mid (65%)' })

      const low = await evaluate(db, { courier_score: 20, delivered_orders: 2, failed_delivery_orders: 8 })
      expect(low.decision).toBe('ADVANCE_REQUIRED')
      expect(num(low.advance_amount)).toBe(55)
    }))

  it('treats customers without history as new, but not when the lookup failed', () =>
    inTx(async (db) => {
      await enablePolicy(db)
      expect((await evaluate(db, {})).decision).toBe('ALLOW')
      const failed = await evaluate(db, { provider_status: 'ERROR' })
      expect(failed.receive_rate_tier).toBe('ERROR')
      expect(failed.decision).toBe('ADVANCE_REQUIRED')
      // Own history still counts when only the provider failed.
      expect((await evaluate(db, { provider_status: 'ERROR', courier_score: 95, delivered_orders: 20, failed_delivery_orders: 1 })).decision).toBe('ALLOW')
    }))

  it('uses the courier service\'s own rate and counts a "50+" range as history', () =>
    inTx(async (db) => {
      await enablePolicy(db, { min_parcels: 3 })
      await asService(db)
      // BD Courier: CarryBee 2 of 3, Steadfast 100% (rate only, 50+) → their overall 83.34%.
      const both = await one<{ courier_score: string; metrics: { receive_rate_tier: string } }>(db,
        `select courier_score, metrics from public.record_fraud_check($1)`, [JSON.stringify({
          phone: '01711000777', provider: 'courier_history', providers: ['courier_history'],
          provider_counts: { total: 3, delivered: 2, returned: 1 }, provider_courier_score: 83.34, provider_parcel_floor: 53,
        })])
      expect(num(both.courier_score)).toBe(83.34)
      expect(both.metrics.receive_rate_tier).toBe('GOOD')
      // Only Steadfast's rate: not a new customer.
      const rateOnly = await one<{ metrics: { receive_rate_tier: string; parcel_count: number } }>(db,
        `select metrics from public.record_fraud_check($1)`, [JSON.stringify({
          phone: '01711000778', provider: 'courier_history', providers: ['courier_history'],
          provider_counts: { total: 0, delivered: 0, returned: 0 }, provider_courier_score: 100, provider_parcel_floor: 50,
        })])
      expect(rateOnly.metrics).toMatchObject({ receive_rate_tier: 'GOOD', parcel_count: 50 })

      // The order list shows that same rate, the parcels behind it and the reported range.
      const check = await one<{ id: string }>(db, `select id from public.record_fraud_check($1)`, [JSON.stringify({
        phone: '01711000779', provider: 'courier_history', providers: ['courier_history'],
        provider_counts: { total: 3, delivered: 2, returned: 1 }, provider_courier_score: 83.34, provider_parcel_floor: 53,
        provider_response: { courier_history: { verdict: { label: 'Review' }, couriers: [
          { courier: 'carrybee', name: 'CarryBee', orders: 3, delivered: 2, cancelled: 1 },
          { courier: 'steadfast', name: 'SteadFast', orders: 0, rate_only: true, parcel_range: '50+', success_ratio: 100 },
        ] } },
      })])
      const p = await createProduct(db, { price: 500, stock: 5 })
      const order = await createOrder(db, { phone: '01711000779', items: [{ variantId: p.variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`update public.orders set fraud_check_id = $2 where id = $1`, [order.id, check.id])
      await asUser(db, await createStaff(db, 'MANAGER'))
      const list = await value<{ items: Array<{ courier_history: Record<string, unknown> }> }>(db,
        `select public.admin_search_orders('{"q": "01711000779"}'::jsonb)`)
      expect(list.items[0].courier_history).toMatchObject({
        rate: 83.34, tier: 'GOOD', delivered: 2, total: 3, verdict: 'Review', ranges: ['SteadFast 50+'],
      })
    }))

  it('follows the configured actions, thresholds and advance type', () =>
    inTx(async (db) => {
      await enablePolicy(db, { good_min: 90, actions: { GOOD: 'COD', MID: 'ADVANCE', LOW: 'BLOCK', NEW: 'ADVANCE' }, advance_type: 'DELIVERY_CHARGE' })
      const mid = await evaluate(db, { courier_score: 85, delivered_orders: 17, returned_orders: 3 })
      expect(mid.receive_rate_tier).toBe('MID')
      expect(num(mid.advance_amount)).toBe(80) // the delivery charge
      expect((await evaluate(db, { courier_score: 10, delivered_orders: 1, failed_delivery_orders: 9 })).decision).toBe('BLOCK')
      expect((await evaluate(db, {})).decision).toBe('ADVANCE_REQUIRED')
    }))

  it('exposes receive_rate_tier to custom rules', () =>
    inTx(async (db) => {
      await asSystem(db)
      await db.query(`select public.admin_save_fraud_rule($1)`, [JSON.stringify({
        name: 'Low receivers', priority: 1, conditions: [{ field: 'receive_rate_tier', op: 'eq', value: 'LOW' }],
        actions: [{ decision: 'REVIEW' }],
      })])
      expect((await evaluate(db, { courier_score: 10, delivered_orders: 1, failed_delivery_orders: 9 })).decision).toBe('REVIEW')
    }))

  it('drives checkout: good history goes to approval, mid history waits for ৳55', () =>
    inTx(async (db) => {
      await enablePolicy(db)
      const { variantIds } = await createProduct(db, { price: 900 })
      const good = await placeOrder(db, { phone: '01711000101', items: [{ variantId: variantIds[0], quantity: 1 }] },
        { total: 10, delivered: 9, failed: 1 })
      expect(good.status).toBe('CONFIRMATION_REQUIRED')
      expect(num(good.advance_required)).toBe(0)

      const mid = await placeOrder(db, { phone: '01711000102', items: [{ variantId: variantIds[0], quantity: 1 }] },
        { total: 10, delivered: 6, failed: 4 })
      expect(mid.status).toBe('ADVANCE_REQUIRED')
      expect(num(mid.advance_required)).toBe(55)
      expect(mid.requirement).toMatchObject({ mode: 'ADVANCE', amount: 55 })
      expect(String(mid.requirement.message)).toContain('৳55')
      // Customers never see the rate or the tier.
      expect(JSON.stringify(mid.requirement)).not.toMatch(/60|MID|rate/i)
    }))

  it('stores the provider status so a failed lookup is not treated as a new customer', () =>
    inTx(async (db) => {
      await enablePolicy(db)
      await asService(db)
      const check = await one<{ decision: string; metrics: Record<string, unknown> }>(db, `select * from public.record_fraud_check($1)`, [
        JSON.stringify({ phone: '01711000103', provider: 'http', status: 'ERROR', error: 'timeout', provider_counts: {} }),
      ])
      expect(check.metrics.provider_status).toBe('ERROR')
      expect(check.metrics.receive_rate_tier).toBe('ERROR')
      expect(check.decision).toBe('ADVANCE_REQUIRED')
    }))
})

describe('automatic merge of repeat checkouts', () => {
  it('adds a second checkout within the window to the first order (one delivery charge)', () =>
    inTx(async (db) => {
      const a = await createProduct(db, { price: 500 })
      const b = await createProduct(db, { price: 300 })
      const first = await checkout(db, { phone: '01711000201', items: [{ variantId: a.variantIds[0], quantity: 1 }] })
      expect(first.merged).toBe(false)
      const firstOrder = await one<{ delivery_charge: string; total_amount: string }>(db,
        `select delivery_charge, total_amount from public.orders where id = $1`, [first.id])

      const second = await checkout(db, { phone: '01711000201', items: [{ variantId: b.variantIds[0], quantity: 2 }] },
        { idempotency_key: 'retry-key-1', customer_note: 'Please call first' })
      expect(second.merged).toBe(true)
      expect(second.id).toBe(first.id)
      expect(await value(db, `select count(*)::int from public.orders where customer_phone = '01711000201'`)).toBe(1)

      const merged = await one<{ subtotal: string; delivery_charge: string; total_amount: string; merged_count: number; customer_note: string }>(db,
        `select subtotal, delivery_charge, total_amount, merged_count, customer_note from public.orders where id = $1`, [first.id])
      expect(num(merged.subtotal)).toBe(1100)
      expect(num(merged.delivery_charge)).toBe(num(firstOrder.delivery_charge))
      expect(num(merged.total_amount)).toBe(num(firstOrder.total_amount) + 600)
      expect(merged.merged_count).toBe(1)
      expect(merged.customer_note).toContain('Please call first')
      expect(await itemsOf(db, first.id)).toHaveLength(2)
      expect((await inventory(db, b.variantIds[0])).reserved).toBe(2)
      expect(await events(db, first.id)).toContain('ORDER_MERGED')

      // A retry of the second checkout returns the same order without adding items twice.
      const retry = await checkout(db, { phone: '01711000201', items: [{ variantId: b.variantIds[0], quantity: 2 }] }, { idempotency_key: 'retry-key-1' })
      expect(retry.id).toBe(first.id)
      expect(retry.merged).toBe(true)
      expect(await itemsOf(db, first.id)).toHaveLength(2)
      expect(await value(db, `select count(*)::int from public.order_merges where order_id = $1`, [first.id])).toBe(1)
    }))

  it('does not merge after the window, to another address, with a coupon or when switched off', () =>
    inTx(async (db) => {
      // This tests the checkout-time merge on its own; smart-merge.test.ts covers the web-order merge.
      await setSetting(db, 'orders', { auto_merge_web_enabled: false })
      const { variantIds } = await createProduct(db, { price: 500, stock: 50 })
      const item = [{ variantId: variantIds[0], quantity: 1 }]
      const first = await checkout(db, { phone: '01711000202', items: item })

      const otherAddress = await checkout(db, { phone: '01711000202', items: item },
        { shipping: { address: 'Flat 9, Lake Road, Gulshan', district: 'Dhaka' } })
      expect(otherAddress.merged).toBe(false)
      expect(otherAddress.id).not.toBe(first.id)

      await asSystem(db)
      await db.query(`update public.orders set created_at = now() - interval '10 minutes' where id = $1`, [first.id])
      await db.query(`update public.orders set created_at = now() - interval '10 minutes' where id = $1`, [otherAddress.id])
      const late = await checkout(db, { phone: '01711000202', items: item })
      expect(late.merged).toBe(false)

      await setSetting(db, 'orders', { auto_merge_enabled: false })
      const off = await checkout(db, { phone: '01711000202', items: item })
      expect(off.merged).toBe(false)
    }))

  it('never merges into an order that would need a stricter risk decision', () =>
    inTx(async (db) => {
      const { variantIds } = await createProduct(db, { price: 1000, stock: 50 })
      const first = await checkout(db, { phone: '01711000203', items: [{ variantId: variantIds[0], quantity: 1 }] })
      // 1000 + 5×1000 crosses the "new customer, high value" rule (5,000+ → 20% advance).
      const second = await checkout(db, { phone: '01711000203', items: [{ variantId: variantIds[0], quantity: 5 }] })
      expect(second.merged).toBe(false)
      await asSystem(db)
      const order = await one<{ status: string; duplicate_status: string; duplicate_of: string }>(db,
        `select status, duplicate_status, duplicate_of from public.orders where id = $1`, [second.id])
      expect(order.status).toBe('ADVANCE_REQUIRED')
      expect(order.duplicate_status).toBe('SUSPECTED')
      expect(order.duplicate_of).toBe(first.id)
    }))
})

describe('duplicate detection and manual merge', () => {
  it('flags repeats by phone or address and lets staff merge or dismiss', () =>
    inTx(async (db) => {
      await setSetting(db, 'orders', { auto_merge_web_enabled: false })
      const { variantIds } = await createProduct(db, { price: 400, stock: 20 })
      const staff = await createStaff(db, 'ORDER_MANAGER')
      const a = await checkout(db, { phone: '01711000301', items: [{ variantId: variantIds[0], quantity: 1 }] })
      await asSystem(db)
      await db.query(`update public.orders set created_at = now() - interval '1 hour' where id = $1`, [a.id])
      const b = await checkout(db, { phone: '01711000301', items: [{ variantId: variantIds[0], quantity: 2 }] })
      expect(b.merged).toBe(false)
      // Different phone, same address → also flagged.
      const c = await checkout(db, { phone: '01811000302', items: [{ variantId: variantIds[0], quantity: 1 }] })

      await asSystem(db)
      const flagged = await db.query<{ id: string; duplicate_of: string }>(
        `select id, duplicate_of from public.orders where duplicate_status = 'SUSPECTED' order by created_at`)
      expect(flagged.rows.map((r) => r.id).sort()).toEqual([b.id, c.id].sort())
      expect(await events(db, a.id)).toContain('DUPLICATE_SUSPECTED')

      await asUser(db, staff)
      const list = await value<{ total: number; items: Array<{ id: string; duplicate_of_number: string }> }>(db,
        `select public.admin_search_orders('{"duplicates": true}'::jsonb)`)
      expect(list.total).toBe(2)

      const before = (await inventory(db, variantIds[0])).reserved
      await asUser(db, staff)
      const merged = await one<{ id: string; subtotal: string; merged_count: number }>(db, `select * from public.admin_merge_orders($1, $2)`, [b.id, a.id])
      expect(merged.id).toBe(a.id)
      expect(num(merged.subtotal)).toBe(1200)
      expect(merged.merged_count).toBe(1)
      await asSystem(db)
      const source = await one<{ status: string; merged_into: string; duplicate_status: string }>(db,
        `select status, merged_into, duplicate_status from public.orders where id = $1`, [b.id])
      expect(source).toMatchObject({ status: 'CANCELLED', merged_into: a.id, duplicate_status: 'MERGED' })
      expect((await inventory(db, variantIds[0])).reserved).toBe(before)
      expect(await value(db, `select count(*)::int from public.notification_logs
        where order_id = $1 and event = 'ORDER_CANCELLED' and status = 'QUEUED'`, [b.id])).toBe(0)

      await asUser(db, staff)
      await expectError(db, `select public.admin_merge_orders($1, $2)`, [b.id, a.id], /already merged|only orders/)
      const dismissed = await one<{ duplicate_status: string }>(db, `select * from public.admin_dismiss_duplicate($1)`, [c.id])
      expect(dismissed.duplicate_status).toBe('DISMISSED')
      expect(await events(db, c.id)).toContain('DUPLICATE_DISMISSED')
    }))

  it('refuses to merge an order that already has a payment', () =>
    inTx(async (db) => {
      const { variantIds } = await createProduct(db, { price: 400 })
      const staff = await createStaff(db, 'ORDER_MANAGER')
      const a = await createOrder(db, { phone: '01711000310', items: [{ variantId: variantIds[0], quantity: 1 }] })
      const b = await createOrder(db, { phone: '01711000310', items: [{ variantId: variantIds[0], quantity: 1 }] })
      await asService(db)
      await db.query(`select public.submit_manual_payment($1, '01711000310', 'BKASH', '01711000310', 'TRX12345678', 55)`, [b.order_number])
      await asUser(db, staff)
      await expectError(db, `select public.admin_merge_orders($1, $2)`, [b.id, a.id], /has a payment/)
    }))

  it('requires orders.update to merge', () =>
    inTx(async (db) => {
      const { variantIds } = await createProduct(db, { price: 400 })
      const viewer = await createStaff(db, 'VIEWER')
      const a = await createOrder(db, { phone: '01711000320', items: [{ variantId: variantIds[0], quantity: 1 }] })
      const b = await createOrder(db, { phone: '01711000320', items: [{ variantId: variantIds[0], quantity: 1 }] })
      await asUser(db, viewer)
      await expectError(db, `select public.admin_merge_orders($1, $2)`, [b.id, a.id], /orders.update/)
    }))
})

describe('shipping labels', () => {
  it('records first prints and reprints and skips cancelled orders', () =>
    inTx(async (db) => {
      const { variantIds } = await createProduct(db, { price: 400 })
      const packer = await createStaff(db, 'PRODUCTION_MANAGER')
      const a = await createOrder(db, { phone: '01711000401', items: [{ variantId: variantIds[0], quantity: 1 }] })
      const b = await createOrder(db, { phone: '01711000402', items: [{ variantId: variantIds[0], quantity: 1 }] })
      await advanceOrder(db, b.id, ['CANCELLED'])

      await asUser(db, packer)
      const first = await value<{ printed: number; reprinted: number; skipped: unknown[] }>(db,
        `select public.mark_labels_printed($1, '100x150')`, [[a.id, b.id]])
      expect(first).toMatchObject({ printed: 1, reprinted: 0 })
      expect(first.skipped).toHaveLength(1)
      const again = await value<{ printed: number; reprinted: number }>(db, `select public.mark_labels_printed($1)`, [[a.id]])
      expect(again).toMatchObject({ printed: 0, reprinted: 1 })

      await asSystem(db)
      const row = await one<{ label_printed_at: string | null; label_print_count: number; label_printed_by: string }>(db,
        `select label_printed_at, label_print_count, label_printed_by from public.orders where id = $1`, [a.id])
      expect(row.label_printed_at).not.toBeNull()
      expect(row.label_print_count).toBe(2)
      expect(row.label_printed_by).toBe(packer)
      expect(await events(db, a.id)).toEqual(expect.arrayContaining(['LABEL_PRINTED', 'LABEL_REPRINTED']))
      expect(await value(db, `select label_print_count from public.orders where id = $1`, [b.id])).toBe(0)

      await asUser(db, packer)
      const list = await value<{ items: Array<{ id: string; label_printed_at: string | null }> }>(db,
        `select public.admin_search_orders('{"label": "not_printed"}'::jsonb)`)
      expect(list.items.map((i) => i.id)).not.toContain(a.id)
    }))

  it('needs orders.fulfill', () =>
    inTx(async (db) => {
      const { variantIds } = await createProduct(db, { price: 400 })
      const viewer = await createStaff(db, 'VIEWER')
      const a = await createOrder(db, { phone: '01711000403', items: [{ variantId: variantIds[0], quantity: 1 }] })
      await asUser(db, viewer)
      await expectError(db, `select public.mark_labels_printed($1)`, [[a.id]], /orders.fulfill/)
    }))
})

describe('parcel scanning', () => {
  async function scan(db: Db, user: string, code: string, action: string, courierId: string | null = null) {
    await asUser(db, user)
    return value<{ result: string; message: string; order: { id: string; status: string } | null }>(db,
      `select public.scan_parcel($1, $2, $3)`, [code, action, courierId])
  }

  it('moves parcels to ready-to-ship and shipped, and logs every scan', () =>
    inTx(async (db) => {
      const { variantIds } = await createProduct(db, { price: 400 })
      const packer = await createStaff(db, 'ORDER_MANAGER')
      const order = await createOrder(db, { phone: '01711000501', items: [{ variantId: variantIds[0], quantity: 2 }] })
      await advanceOrder(db, order.id, ['CONFIRMED'])
      const courier = await value<string>(db, `select id from public.couriers order by created_at limit 1`)

      const rts = await scan(db, packer, ` ${order.order_number.toLowerCase()} `, 'READY_TO_SHIP')
      expect(rts).toMatchObject({ result: 'OK', message: 'Ready to ship' })
      expect(rts.order?.status).toBe('READY_TO_SHIP')
      expect((await scan(db, packer, order.order_number, 'READY_TO_SHIP')).result).toBe('ALREADY')

      const shipped = await scan(db, packer, order.order_number, 'SHIPPED', courier)
      expect(shipped.result).toBe('OK')
      expect(shipped.order?.status).toBe('SHIPPED')
      await asSystem(db)
      expect(await value(db, `select count(*)::int from public.shipments where order_id = $1 and is_active`, [order.id])).toBe(1)
      expect((await inventory(db, variantIds[0])).reserved).toBe(0) // committed on shipping

      expect((await scan(db, packer, 'NO-SUCH-CODE', 'SHIPPED')).result).toBe('NOT_FOUND')
      await asSystem(db)
      const log = await db.query<{ result: string; to_status: string | null }>(
        `select result, to_status from public.parcel_scans order by created_at`)
      expect(log.rows.map((r) => r.result)).toEqual(['OK', 'ALREADY', 'OK', 'NOT_FOUND'])
      expect(log.rows[0].to_status).toBe('READY_TO_SHIP')
      expect(await events(db, order.id)).toContain('PARCEL_SCANNED')
    }))

  it('finds parcels by courier tracking number and receives returns back into stock', () =>
    inTx(async (db) => {
      const { variantIds } = await createProduct(db, { price: 400, stock: 5 })
      const packer = await createStaff(db, 'ORDER_MANAGER')
      const order = await createOrder(db, { phone: '01711000502', items: [{ variantId: variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['CONFIRMED', 'PROCESSING', 'PACKING', 'READY_TO_SHIP'])
      const courier = await value<string>(db, `select id from public.couriers order by created_at limit 1`)
      await asUser(db, packer)
      await db.query(`select public.assign_courier($1, $2, 'SF778899')`, [order.id, courier])
      expect((await scan(db, packer, 'sf778899', 'SHIPPED')).order?.status).toBe('SHIPPED')
      expect((await inventory(db, variantIds[0])).on_hand).toBe(4)

      const back = await scan(db, packer, 'SF778899', 'RETURNED')
      expect(back).toMatchObject({ result: 'OK', message: 'Returned to stock' })
      expect(back.order?.status).toBe('RETURNED')
      expect((await inventory(db, variantIds[0])).on_hand).toBe(5)
    }))

  it('refuses unconfirmed, cancelled and in-production parcels without changing them', () =>
    inTx(async (db) => {
      const { variantIds } = await createProduct(db, { price: 400 })
      const made = await createProduct(db, { price: 900, trackInventory: false, requiresProduction: true })
      const packer = await createStaff(db, 'ORDER_MANAGER')
      const waiting = await createOrder(db, { phone: '01711000503', items: [{ variantId: variantIds[0], quantity: 1 }] })
      await advanceOrder(db, waiting.id, ['ADVANCE_REQUIRED'])
      const r1 = await scan(db, packer, waiting.order_number, 'SHIPPED')
      expect(r1.result).toBe('ERROR')
      expect(r1.message).toMatch(/not approved/)
      expect(r1.order?.status).toBe('ADVANCE_REQUIRED')

      const cancelled = await createOrder(db, { phone: '01711000504', items: [{ variantId: variantIds[0], quantity: 1 }] })
      await advanceOrder(db, cancelled.id, ['CANCELLED'])
      expect((await scan(db, packer, cancelled.order_number, 'READY_TO_SHIP')).message).toMatch(/cancelled/)

      const custom = await createOrder(db, { phone: '01711000505', items: [{ variantId: made.variantIds[0], quantity: 1 }] })
      await advanceOrder(db, custom.id, ['CONFIRMED'])
      const r3 = await scan(db, packer, custom.order_number, 'READY_TO_SHIP')
      expect(r3.result).toBe('ERROR')
      expect(r3.message).toMatch(/made-to-order/)
      expect(r3.order?.status).toBe('CONFIRMED') // nothing half-done
    }))

  it('can require a printed label before ready-to-ship', () =>
    inTx(async (db) => {
      const { variantIds } = await createProduct(db, { price: 400 })
      const packer = await createStaff(db, 'ORDER_MANAGER')
      const order = await createOrder(db, { phone: '01711000506', items: [{ variantId: variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['CONFIRMED'])
      await setSetting(db, 'fulfillment', { require_label_before_rts: true })
      expect((await scan(db, packer, order.order_number, 'READY_TO_SHIP')).message).toMatch(/print the shipping label/)
      await asUser(db, packer)
      await db.query(`select public.mark_labels_printed($1)`, [[order.id]])
      expect((await scan(db, packer, order.order_number, 'READY_TO_SHIP')).result).toBe('OK')
    }))

  it('needs orders.fulfill and summarises the fulfilment queue', () =>
    inTx(async (db) => {
      const { variantIds } = await createProduct(db, { price: 400 })
      const viewer = await createStaff(db, 'VIEWER')
      const manager = await createStaff(db, 'ORDER_MANAGER')
      const order = await createOrder(db, { phone: '01711000507', items: [{ variantId: variantIds[0], quantity: 1 }] })
      await advanceOrder(db, order.id, ['CONFIRMED'])
      await asUser(db, viewer)
      await expectError(db, `select public.scan_parcel($1, 'SHIPPED')`, [order.order_number], /orders.fulfill/)
      await asUser(db, manager)
      const summary = await value<Record<string, number>>(db, `select public.admin_fulfillment_summary()`)
      expect(summary.to_print).toBe(1)
      expect(summary.ready_to_ship).toBe(0)
    }))
})

describe('courier credentials', () => {
  it('are kept in Vault, readable only by the service role', () =>
    inTx(async (db) => {
      const courier = await value<string>(db, `select id from public.couriers order by created_at limit 1`)
      const owner = await createStaff(db, 'OWNER')
      const creds = { api_key: 'key-abcdef123456', secret_key: 'secret-xyz' }
      await asService(db)
      await db.query(`select public.courier_credentials_store($1, 'steadfast', $2, '••••3456', $3)`, [courier, JSON.stringify(creds), owner])
      expect(await value(db, `select public.courier_credentials_get($1)`, [courier])).toEqual(creds)

      await asSystem(db)
      const row = await one<{ provider: string; api_enabled: boolean; api_status: string; config: Record<string, unknown> }>(db,
        `select provider, api_enabled, api_status, config from public.couriers where id = $1`, [courier])
      expect(row).toMatchObject({ provider: 'steadfast', api_enabled: true, api_status: 'CONNECTED' })
      expect(row.config.credential_hint).toBe('••••3456')
      expect(JSON.stringify(row.config)).not.toContain('secret-xyz')
      expect(await value(db, `select count(*)::int from public.audit_logs where action = 'courier.connected'`)).toBe(1)

      // Even the owner cannot read them through the API.
      await asUser(db, owner)
      await expectError(db, `select * from public.courier_credentials`, [], /permission denied/)
      await expectError(db, `select public.courier_credentials_get($1)`, [courier], /permission denied/)

      // Reconnecting updates the same secret; disconnecting wipes it.
      await asService(db)
      await db.query(`select public.courier_credentials_store($1, 'steadfast', $2, '••••9999', $3)`, [courier, JSON.stringify({ api_key: 'new', secret_key: 'new' }), owner])
      await asSystem(db)
      expect(await value(db, `select count(*)::int from vault.secrets where description = 'Courier API credentials'`)).toBe(1)
      await asService(db)
      await db.query(`select public.courier_credentials_clear($1, $2)`, [courier, owner])
      expect(await value(db, `select public.courier_credentials_get($1)`, [courier])).toBeNull()
      await asSystem(db)
      expect(await value(db, `select api_enabled from public.couriers where id = $1`, [courier])).toBe(false)
    }))

  it('cannot be stored by staff directly', () =>
    inTx(async (db) => {
      const courier = await value<string>(db, `select id from public.couriers order by created_at limit 1`)
      const owner = await createStaff(db, 'OWNER')
      await asUser(db, owner)
      await expectError(db, `select public.courier_credentials_store($1, 'steadfast', '{}'::jsonb, null, $2)`, [courier, owner], /permission denied/)
      await asSystem(db)
      expect(await value(db, `select count(*)::int from vault.secrets where name = $1`, [`courier:${courier}`])).toBe(0)
    }))
})
